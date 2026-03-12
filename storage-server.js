'use strict';
// ═══════════════════════════════════════════════════════════════
// BD-NewsMap Storage Server — port 8080
// This server is what Tor exposes as a .onion hidden service.
// It stores news meta.json + images and serves them.
// The main app (port 3000) syncs to this server after every write.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

// ── Config ────────────────────────────────────────────────────
const PORT         = process.env.STORAGE_PORT || 8080;
// Shared secret between main server and storage server
// Must match STORAGE_SECRET in main server's .env
const SECRET       = process.env.STORAGE_SECRET || 'change-this-secret';
const STORE_DIR    = path.join(__dirname, 'storage_data');
const DB_LINK_FILE = path.join(__dirname, 'db_link.txt');

if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

// ── Auth middleware — HMAC signature on every write ───────────
// Header: X-Storage-Sig: HMAC-SHA256(SECRET, body_or_newsId)
function verifyWrite(req, res, next) {
  const sig = req.headers['x-storage-sig'];
  if (!sig) return res.status(401).json({ error: 'Missing signature' });
  // For multipart (image upload) we sign the newsId
  // For JSON (meta write) we sign the raw body string
  const payload = req.signPayload || '';
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(payload)
    .digest('hex');
  if (sig !== expected) return res.status(403).json({ error: 'Bad signature' });
  next();
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ── CORS — allow main server to call this ─────────────────────
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Storage-Sig');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Serve stored files ────────────────────────────────────────
app.use('/data', express.static(STORE_DIR, { maxAge: '10m' }));

// ── Health check (used by main server to test connectivity) ───
app.get('/health', (req, res) => {
  res.json({ ok: true, items: fs.readdirSync(STORE_DIR).length });
});

// ── Write meta.json ───────────────────────────────────────────
// POST /meta/:id   body: { meta: {...}, sig_payload: id }
app.post('/meta/:id', (req, res) => {
  req.signPayload = req.params.id;
  verifyWrite(req, res, () => {
    const { meta } = req.body;
    if (!meta || !meta.id) return res.status(400).json({ error: 'No meta' });
    const dir = path.join(STORE_DIR, meta.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    res.json({ ok: true });
  });
});

// ── Upload image ──────────────────────────────────────────────
// POST /img/:id    multipart: file + field sig_payload=id
const imgStore = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(STORE_DIR, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

app.post('/img/:id', imgStore.array('images', 10), (req, res) => {
  req.signPayload = req.params.id;
  verifyWrite(req, res, () => {
    const saved = (req.files || []).map(f => `/data/${req.params.id}/${f.filename}`);
    res.json({ ok: true, files: saved });
  });
});

// ── Read meta.json ────────────────────────────────────────────
app.get('/meta/:id', (req, res) => {
  const p = path.join(STORE_DIR, req.params.id, 'meta.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
});

// ── Delete news item ──────────────────────────────────────────
app.delete('/item/:id', (req, res) => {
  req.signPayload = req.params.id;
  verifyWrite(req, res, () => {
    const dir = path.join(STORE_DIR, req.params.id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true });
  });
});

// ── List all IDs (for sync/recovery) ─────────────────────────
app.get('/list', (req, res) => {
  const items = fs.readdirSync(STORE_DIR)
    .filter(f => fs.existsSync(path.join(STORE_DIR, f, 'meta.json')));
  res.json({ items });
});

// ── Boot ──────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Storage] Running on 127.0.0.1:${PORT}`);
  console.log(`[Storage] Data dir: ${STORE_DIR}`);
  // Print onion address if it exists
  if (fs.existsSync(DB_LINK_FILE)) {
    console.log(`[Storage] Onion: ${fs.readFileSync(DB_LINK_FILE,'utf8').trim()}`);
  } else {
    console.log('[Storage] db_link.txt not found — run setup-tor.sh first');
  }
});
