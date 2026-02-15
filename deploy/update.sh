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

DEPLOY_DIR="/opt/.bot"
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
  sudo -u "$BOT_USER" git reset --hard HEAD
  sudo -u "$BOT_USER" git pull
  chmod +x deploy/*.sh local-agent/scripts/*.sh run-dev.sh install.sh 2>/dev/null || true
  log "Code updated"
else
  warn "No git repo — assuming you rsynced the code already"
fi

# Rebuild
BUILD_LOG=$(mktemp)
trap 'rm -f "$BUILD_LOG"' EXIT

echo "Installing dependencies..."
if sudo -u "$BOT_USER" npm install --production=false >"$BUILD_LOG" 2>&1; then
  tail -3 "$BUILD_LOG"
  log "Dependencies updated"
else
  echo -e "${RED}npm install failed:${NC}"
  tail -30 "$BUILD_LOG"
  err "Dependency install failed — see output above"
fi

echo "Building shared..."
if sudo -u "$BOT_USER" npm run build -w shared >"$BUILD_LOG" 2>&1; then
  log "Shared built"
else
  echo -e "${RED}Shared build failed:${NC}"
  cat "$BUILD_LOG"
  err "Shared build failed — see output above"
fi

echo "Building server..."
if sudo -u "$BOT_USER" npm run build -w server >"$BUILD_LOG" 2>&1; then
  log "Server built"
else
  echo -e "${RED}Server build failed:${NC}"
  cat "$BUILD_LOG"
  err "Server build failed — see output above"
fi

# Restart
echo "Restarting server..."
systemctl restart dotbot
sleep 3

if systemctl is-active --quiet dotbot; then
  log "DotBot server restarted successfully"
  # Show migration output if any
  MIGRATION_LOG=$(journalctl -u dotbot --since "10 seconds ago" --no-pager -o cat 2>/dev/null | grep -i "\[DB\]" || true)
  if [ -n "$MIGRATION_LOG" ]; then
    echo ""
    echo -e "${CYAN}Database migrations:${NC}"
    echo "$MIGRATION_LOG"
  fi
  echo ""
  echo "  Check logs: journalctl -u dotbot -f"
else
  echo -e "${RED}Server failed to start! Recent logs:${NC}"
  journalctl -u dotbot -n 30 --no-pager 2>/dev/null || true
  err "Server failed to start! Check: journalctl -u dotbot -n 50"
fi
