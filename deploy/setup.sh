#!/bin/bash
# ============================================================
# DotBot Server — Linode/Ubuntu Deployment Script
# ============================================================
#
# Usage:
#   1. Spin up a fresh Linode (Ubuntu 22.04+ LTS, 4GB+ RAM)
#   2. SSH in as root
#   3. scp this entire deploy/ folder to the server
#   4. chmod +x setup.sh && ./setup.sh
#
# What this does:
#   - Creates a 'dotbot' system user
#   - Installs Node.js 20, build tools, Caddy
#   - Clones your repo (or you rsync it)
#   - Builds the server
#   - Installs systemd service
#   - Configures Caddy reverse proxy with auto-HTTPS
#   - Sets up firewall (UFW)
#   - Sets up log rotation
#
# Prerequisites:
#   - A domain pointed at this server's IP (for HTTPS)
#   - Your .env file ready with API keys
#
# ============================================================

set -euo pipefail

# ============================================================
# CONFIGURATION — Edit these before running
# ============================================================

DOMAIN="dotbot.yourdomain.com"     # Your domain (must have DNS A record pointing here)
REPO_URL="https://github.com/Druidia-Bot/DotBot.git"                         # Git repo URL (leave empty to rsync manually)
DEPLOY_DIR="/opt/.bot"
BOT_USER="dotbot"
NODE_VERSION="20"

# ============================================================
# Colors
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}═══ $1 ═══${NC}"; }

# ============================================================
# Preflight
# ============================================================

if [ "$(id -u)" -ne 0 ]; then
  err "Run this script as root"
fi

if echo "$DOMAIN" | grep -qi "yourdomain"; then
  warn "Edit the DOMAIN variable at the top of this script to your actual domain."
  err "DOMAIN is still set to a placeholder ('$DOMAIN')."
fi

step "Starting DotBot server deployment"

# ============================================================
# 1. System updates & build tools
# ============================================================

step "1/8 — System updates & build tools"

apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  curl \
  git \
  build-essential \
  python3 \
  ufw \
  logrotate \
  htop

log "System packages installed"

# ============================================================
# 2. Install Node.js 20
# ============================================================

step "2/8 — Installing Node.js ${NODE_VERSION}"

if command -v node &>/dev/null && node -v | grep -q "v${NODE_VERSION}"; then
  log "Node.js $(node -v) already installed"
else
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
  log "Node.js $(node -v) installed"
fi

log "npm $(npm -v)"

# ============================================================
# 3. Install Caddy (reverse proxy + auto-HTTPS)
# ============================================================

step "3/8 — Installing Caddy"

if command -v caddy &>/dev/null; then
  log "Caddy already installed: $(caddy version)"
else
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  log "Caddy installed: $(caddy version)"
fi

# ============================================================
# 4. Create dotbot user & directories
# ============================================================

step "4/8 — Creating dotbot user & directories"

if id "$BOT_USER" &>/dev/null; then
  log "User '$BOT_USER' already exists"
else
  useradd --system --create-home --shell /bin/bash "$BOT_USER"
  log "Created system user '$BOT_USER'"
fi

mkdir -p "$DEPLOY_DIR"
mkdir -p "/home/$BOT_USER/.bot/server-data"
mkdir -p "/home/$BOT_USER/.bot/server-logs"
mkdir -p "/home/$BOT_USER/.bot/personas"
mkdir -p "/home/$BOT_USER/.bot/councils"
mkdir -p "/home/$BOT_USER/.bot/memory"

chown -R "$BOT_USER:$BOT_USER" "$DEPLOY_DIR"
chown -R "$BOT_USER:$BOT_USER" "/home/$BOT_USER/.bot"

log "Directories created"

# ============================================================
# 5. Deploy application code
# ============================================================

step "5/8 — Deploying application code"

if [ -n "$REPO_URL" ]; then
  if [ -d "$DEPLOY_DIR/.git" ]; then
    log "Repo exists, pulling latest..."
    sudo -u "$BOT_USER" git -C "$DEPLOY_DIR" pull
  else
    sudo -u "$BOT_USER" git clone "$REPO_URL" "$DEPLOY_DIR"
    log "Cloned repo"
  fi
