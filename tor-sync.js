'use strict';
// ═══════════════════════════════════════════════════════════════
// tor-sync.js — push/pull news data to .onion storage server
//
// Architecture:
//   Main server writes locally first (always works offline)
//   Then async-pushes to storage server via Tor SOCKS5 (127.0.0.1:9050)
//   On news detail read: tries local first, falls back to .onion
//
// Tor SOCKS5 proxy: 127.0.0.1:9050 (started by setup-tor.sh)
// Storage server:   127.0.0.1:8080 (exposed as .onion)
// ═══════════════════════════════════════════════════════════════

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const net    = require('net');
const crypto = require('crypto');

const DB_LINK_FILE = path.join(__dirname, 'db_link.txt');
const SECRET       = process.env.STORAGE_SECRET || 'change-this-secret';
const SOCKS_HOST   = '127.0.0.1';
const SOCKS_PORT   = 9050;
const TIMEOUT_MS   = 15000;

// ── Read .onion base URL from db_link.txt ─────────────────────
function getOnionBase() {
  try {
    const raw = fs.readFileSync(DB_LINK_FILE, 'utf8').trim();
    return raw.replace(/\/$/, ''); // strip trailing slash
  } catch {
    return null;
  }
}

// ── HMAC signature ────────────────────────────────────────────
function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

// ── SOCKS5 connect — returns a net.Socket tunneled through Tor ─
// This lets us reach .onion addresses from Node without native deps
function socks5Connect(targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKS_PORT, SOCKS_HOST);
    socket.setTimeout(TIMEOUT_MS);

    let step = 'greeting';

    socket.once('connect', () => {
      // SOCKS5 greeting: version=5, 1 auth method, no-auth(0)
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    socket.on('data', (chunk) => {
      if (step === 'greeting') {
        // Server responds: version=5, method=0 (no auth)
        if (chunk[0] !== 0x05 || chunk[1] !== 0x00) {
          return reject(new Error('SOCKS5 auth failed'));
        }
        step = 'request';
        // SOCKS5 connect request to target .onion host
        const hostBuf = Buffer.from(targetHost, 'ascii');
        const req = Buffer.alloc(7 + hostBuf.length);
        req[0] = 0x05; // version
        req[1] = 0x01; // CONNECT
        req[2] = 0x00; // reserved
        req[3] = 0x03; // DOMAINNAME
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(targetPort, 5 + hostBuf.length);
        socket.write(req);

      } else if (step === 'request') {
        // Server responds with connection status
        if (chunk[1] !== 0x00) {
          const codes = { 0x01:'general failure', 0x02:'not allowed', 0x03:'net unreachable',
                          0x04:'host unreachable', 0x05:'refused', 0x06:'ttl expired' };
          return reject(new Error('SOCKS5: ' + (codes[chunk[1]] || 'unknown error ' + chunk[1])));
        }
        step = 'connected';
        socket.removeAllListeners('data');
        resolve(socket);
      }
    });

    socket.on('error', reject);
    socket.on('timeout', () => reject(new Error('SOCKS5 timeout')));
  });
}

