# বিডি নিউজম্যাপ v6 — Tor Storage Setup

## Architecture
```
Android (Termux)
├── node server.js          ← main app  (port 3000)
├── node storage-server.js  ← storage   (port 8080, localhost only)
├── tor -f tor_data/torrc   ← Tor daemon (exposes 8080 as .onion)
└── db_link.txt             ← your .onion address (auto-generated)
```

## First Time Setup

```bash
cd ~/bd-newsmap-v6
npm install

# Step 1: Install Tor and generate your .onion address
bash setup-tor.sh
# Wait ~60 seconds, it prints your .onion address and saves to db_link.txt

# Step 2: Start storage server (keep running)
node storage-server.js &

# Step 3: Start main app
node server.js
```

## Every Time After That

```bash
cd ~/bd-newsmap-v6
tor -f tor_data/torrc &         # restart tor
node storage-server.js &        # storage backend
node server.js                  # main app
```

## How Storage Works

1. You post a news report → saved locally to `news_data/<id>/`
2. In background → pushed to `.onion` storage via Tor
3. If local file deleted/lost → main app fetches from `.onion` automatically
4. Delete a report → deleted from both local and `.onion`

## Check Tor Status

Visit: http://localhost:3000/api/tor/status

## Your .onion address

Saved in `db_link.txt` after running `setup-tor.sh`.
This address is permanent as long as `tor_data/hidden_service/` folder exists.
**Back up `tor_data/hidden_service/` to keep your address.**

## Security

- Storage server only listens on 127.0.0.1 (not exposed on network directly)
- Only Tor can reach it from outside
- All writes require HMAC-SHA256 signature (set STORAGE_SECRET in .env)
- Images and meta.json are end-to-end protected by Tor encryption

## .env settings

```
PORT=3000
STORAGE_PORT=8080
STORAGE_SECRET=your-random-secret-here
JWT_SECRET=your-jwt-secret-here
```
