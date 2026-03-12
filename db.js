'use strict';
const initSqlJs = require('sql.js');
const path      = require('path');
const fs        = require('fs');

const DB_FILE = path.join(__dirname, 'newsmap.db');
let _DB = null;

function persistDB() {
  if (!_DB) return;
  const tmp = DB_FILE + '.tmp';
  // Shadow save: write to .tmp then atomically rename
  // If process crashes mid-write, .tmp is corrupt but DB_FILE stays intact
  fs.writeFileSync(tmp, Buffer.from(_DB.export()));
  fs.renameSync(tmp, DB_FILE);
}

function dbGet(sql, p = []) {
  const s = _DB.prepare(sql); s.bind(p);
  const row = s.step() ? s.getAsObject() : null; s.free(); return row;
}

function dbAll(sql, p = []) {
  const rows = [], s = _DB.prepare(sql); s.bind(p);
  while (s.step()) rows.push(s.getAsObject()); s.free(); return rows;
}

function dbRun(sql, p = []) { _DB.run(sql, p); persistDB(); }

async function initDB() {
  const SQL = await initSqlJs();
  _DB = fs.existsSync(DB_FILE)
    ? new SQL.Database(fs.readFileSync(DB_FILE))
    : new SQL.Database();

  _DB.run('PRAGMA foreign_keys = ON;');

  _DB.run(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      trust_score   REAL    NOT NULL DEFAULT 1.0,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS news (
      id          TEXT    PRIMARY KEY,
      owner_id    INTEGER NOT NULL DEFAULT 0,
      title       TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      lat         REAL    NOT NULL,
      lon         REAL    NOT NULL,
      gh_chunk    TEXT,
      gh_sub      TEXT,
      links       TEXT    NOT NULL DEFAULT '',
      image_count INTEGER NOT NULL DEFAULT 0,
      thumb       TEXT    NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS votes (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id  TEXT    NOT NULL,
      user_id  INTEGER NOT NULL,
      type     TEXT    NOT NULL CHECK(type IN ('real','fake')),
      weight   REAL    NOT NULL DEFAULT 1.0,
      voted_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(news_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_news_chunk   ON news(gh_chunk);
    CREATE INDEX IF NOT EXISTS idx_news_sub     ON news(gh_sub);
    CREATE INDEX IF NOT EXISTS idx_news_created ON news(created_at);
    CREATE INDEX IF NOT EXISTS idx_votes_news   ON votes(news_id);
  `);

  // Safe migrations
  const migrations = [
    "ALTER TABLE news ADD COLUMN gh_chunk TEXT",
    "ALTER TABLE news ADD COLUMN gh_sub TEXT",
    "ALTER TABLE news ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE news ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE news ADD COLUMN links TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE votes ADD COLUMN voted_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))",
    "ALTER TABLE news ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE news ADD COLUMN thumb TEXT NOT NULL DEFAULT ''",

  ];
  for (const m of migrations) { try { _DB.run(m); } catch {} }

  persistDB();
  console.log('[DB] Initialized —', DB_FILE);
  return true;
}

module.exports = { initDB, dbGet, dbAll, dbRun, persistDB };
