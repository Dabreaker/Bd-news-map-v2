# BD-NewsMap

Hyperlocal news mapping for Bangladesh. Termux-optimized, zero native dependencies.

## Quick Start

```bash
npm install
node server.js
```

Open: http://localhost:3000

## Project Structure

```
bd-newsmap/
├── server.js          Main Express server
├── db.js              sql.js database module
├── .env               Environment variables
├── middleware/
│   ├── auth.js        JWT authentication
│   └── logger.js      Request + file logger
├── routes/            (reserved for route splitting)
├── public/
│   ├── index.html     SPA shell
│   └── js/app.js      Frontend logic
├── news_data/         News images (auto-created)
│   └── <newsId>/
│       └── img_*.jpg
├── logs/              Server logs (auto-created)
│   └── app.log
└── newsmap.db         SQLite via sql.js WASM
```

## Dependencies — all pure JS, no native compilation

| Package      | Purpose               |
|--------------|-----------------------|
| express      | HTTP server           |
| sql.js       | SQLite (WASM)         |
| bcryptjs     | Password hashing      |
| jsonwebtoken | Auth tokens           |
| multer       | File uploads          |
| ngeohash     | Geohash grid          |
| node-cron    | Reaper scheduler      |
