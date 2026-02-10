#!/bin/bash
# ============================================================
# DotBot Server — Update Script
# ============================================================
#
# Usage: ./update.sh
#
# Pulls latest code, rebuilds, and restarts the server.
# Run this on the Linode after pushing new code.
# ============================================================

set -euo pipefail

DEPLOY_DIR="/opt/dotbot"
BOT_USER="dotbot"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  err "Run as root (or with sudo)"
fi

echo -e "${CYAN}═══ Updating DotBot Server ═══${NC}"

cd "$DEPLOY_DIR"

# Pull latest if git repo
if [ -d ".git" ]; then
  echo "Pulling latest code..."
  sudo -u "$BOT_USER" git pull
  log "Code updated"
else
  warn "No git repo — assuming you rsynced the code already"
fi

# Rebuild
echo "Installing dependencies..."
sudo -u "$BOT_USER" npm install --production=false 2>&1 | tail -3
log "Dependencies updated"

echo "Building shared..."
sudo -u "$BOT_USER" npm run build -w shared 2>&1 | tail -1
log "Shared built"

echo "Building server..."
sudo -u "$BOT_USER" npm run build -w server 2>&1 | tail -1
log "Server built"

# Restart
echo "Restarting server..."
systemctl restart dotbot
sleep 2

if systemctl is-active --quiet dotbot; then
  log "DotBot server restarted successfully"
  echo ""
  echo "  Check logs: journalctl -u dotbot -f"
else
  err "Server failed to start! Check: journalctl -u dotbot -n 50"
fi