// ── HTTP request through SOCKS5 ───────────────────────────────
function torRequest(method, onionUrl, options = {}) {
  return new Promise(async (resolve, reject) => {
    let socket;
    try {
      const url  = new URL(onionUrl);
      const host = url.hostname; // e.g. abc123.onion
      const port = url.port ? parseInt(url.port) : 80;
      const path = url.pathname + url.search;

      socket = await socks5Connect(host, port);

      const headers = {
        'Host': host,
        'Connection': 'close',
        ...(options.headers || {}),
      };

      let body = options.body || '';
      if (typeof body === 'object') {
        body = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      } else if (body) {
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      // Build raw HTTP request
      const headerLines = Object.entries(headers)
        .map(([k,v]) => `${k}: ${v}`).join('\r\n');
      const req = `${method} ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`;

      socket.write(req);
      if (body) socket.write(body);

      // Collect response
      let raw = '';
      socket.on('data', d => { raw += d.toString('binary'); });
      socket.on('end', () => {
        const [head, ...bodyParts] = raw.split('\r\n\r\n');
        const statusLine = head.split('\r\n')[0];
        const status = parseInt(statusLine.split(' ')[1]);
        const bodyStr = bodyParts.join('\r\n\r\n');
        resolve({ status, body: bodyStr });
      });
      socket.on('error', reject);
      socket.on('timeout', () => reject(new Error('HTTP timeout')));

    } catch (e) {
      if (socket) socket.destroy();
      reject(e);
    }
  });
}

// ── Multipart form upload through SOCKS5 ─────────────────────
function torUploadImages(onionBase, newsId, files) {
  return new Promise(async (resolve, reject) => {
    if (!files || files.length === 0) return resolve({ ok: true, files: [] });
    let socket;
    try {
      const url    = new URL(`${onionBase}/img/${newsId}`);
      const host   = url.hostname;
      const port   = url.port ? parseInt(url.port) : 80;
      const boundary = '----BDNMBoundary' + Date.now().toString(36);

      // Build multipart body
      const parts = [];
      for (const f of files) {
        const data = fs.readFileSync(f.path || f);
        const fname = path.basename(f.path || f);
        parts.push(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="images"; filename="${fname}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
        );
        parts.push(data);
        parts.push('\r\n');
      }
      parts.push(`--${boundary}--\r\n`);

      const bodyBuffers = parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p, 'binary'));
      const bodyBuffer  = Buffer.concat(bodyBuffers);

      socket = await socks5Connect(host, port);

      const headers = [
        `POST /img/${newsId} HTTP/1.1`,
        `Host: ${host}`,
        `Content-Type: multipart/form-data; boundary=${boundary}`,
        `Content-Length: ${bodyBuffer.length}`,
        `X-Storage-Sig: ${sign(newsId)}`,
        'Connection: close',
        '\r\n',
      ].join('\r\n');

      socket.write(headers);
      socket.write(bodyBuffer);

      let raw = '';
      socket.on('data', d => { raw += d.toString(); });
      socket.on('end', () => {
        try {
          const body = raw.split('\r\n\r\n').slice(1).join('');
          resolve(JSON.parse(body));
        } catch { resolve({ ok: true }); }
      });
      socket.on('error', reject);
    } catch (e) {
      if (socket) socket.destroy();
      reject(e);
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

// Push meta.json to .onion (fire-and-forget, never blocks main flow)
async function pushMeta(meta) {
  const base = getOnionBase();
  if (!base) return;
  try {
    await torRequest('POST', `${base}/meta/${meta.id}`, {
      headers: { 'X-Storage-Sig': sign(meta.id) },
      body: { meta },
    });
    console.log('[TorSync] pushed meta:', meta.id);
  } catch (e) {
    console.warn('[TorSync] pushMeta failed (offline?):', e.message);
  }
}

// Push images to .onion (fire-and-forget)
async function pushImages(newsId, imagePaths) {
  const base = getOnionBase();
  if (!base || !imagePaths.length) return;
  try {
    await torUploadImages(base, newsId, imagePaths);
    console.log('[TorSync] pushed images:', newsId);
  } catch (e) {
    console.warn('[TorSync] pushImages failed:', e.message);
  }
}

// Pull meta.json from .onion (used as fallback when local file missing)
async function pullMeta(newsId) {
  const base = getOnionBase();
  if (!base) return null;
  try {
    const r = await torRequest('GET', `${base}/meta/${newsId}`);
    if (r.status === 200) return JSON.parse(r.body);
  } catch (e) {
    console.warn('[TorSync] pullMeta failed:', e.message);
  }
  return null;
}

// Delete from .onion (called on news delete)
async function deleteRemote(newsId) {
  const base = getOnionBase();
  if (!base) return;
  try {
    await torRequest('DELETE', `${base}/item/${newsId}`, {
      headers: { 'X-Storage-Sig': sign(newsId) },
    });
  } catch (e) {
    console.warn('[TorSync] deleteRemote failed:', e.message);
  }
}

// Test connectivity to .onion storage
async function testConnection() {
  const base = getOnionBase();
  if (!base) return { ok: false, reason: 'db_link.txt not found' };
  try {
    const r = await torRequest('GET', `${base}/health`);
    const data = JSON.parse(r.body);
    return { ok: true, onion: base, items: data.items };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Read .onion address from db_link.txt
function getOnionAddress() {
  return getOnionBase();
}

module.exports = { pushMeta, pushImages, pullMeta, deleteRemote, testConnection, getOnionAddress };
