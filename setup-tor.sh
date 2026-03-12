#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════
# BD-NewsMap — Tor Hidden Service Setup
# Run once to configure Tor and get your .onion address
# ═══════════════════════════════════════════════════════════════

set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_LINK="$APP_DIR/db_link.txt"
TOR_DATA="$APP_DIR/tor_data"
TOR_HS="$TOR_DATA/hidden_service"
TOR_CONF="$TOR_DATA/torrc"

echo "=== BD-NewsMap Tor Setup ==="

# 1. Install tor if missing
if ! command -v tor &>/dev/null; then
  echo "[*] Installing tor..."
  pkg install tor -y
fi

# 2. Create tor data directory
mkdir -p "$TOR_DATA"
chmod 700 "$TOR_DATA"

# 3. Write torrc
cat > "$TOR_CONF" << TORRC
DataDirectory $TOR_DATA
HiddenServiceDir $TOR_HS
HiddenServicePort 80 127.0.0.1:8080
SocksPort 9050
Log notice stderr
TORRC

chmod 600 "$TOR_CONF"

echo "[*] Starting Tor to generate hidden service keys..."
echo "[*] This may take 30-60 seconds on first run..."

# 4. Start tor in background to generate keys
tor -f "$TOR_CONF" &
TOR_PID=$!

# 5. Wait for hostname file to appear (max 90s)
TIMEOUT=90
WAITED=0
while [ ! -f "$TOR_HS/hostname" ] && [ $WAITED -lt $TIMEOUT ]; do
  sleep 2
  WAITED=$((WAITED+2))
  echo -n "."
done
echo ""

if [ ! -f "$TOR_HS/hostname" ]; then
  echo "[!] Tor did not generate hostname in time. Check tor logs."
  kill $TOR_PID 2>/dev/null
  exit 1
fi

# 6. Read and save .onion address
ONION=$(cat "$TOR_HS/hostname")
echo "http://$ONION" > "$DB_LINK"

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  Your .onion storage address:          ║"
echo "║  http://$ONION"
echo "║  Saved to db_link.txt                  ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "[*] Tor is running (PID $TOR_PID)"
echo "[*] Now start storage server:  node storage-server.js"
echo "[*] Then start main app:        node server.js"
echo ""
echo "To stop tor: kill $TOR_PID"
echo "To restart tor later: tor -f $TOR_CONF &"