else
  if [ ! -f "$DEPLOY_DIR/package.json" ]; then
    warn "No REPO_URL set and no code found at $DEPLOY_DIR"
    warn "You need to copy your code there manually:"
    warn "  rsync -avz --exclude node_modules --exclude .git --exclude dist \\"
    warn "    ./ root@YOUR_SERVER:$DEPLOY_DIR/"
    warn ""
    warn "Then re-run this script."
    exit 1
  fi
  log "Code found at $DEPLOY_DIR"
fi

chown -R "$BOT_USER:$BOT_USER" "$DEPLOY_DIR"

# ============================================================
# 5b. Check for .env file
# ============================================================

if [ ! -f "$DEPLOY_DIR/.env" ]; then
  warn "No .env file found at $DEPLOY_DIR/.env"
  warn "Creating template — you MUST edit this with your API keys!"
  
  cat > "$DEPLOY_DIR/.env" << 'ENVFILE'
# ============================================================
# DotBot Server Environment
# ============================================================

# LLM Provider (pick one)
DEEPSEEK_API_KEY=your_key_here
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# GEMINI_API_KEY=

# Server ports (Caddy proxies these — don't expose directly)
PORT=3000
WS_PORT=3001

# Public URL (used for credential entry page URLs sent to clients)
PUBLIC_URL=https://$DOMAIN

# Premium tools (optional)
# SCRAPING_DOG_API_KEY=

# Database location (default: ~/.bot/server-data/)
# DB_DIR=/home/dotbot/.bot/server-data
ENVFILE

  chown "$BOT_USER:$BOT_USER" "$DEPLOY_DIR/.env"
  chmod 600 "$DEPLOY_DIR/.env"
  warn "Template created at $DEPLOY_DIR/.env — edit it before starting the service!"
fi

# ============================================================
# 6. Build the application
# ============================================================

step "6/8 — Building application"

cd "$DEPLOY_DIR"

BUILD_LOG="$DEPLOY_DIR/build.log"

sudo -u "$BOT_USER" npm install --production=false >> "$BUILD_LOG" 2>&1
if [ $? -ne 0 ]; then
    error "npm install failed. Last 20 lines:"
    tail -20 "$BUILD_LOG"
    exit 1
fi
log "Dependencies installed"

sudo -u "$BOT_USER" npm run build -w shared >> "$BUILD_LOG" 2>&1
if [ $? -ne 0 ]; then
    error "shared/ build failed. Last 20 lines:"
    tail -20 "$BUILD_LOG"
    exit 1
fi
log "Shared package built"

sudo -u "$BOT_USER" npm run build -w server >> "$BUILD_LOG" 2>&1
if [ $? -ne 0 ]; then
    error "server/ build failed. Last 20 lines:"
    tail -20 "$BUILD_LOG"
    exit 1
fi
log "Server built"

# ============================================================
# 7. Configure systemd, Caddy, firewall, logrotate
# ============================================================

step "7/8 — Configuring services"

# Verify build output exists before configuring services
if [ ! -f "$DEPLOY_DIR/server/dist/index.js" ]; then
    error "Build output not found at $DEPLOY_DIR/server/dist/index.js — cannot create service"
    exit 1
fi

# Find node binary (works with NVM, snap, direct install)
NODE_BIN=$(sudo -u "$BOT_USER" bash -c 'command -v node' 2>/dev/null || echo "/usr/bin/node")
if [ ! -x "$NODE_BIN" ]; then
    error "Node binary not found or not executable: $NODE_BIN"
    exit 1
fi
log "Using node at: $NODE_BIN"

# --- systemd service ---

cat > /etc/systemd/system/dotbot.service << EOF
[Unit]
Description=DotBot Server
Documentation=https://github.com/yourusername/dotbot
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=$BOT_USER
Group=$BOT_USER
WorkingDirectory=$DEPLOY_DIR
ExecStart=$NODE_BIN $DEPLOY_DIR/server/dist/index.js
Restart=always
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

