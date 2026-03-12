'use strict';

// ── .env loader ───────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n').forEach(l => {
      const m = l.match(/^([^#=\s]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
} catch {}

const express  = require('express');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const multer   = require('multer');
const ngeohash = require('ngeohash');
const cron     = require('node-cron');

const { initDB, dbGet, dbAll, dbRun } = require('./db');
const log      = require('./middleware/logger');
const auth     = require('./middleware/auth');
const torSync  = require('./tor-sync');

const PORT        = process.env.PORT       || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || 'bd-newsmap-secret-change-in-prod';
const PROX_KM     = 5;
const DELETE_TTL  = 3  * 3600;
const PURGE_TTL   = 36 * 3600;
const GH_L5       = 5;
const GH_L6       = 6;
const NEWS_DATA   = path.join(__dirname, 'news_data');
const LOGS_DIR    = path.join(__dirname, 'logs');

[NEWS_DATA, LOGS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── GEO ──────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, r = d => d * Math.PI / 180;
  const a = Math.sin(r(lat2-lat1)/2)**2 +
            Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(r(lon2-lon1)/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
// Inverse Distance Weight — IDW
// d=0km → 1.0 | d=1km → 0.84 | d=2.5km → 0.60 | d=5km → 0.20
// Formula: weight = 1.0 - (d / PROX_KM) * 0.8
// Floor at 0.2 (minimum non-zero contribution at boundary)
function voteWeight(d) {
  return Math.max(0.2, 1.0 - (d / PROX_KM) * 0.8);
}
function geohashRing(lat, lon, level, rings) {
  const center = ngeohash.encode(lat, lon, level);
  const set = new Set([center]);
  let front = [center];
  for (let r = 0; r < rings; r++) {
    const next = [];
    for (const c of front) {
      Object.values(ngeohash.neighbors(c)).forEach(n => {
        if (!set.has(n)) { set.add(n); next.push(n); }
      });
    }
    front = next;
  }
  return [...set];
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ── news_data helpers ─────────────────────────────────────────
// Structure: news_data/<id>/meta.json + img_N.ext
function newsDir(id)  { return path.join(NEWS_DATA, id); }
function metaFile(id) { return path.join(NEWS_DATA, id, 'meta.json'); }

function writeMeta(id, data) {
  const d = newsDir(id);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(metaFile(id), JSON.stringify(data, null, 2), 'utf8');
}
function readMeta(id) {
  const p = metaFile(id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function listImages(id) {
  const d = newsDir(id);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
    .sort()
    .map(f => `/news_data/${id}/${f}`);
}
function deleteNewsDir(id) {
  const d = newsDir(id);
  if (fs.existsSync(d)) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

// ── Scores ────────────────────────────────────────────────────
function withScores(rows) {
  return rows.map(n => {
    const vs = dbAll('SELECT type,weight FROM votes WHERE news_id=?', [n.id]);
    let real=0, fake=0;
    for (const v of vs) { if(v.type==='real') real+=+v.weight; else fake+=+v.weight; }
    return { ...n, real_score:+real.toFixed(3), fake_score:+fake.toFixed(3), vote_count:vs.length };
  });
}

// ── Multer ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25*1024*1024, files: 10 },
  fileFilter: (_, f, cb) => cb(null, /^image\/(jpeg|jpg|png|webp|gif)$/.test(f.mimetype)),
});
function saveImages(id, files) {
  const d = newsDir(id);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  const urls = [];
  (files||[]).forEach((f,i) => {
    const ext = (path.extname(f.originalname)||'.jpg').toLowerCase();
    const name = `img_${i}${ext}`;
    fs.writeFileSync(path.join(d, name), f.buffer);
    urls.push(`/news_data/${id}/${name}`);
  });
  return urls;
}

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit:'2mb' }));
app.use(log.middleware);
// HTML + JS: no-store — browser must refetch every time, never serves stale app shell
app.use(express.static(path.join(__dirname,'public'), {
  setHeaders(res, p) {
    if (p.endsWith('.html') || p.endsWith('.js')) {
      res.set('Cache-Control','no-store');
    }
  }
}));
// Images: short TTL (5min), immutable per filename so reloads are cheap
app.use('/news_data', express.static(NEWS_DATA, { maxAge:'5m' }));
// All API routes: never cache
app.use('/api', (_req, res, next) => { res.set('Cache-Control','no-store'); next(); });

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/register', async (req,res) => {
  const { username, password } = req.body||{};
  if (!username || typeof password!=='string' || password.length<6)
    return res.status(400).json({ error:'username + password (min 6) required' });
  const hash = await bcrypt.hash(password, 12);
  try {
    dbRun('INSERT INTO users (username,password_hash) VALUES (?,?)', [username.trim(), hash]);
    const u = dbGet('SELECT id FROM users WHERE username=?', [username.trim()]);
    const token = jwt.sign({ id:u.id, username:username.trim() }, JWT_SECRET, { expiresIn:'30d' });
    log.info('REGISTER', username.trim());
    res.json({ token, username:username.trim() });
  } catch(e) {
    if(e.message.includes('UNIQUE')) return res.status(409).json({ error:'Username taken' });
    res.status(500).json({ error:'Server error' });
  }
});

app.post('/api/login', async (req,res) => {
  const { username, password } = req.body||{};
  if (!username||!password) return res.status(400).json({ error:'username + password required' });
  const u = dbGet('SELECT * FROM users WHERE username=?', [username.trim()]);
  if (!u || !(await bcrypt.compare(password, u.password_hash)))
    return res.status(401).json({ error:'Bad credentials' });
  const token = jwt.sign({ id:u.id, username:u.username }, JWT_SECRET, { expiresIn:'30d' });
  log.info('LOGIN', u.username);
  res.json({ token, username:u.username });
});

// ── Multer error handler ─────────────────────────────────────
function handleUpload(req, res, next) {
  upload.array('images', 10)(req, res, (err) => {
    if (err) {
      log.error('MULTER', err.message);
      return res.status(400).json({ error: 'Upload error: ' + err.message });
    }
    next();
  });
}

// ── CREATE NEWS — 5km wall enforced ──────────────────────────
app.post('/api/news', auth, handleUpload, (req,res) => {
  const { title, description, lat, lon, links, user_lat, user_lon } = req.body;

  if (!title||!lat||!lon)
    return res.status(400).json({ error:'title, lat, lon required' });

  const flat=parseFloat(lat), flon=parseFloat(lon);
  if (isNaN(flat)||isNaN(flon))
    return res.status(400).json({ error:'lat/lon must be numeric' });

  // !! HARD BLOCK: pin must be within 5km of user's GPS
  const ulat=parseFloat(user_lat), ulon=parseFloat(user_lon);
  if (isNaN(ulat)||isNaN(ulon))
    return res.status(400).json({ error:'user_lat and user_lon required — send your GPS position' });

  const pinDist = haversine(ulat, ulon, flat, flon);
  if (pinDist > PROX_KM) {
    log.warn('UPLOAD BLOCKED', `dist=${pinDist.toFixed(2)}km user=${ulat},${ulon} pin=${flat},${flon}`);
    return res.status(403).json({
      error:`Pin is ${pinDist.toFixed(2)} km from your position. Must be within ${PROX_KM} km.`
    });
  }

  const id       = uid();
  const gh_chunk = ngeohash.encode(flat, flon, GH_L5);
  const gh_sub   = ngeohash.encode(flat, flon, GH_L6);
  const now      = Math.floor(Date.now()/1000);
  const newsDir  = path.join(NEWS_DATA, id);

  // ── ATOMIC VERIFY-THEN-COMMIT ─────────────────────────────
  // Haversine already passed above — this is the commit phase.
  // Any failure below triggers rollback: wipe disk + remove DB row.
  function rollback(reason) {
    log.warn('ROLLBACK', id, reason);
    try { if (fs.existsSync(newsDir)) fs.rmSync(newsDir, { recursive:true, force:true }); } catch {}
    try { dbRun('DELETE FROM news WHERE id=?', [id]); } catch {}
  }

  // Step 1: Save images from memory buffer to disk
  let imageUrls = [];
  try {
    imageUrls = saveImages(id, req.files||[]);
  } catch(e) {
    rollback('saveImages: ' + e.message);
    return res.status(500).json({ error:'Failed to save images — upload aborted' });
  }

  // Step 2: Write meta.json — canonical text record for this news item
  const meta = {
    id, owner_id:req.user.id, username:req.user.username,
    title:title.trim(), description:(description||'').trim(),
    lat:flat, lon:flon, gh_chunk, gh_sub,
    links:(links||'').trim(),
    image_count:imageUrls.length, images:imageUrls, created_at:now,
  };
  try {
    writeMeta(id, meta);
  } catch(e) {
    rollback('writeMeta: ' + e.message);
    return res.status(500).json({ error:'Failed to write news record — upload aborted' });
  }

  // Step 3: Index in SQLite — non-fatal, boot-time rebuild recovers if this fails
  try {
    dbRun(
      `INSERT INTO news (id,owner_id,title,description,lat,lon,gh_chunk,gh_sub,links,image_count,thumb,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.user.id, meta.title, meta.description, flat, flon,
       gh_chunk, gh_sub, meta.links, imageUrls.length, imageUrls[0]||"", now]
    );
  } catch(e) { log.error('DB INDEX (non-fatal, will rebuild on boot)', e.message); }

  log.info('NEWS COMMITTED', id, `images=${imageUrls.length}`, `dist=${pinDist.toFixed(2)}km`);
  res.json({ id, gh_chunk, gh_sub, image_count:imageUrls.length });

  // ── Async Tor push — fire-and-forget, never blocks the response ──
  // Images are in memory (multer memoryStorage) — save paths for push
  setImmediate(async () => {
    try {
      await torSync.pushMeta(meta);
      // Push image files from disk (already written in Step 1)
      const imgPaths = imageUrls.map(u => path.join(NEWS_DATA, id, path.basename(u)));
      await torSync.pushImages(id, imgPaths);
    } catch(e) { log.warn('TorSync push failed (non-critical):', e.message); }
  });
});

// ── CHUNK QUERIES (must be before /:id) ──────────────────────
app.get('/api/news/chunks', (req,res) => {
  const raw = (req.query.chunks||'').trim();
  if (!raw) return res.json([]);
  const cells = raw.split(',').map(s=>s.trim()).filter(Boolean).slice(0,30);
  const ph = cells.map(()=>'?').join(',');
  const rows = dbAll(
    `SELECT id,lat,lon,gh_chunk,gh_sub,image_count,thumb,created_at
     FROM news WHERE gh_chunk IN (${ph}) ORDER BY created_at DESC LIMIT 500`,
    cells
  );
  res.json(withScores(rows));
});

app.get('/api/news/subs', (req,res) => {
  const raw = (req.query.subs||'').trim();
  if (!raw) return res.json([]);
  const cells = raw.split(',').map(s=>s.trim()).filter(Boolean).slice(0,120);
  const ph = cells.map(()=>'?').join(',');
  const rows = dbAll(
    `SELECT id,lat,lon,gh_chunk,gh_sub,image_count,thumb,created_at
     FROM news WHERE gh_sub IN (${ph}) ORDER BY created_at DESC LIMIT 500`,
    cells
  );
  res.json(withScores(rows));
});

// ── NEWS DETAIL — local primary → DB fallback → .onion fallback ──
app.get('/api/news/:id', async (req,res) => {
  const { id } = req.params;

  // 1. Local meta.json (fastest)
  let meta = readMeta(id);

  // 2. DB fallback (old rows without meta.json)
  if (!meta) {
    const row = dbGet(
      `SELECT n.*, COALESCE(u.username,'[deleted]') AS username
       FROM news n LEFT JOIN users u ON u.id=n.owner_id WHERE n.id=?`, [id]);
    if (row) {
      const vs = dbAll('SELECT type,weight FROM votes WHERE news_id=?', [id]);
      let real=0, fake=0;
      for(const v of vs) { if(v.type==='real') real+=+v.weight; else fake+=+v.weight; }
      const images = listImages(id);
      return res.json({ ...row, description:row.description||'', links:row.links||'',
        images, image_count:images.length,
        real_score:+real.toFixed(3), fake_score:+fake.toFixed(3), vote_count:vs.length });
    }
  }

  // 3. .onion fallback — fetch from Tor hidden service
  if (!meta) {
    log.info('NEWS DETAIL: trying .onion fallback for', id);
    meta = await torSync.pullMeta(id).catch(() => null);
    if (meta) {
      // Cache locally so we don't need Tor next time
      try { writeMeta(id, meta); } catch {}
    }
  }

  if (!meta) return res.status(404).json({ error: 'সংবাদ পাওয়া যায়নি' });

  const vs = dbAll('SELECT type,weight FROM votes WHERE news_id=?', [id]);
  let real=0, fake=0;
  for(const v of vs) { if(v.type==='real') real+=+v.weight; else fake+=+v.weight; }
  const images = listImages(id);
  res.json({ ...meta, images, image_count:images.length,
    real_score:+real.toFixed(3), fake_score:+fake.toFixed(3), vote_count:vs.length });
});

// ── DELETE (owner, 3h window) ─────────────────────────────────
app.delete('/api/news/:id', auth, (req,res) => {
  const { id } = req.params;
  const meta = readMeta(id);
  const row  = !meta ? dbGet('SELECT owner_id,created_at FROM news WHERE id=?',[id]) : null;
  const ownerId   = meta ? meta.owner_id   : row?.owner_id;
  const createdAt = meta ? meta.created_at : row?.created_at;
  if (!ownerId)               return res.status(404).json({ error:'Not found' });
  if (ownerId!==req.user.id)  return res.status(403).json({ error:'Forbidden' });
  const age = Math.floor(Date.now()/1000) - createdAt;
  if (age > DELETE_TTL)
    return res.status(403).json({ error:`Delete window closed (${Math.floor(age/60)} min old, limit 180 min)` });
  try { dbRun('DELETE FROM news WHERE id=?',[id]); } catch {}
  try { dbRun('DELETE FROM votes WHERE news_id=?',[id]); } catch {}
  deleteNewsDir(id);
  log.info('NEWS DELETED', id, 'by', req.user.username);
  res.json({ deleted:true });
  // Also delete from .onion storage (fire-and-forget)
  setImmediate(() => torSync.deleteRemote(id).catch(() => {}));
});

// ── VOTE ──────────────────────────────────────────────────────
app.post('/api/vote', auth, (req,res) => {
  const { news_id, type, user_lat, user_lon } = req.body||{};
  if (!news_id||!['real','fake'].includes(type))
    return res.status(400).json({ error:'news_id and type required' });
  const ulat=parseFloat(user_lat), ulon=parseFloat(user_lon);
  if (isNaN(ulat)||isNaN(ulon))
    return res.status(400).json({ error:'user_lat and user_lon required' });
  const meta   = readMeta(news_id);
  const coords = meta||dbGet('SELECT lat,lon FROM news WHERE id=?',[news_id]);
  if (!coords) return res.status(404).json({ error:'News not found' });
  const dist = haversine(ulat, ulon, coords.lat, coords.lon);
  if (dist > PROX_KM)
    return res.status(403).json({ error:`Too far: ${dist.toFixed(2)} km (limit ${PROX_KM} km)` });
  const weight = voteWeight(dist);
  const ex = dbGet('SELECT id FROM votes WHERE news_id=? AND user_id=?',[news_id,req.user.id]);
  if (ex) {
    dbRun("UPDATE votes SET type=?,weight=?,voted_at=strftime('%s','now') WHERE news_id=? AND user_id=?",
      [type,weight,news_id,req.user.id]);
  } else {
    dbRun('INSERT INTO votes(news_id,user_id,type,weight) VALUES(?,?,?,?)',
      [news_id,req.user.id,type,weight]);
  }
  log.info('VOTE', type, news_id, `${dist.toFixed(2)}km w=${weight.toFixed(2)}`);
  res.json({ recorded:true, weight:+weight.toFixed(3), dist:+dist.toFixed(3) });
});

// ── FEED ──────────────────────────────────────────────────────
app.get('/api/feed', (req,res) => {
  const flat=parseFloat(req.query.lat), flon=parseFloat(req.query.lon);
  if (isNaN(flat)||isNaN(flon)) return res.status(400).json({ error:'lat/lon required' });
  const cutoff = Math.floor(Date.now()/1000) - PURGE_TTL;
  const cells  = geohashRing(flat, flon, GH_L5, 1);
  const ph     = cells.map(()=>'?').join(',');
  const rows   = dbAll(
    `SELECT id,title,lat,lon,image_count,created_at FROM news
     WHERE gh_chunk IN (${ph}) AND created_at>? ORDER BY created_at DESC LIMIT 60`,
    [...cells,cutoff]
  );
  const scored = withScores(rows);
  scored.sort((a,b)=>(b.real_score-b.fake_score)-(a.real_score-a.fake_score));
  res.json(scored.slice(0,20));
});

// ── REAPER ────────────────────────────────────────────────────
cron.schedule('*/15 * * * *', () => {
  const cutoff = Math.floor(Date.now()/1000) - PURGE_TTL;
  const stale  = dbAll('SELECT id FROM news WHERE created_at<?',[cutoff]);
  if (!stale.length) return;
  for (const {id} of stale) {
    try { dbRun('DELETE FROM votes WHERE news_id=?',[id]); } catch {}
    try { dbRun('DELETE FROM news WHERE id=?',[id]); } catch {}
    deleteNewsDir(id);
  }
  log.info(`REAPER purged ${stale.length} expired items`);
});

// ── TOR STATUS ────────────────────────────────────────────────
app.get('/api/tor/status', async (req, res) => {
  const onion = torSync.getOnionAddress();
  if (!onion) return res.json({ enabled: false, reason: 'db_link.txt not found — run setup-tor.sh' });
  const result = await torSync.testConnection();
  res.json({ enabled: true, onion, ...result });
});

// ── BOOT ──────────────────────────────────────────────────────
initDB().then(() => {
  // Rebuild DB index from meta.json if DB was wiped
  let rebuilt = 0;
  if (fs.existsSync(NEWS_DATA)) {
    for (const id of fs.readdirSync(NEWS_DATA)) {
      const meta = readMeta(id);
      if (!meta) continue;
      const exists = dbGet('SELECT id FROM news WHERE id=?',[meta.id]);
      if (!exists) {
        try {
          dbRun(
            `INSERT INTO news (id,owner_id,title,description,lat,lon,gh_chunk,gh_sub,links,image_count,thumb,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [meta.id,meta.owner_id,meta.title,meta.description||'',
             meta.lat,meta.lon,meta.gh_chunk,meta.gh_sub,
             meta.links||'',meta.image_count||0,(meta.images||[])[0]||'',meta.created_at]
          );
          rebuilt++;
        } catch(e) { log.error('REBUILD',id,e.message); }
      }
    }
  }
  if (rebuilt) log.info(`Boot: rebuilt ${rebuilt} news DB entries from disk`);

  app.listen(PORT, () => {
    log.info(`BD-NewsMap → http://localhost:${PORT}`);
    log.info(`news_data dir → ${NEWS_DATA}`);
  });
}).catch(e => { console.error('FATAL:', e); process.exit(1); });