# Environment
EnvironmentFile=$DEPLOY_DIR/.env

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/$BOT_USER/.bot
PrivateTmp=true

# Resource limits
LimitNOFILE=65536
MemoryMax=2G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dotbot

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
log "systemd service installed"

# --- Caddy config ---

cat > /etc/caddy/Caddyfile << EOF
$DOMAIN {
    # HTTP API
    handle /api/* {
        reverse_proxy localhost:3000
    }

    # Health check at root
    handle / {
        reverse_proxy localhost:3000
    }

    # Credential entry pages (secure API key input)
    handle /credentials/* {
        reverse_proxy localhost:3000
    }

    # Invite pages (onboarding for new users)
    handle /invite/* {
        reverse_proxy localhost:3000
    }

    # WebSocket connections
    handle /ws {
        reverse_proxy localhost:3001
    }

    # Logging
    log {
        output file /var/log/caddy/dotbot-access.log {
            roll_size 50mb
            roll_keep 5
        }
    }

    # Security headers
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
        -Server
    }
}
EOF

mkdir -p /var/log/caddy

# INSTALL-10: Validate Caddy config before applying
if command -v caddy &>/dev/null; then
  if ! caddy validate --config /etc/caddy/Caddyfile 2>/dev/null; then
    warn "Caddyfile validation failed — check the config at /etc/caddy/Caddyfile"
    warn "Caddy will NOT be restarted. Fix the config and run: systemctl restart caddy"
  else
    log "Caddy config validated for $DOMAIN"
  fi
else
  log "Caddy configured for $DOMAIN (caddy binary not yet available for validation)"
fi

# --- Firewall ---

# INSTALL-11: Add required rules without destroying existing ones
ufw allow ssh 2>/dev/null || true
ufw allow 80/tcp 2>/dev/null || true
ufw allow 443/tcp 2>/dev/null || true
ufw default deny incoming 2>/dev/null || true
ufw default allow outgoing 2>/dev/null || true
ufw --force enable
log "Firewall configured (SSH + HTTP + HTTPS only)"

# --- Log rotation ---

cat > /etc/logrotate.d/dotbot << 'EOF'
/var/log/caddy/dotbot-access.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        systemctl reload caddy
    endscript
}
EOF

log "Log rotation configured"

# ============================================================
# 8. Start services
# ============================================================

step "8/8 — Starting services"

# Check if .env has been configured
if grep -q "your_key_here" "$DEPLOY_DIR/.env"; then
  warn "⚠️  .env still has placeholder keys!"
  warn "Edit $DEPLOY_DIR/.env with your real API keys, then run:"
  warn "  systemctl start dotbot"
  warn "  systemctl start caddy"
else
  systemctl enable dotbot
  systemctl start dotbot
  sleep 5

  if systemctl is-active --quiet dotbot; then
    log "DotBot server is running"
  else
    err "DotBot failed to start. Check: journalctl -u dotbot -n 50"
  fi

  systemctl enable caddy
  systemctl restart caddy
  
  if systemctl is-active --quiet caddy; then
    log "Caddy is running"
  else
    err "Caddy failed to start. Check: journalctl -u caddy -n 50"
  fi
fi

# ============================================================
# Done
# ============================================================

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           DotBot Server Deployed!                     ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Domain:    https://$DOMAIN"
echo "  Health:    https://$DOMAIN/"
echo "  WebSocket: wss://$DOMAIN/ws"
echo ""
echo "  Useful commands:"
echo "    systemctl status dotbot     # Check server status"
echo "    journalctl -u dotbot -f     # Tail server logs"
echo "    systemctl restart dotbot    # Restart server"
echo "    journalctl -u caddy -f     # Tail Caddy logs"
echo ""
echo "  Local agent .env should use:"
echo "    DOTBOT_SERVER=wss://$DOMAIN/ws"
echo ""
