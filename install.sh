#!/bin/bash
# ============================================================
# DotBot Bootstrap Installer — Linux (Server)
# ============================================================
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.sh -o /tmp/install.sh && sed -i 's/\r$//' /tmp/install.sh && bash /tmp/install.sh
#
# Or clone first and run locally:
#   chmod +x install.sh && ./install.sh
#
# What this does:
#   1. Clones the DotBot repo
#   2. Installs Node.js 20, Caddy, build tools
#   3. Prompts for your domain and API keys (all skippable)
#   4. Builds the server
#   5. Configures systemd + Caddy + firewall + log rotation
#   6. Starts the server
#
# ============================================================

set -euo pipefail

# ============================================================
# Constants
# ============================================================

REPO_URL="https://github.com/Druidia-Bot/DotBot.git"
DEPLOY_DIR="/opt/.bot"
BOT_USER="dotbot"
NODE_VERSION="20"
INSTALLER_VERSION="1.0.0"

# ============================================================
# Colors
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}═══ $1 ═══${NC}"; }
ask()  { echo -en "${BOLD}$1${NC}"; }

# ============================================================
# Banner
# ============================================================

echo ""
echo -e "${CYAN}  ╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║                                                   ║${NC}"
echo -e "${CYAN}  ║   🤖  DotBot Server Installer v${INSTALLER_VERSION}              ║${NC}"
echo -e "${CYAN}  ║                                                   ║${NC}"
echo -e "${CYAN}  ║   Your AI assistant, installed in minutes.        ║${NC}"
echo -e "${CYAN}  ║                                                   ║${NC}"
echo -e "${CYAN}  ╚═══════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================================
# Preflight
# ============================================================

if [ "$(id -u)" -ne 0 ]; then
  err "This script must be run as root. Try: sudo bash install.sh"
fi

# Check for supported OS
if [ ! -f /etc/os-release ]; then
  err "Cannot detect OS. This installer supports Ubuntu/Debian."
fi
source /etc/os-release
if [[ "$ID" != "ubuntu" && "$ID" != "debian" && "$ID_LIKE" != *"debian"* ]]; then
  warn "This installer is tested on Ubuntu/Debian. Your OS ($ID) may work but is unsupported."
  read -p "  Continue anyway? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

# ============================================================
# 1. Collect configuration
# ============================================================

step "1/7 — Configuration"

echo ""
echo -e "  ${BOLD}Domain Setup${NC}"
echo "  Your server needs a domain with a DNS A record pointing to this IP."
echo "  Caddy will automatically provision HTTPS certificates."
echo ""
ask "  Enter your domain (e.g. dotbot.example.com): "
read -r DOMAIN
if [ -z "$DOMAIN" ]; then
  DOMAIN="dotbot.yourdomain.com"
  warn "No domain entered — using placeholder '$DOMAIN'"
  warn "You'll need to edit the Caddy config later."
fi
log "Domain: $DOMAIN"

# ============================================================
# 2. System updates & dependencies
# ============================================================

step "2/7 — System updates & dependencies"

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

# Install Node.js
if command -v node &>/dev/null && node -v | grep -q "v${NODE_VERSION}"; then
  log "Node.js $(node -v) already installed"
else
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
  log "Node.js $(node -v) installed"
fi

# Install Caddy
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
# 3. Create user & clone repo
# ============================================================

step "3/7 — Setting up dotbot user & cloning repo"

if id "$BOT_USER" &>/dev/null; then
  log "User '$BOT_USER' already exists"
else
  useradd --system --create-home --shell /bin/bash "$BOT_USER"
  log "Created system user '$BOT_USER'"
fi

mkdir -p "$DEPLOY_DIR"
mkdir -p "/home/$BOT_USER/.bot/server-data"
mkdir -p "/home/$BOT_USER/.bot/server-logs"

if [ -d "$DEPLOY_DIR/.git" ]; then
  log "Repo already cloned, pulling latest..."
  sudo -u "$BOT_USER" git -C "$DEPLOY_DIR" pull
elif [ -n "$REPO_URL" ]; then
  sudo -u "$BOT_USER" git clone "$REPO_URL" "$DEPLOY_DIR"
  log "Cloned repo to $DEPLOY_DIR"
else
  warn "No REPO_URL configured and no existing repo found."
  ask "  Enter Git clone URL: "
  read -r REPO_URL
  if [ -z "$REPO_URL" ]; then
    err "Repository URL is required."
  fi
  git clone "$REPO_URL" "$DEPLOY_DIR"
  log "Cloned repo to $DEPLOY_DIR"
fi

chown -R "$BOT_USER:$BOT_USER" "$DEPLOY_DIR"
chown -R "$BOT_USER:$BOT_USER" "/home/$BOT_USER/.bot"
chmod +x "$DEPLOY_DIR"/deploy/*.sh

# ============================================================
# 4. API Key Setup
# ============================================================

step "4/7 — API Key Setup"

ENV_FILE="$DEPLOY_DIR/.env"

if [ -f "$ENV_FILE" ] && ! grep -q "your_key_here" "$ENV_FILE"; then
  log ".env already configured"
else
  echo ""
  echo -e "  ${YELLOW}┌────────────────────────────────────────────────┐${NC}"
  echo -e "  ${YELLOW}│  API Key Setup                                │${NC}"
  echo -e "  ${YELLOW}│  Press Enter to skip any key you don't have.  │${NC}"
  echo -e "  ${YELLOW}│  You need at least ONE LLM key to start.      │${NC}"
  echo -e "  ${YELLOW}└────────────────────────────────────────────────┘${NC}"
  echo ""

  ENV_CONTENT="# DotBot Server Environment
# Generated by installer on $(date '+%Y-%m-%d %H:%M:%S')

PORT=3000
WS_PORT=3001
"

  KEY_COUNT=0

  # DeepSeek
  echo -e "  ${BOLD}DeepSeek API Key${NC} (workhorse — recommended)"
  echo "    Get one: https://platform.deepseek.com/api_keys"
  ask "    DEEPSEEK_API_KEY: "
  read -r KEY_VAL
  if [ -n "$KEY_VAL" ]; then
    ENV_CONTENT+="DEEPSEEK_API_KEY=$KEY_VAL\n"
    KEY_COUNT=$((KEY_COUNT + 1))
    log "DEEPSEEK_API_KEY set"
  else
    ENV_CONTENT+="# DEEPSEEK_API_KEY=\n"
    echo "    Skipped"
  fi
  echo ""

  # Gemini
  echo -e "  ${BOLD}Google Gemini API Key${NC} (deep context — 1M tokens)"
  echo "    Get one: https://aistudio.google.com/apikey"
  ask "    GEMINI_API_KEY: "
  read -r KEY_VAL
  if [ -n "$KEY_VAL" ]; then
    ENV_CONTENT+="GEMINI_API_KEY=$KEY_VAL\n"
    KEY_COUNT=$((KEY_COUNT + 1))
    log "GEMINI_API_KEY set"
  else
    ENV_CONTENT+="# GEMINI_API_KEY=\n"
    echo "    Skipped"
  fi
  echo ""

  # Anthropic
  echo -e "  ${BOLD}Anthropic API Key${NC} (architect — complex reasoning)"
  echo "    Get one: https://console.anthropic.com/settings/keys"
  ask "    ANTHROPIC_API_KEY: "
  read -r KEY_VAL
  if [ -n "$KEY_VAL" ]; then
    ENV_CONTENT+="ANTHROPIC_API_KEY=$KEY_VAL\n"
    KEY_COUNT=$((KEY_COUNT + 1))
    log "ANTHROPIC_API_KEY set"
  else
    ENV_CONTENT+="# ANTHROPIC_API_KEY=\n"
    echo "    Skipped"
  fi
  echo ""

  # OpenAI
  echo -e "  ${BOLD}OpenAI API Key${NC} (optional fallback)"
  echo "    Get one: https://platform.openai.com/api-keys"
  ask "    OPENAI_API_KEY: "
  read -r KEY_VAL
  if [ -n "$KEY_VAL" ]; then
    ENV_CONTENT+="OPENAI_API_KEY=$KEY_VAL\n"
    KEY_COUNT=$((KEY_COUNT + 1))
    log "OPENAI_API_KEY set"
  else
    ENV_CONTENT+="# OPENAI_API_KEY=\n"
    echo "    Skipped"
  fi
  echo ""

  # ScrapingDog
  echo -e "  ${BOLD}ScrapingDog API Key${NC} (optional — premium web tools)"
  echo "    Get one: https://www.scrapingdog.com/"
  ask "    SCRAPING_DOG_API_KEY: "
  read -r KEY_VAL
  if [ -n "$KEY_VAL" ]; then
    ENV_CONTENT+="SCRAPING_DOG_API_KEY=$KEY_VAL\n"
    KEY_COUNT=$((KEY_COUNT + 1))
    log "SCRAPING_DOG_API_KEY set"
  else
    ENV_CONTENT+="# SCRAPING_DOG_API_KEY=\n"
    echo "    Skipped"
  fi
  echo ""

  echo -e "$ENV_CONTENT" > "$ENV_FILE"
  chown "$BOT_USER:$BOT_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  if [ "$KEY_COUNT" -eq 0 ]; then
    warn "No API keys entered. Edit $ENV_FILE before starting."
  else
    log "$KEY_COUNT API key(s) configured in .env"
  fi
fi

# ============================================================
# 5. Build
# ============================================================

step "5/7 — Building application"

cd "$DEPLOY_DIR"

sudo -u "$BOT_USER" npm install --production=false 2>&1 | tail -1
log "Dependencies installed"

sudo -u "$BOT_USER" npm run build -w shared 2>&1 | tail -1
log "Shared package built"

sudo -u "$BOT_USER" npm run build -w server 2>&1 | tail -1
log "Server built"

# ============================================================
# 6. Configure services
# ============================================================

step "6/7 — Configuring systemd, Caddy, firewall, log rotation"

# --- systemd service ---

cat > /etc/systemd/system/dotbot.service << EOF
[Unit]
Description=DotBot Server
Documentation=https://github.com/Druidia-Bot/DotBot
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=$BOT_USER
Group=$BOT_USER
WorkingDirectory=$DEPLOY_DIR
ExecStart=/usr/bin/node $DEPLOY_DIR/server/dist/index.js
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

    # Credential entry pages
    handle /credentials/* {
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
log "Caddy configured for $DOMAIN"

# --- Firewall ---

ufw --force reset >/dev/null 2>&1
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
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
# 7. Start services
# ============================================================

step "7/7 — Starting services"

if grep -q "your_key_here" "$ENV_FILE" 2>/dev/null || [ "$(grep -c '=.\+' "$ENV_FILE" 2>/dev/null | head -1)" -lt 3 ]; then
  # Check if at least one real API key was set
  HAS_KEY=false
  for KEY_NAME in DEEPSEEK_API_KEY GEMINI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY; do
    if grep -q "^${KEY_NAME}=.\+" "$ENV_FILE" 2>/dev/null; then
      HAS_KEY=true
      break
    fi
  done

  if [ "$HAS_KEY" = false ]; then
    warn ".env has no API keys configured!"
    warn "Edit $ENV_FILE with at least one LLM API key, then run:"
    warn "  systemctl start dotbot"
    warn "  systemctl start caddy"
  else
    systemctl enable dotbot
    systemctl start dotbot
    sleep 2

    if systemctl is-active --quiet dotbot; then
      log "DotBot server is running"
    else
      warn "DotBot may have failed to start. Check: journalctl -u dotbot -n 50"
    fi

    systemctl enable caddy
    systemctl restart caddy

    if systemctl is-active --quiet caddy; then
      log "Caddy is running"
    else
      warn "Caddy may have failed to start. Check: journalctl -u caddy -n 50"
    fi
  fi
else
  systemctl enable dotbot
  systemctl start dotbot
  sleep 2

  if systemctl is-active --quiet dotbot; then
    log "DotBot server is running"
  else
    warn "DotBot may have failed to start. Check: journalctl -u dotbot -n 50"
  fi

  systemctl enable caddy
  systemctl restart caddy

  if systemctl is-active --quiet caddy; then
    log "Caddy is running"
  else
    warn "Caddy may have failed to start. Check: journalctl -u caddy -n 50"
  fi
fi

# ============================================================
# Done
# ============================================================

# Generate an invite token for the first client
echo ""
echo "  Generating invite token..."
INVITE_TOKEN=$(cd "$DEPLOY_DIR" && sudo -u "$BOT_USER" node server/dist/generate-invite.js 2>&1 | grep -oP 'dbot-[A-Za-z0-9-]+' | head -1)

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           DotBot Server Installed!                 ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Domain:    https://$DOMAIN"
echo "  Health:    https://$DOMAIN/"
echo "  WebSocket: wss://$DOMAIN/ws"
echo ""
if [ -n "$INVITE_TOKEN" ]; then
  echo -e "  ${CYAN}🔑 Invite Token: ${YELLOW}${INVITE_TOKEN}${NC}"
  echo ""
  echo "  Use this token when connecting your local agent."
  echo "  It's single-use and expires in 7 days."
else
  echo -e "  ${YELLOW}⚠️  Could not generate invite token automatically.${NC}"
  echo "  Generate one manually:"
  echo "    cd $DEPLOY_DIR && sudo -u $BOT_USER node server/dist/generate-invite.js"
fi
echo ""
echo "  Need more tokens later?"
echo "    cd $DEPLOY_DIR && sudo -u $BOT_USER node server/dist/generate-invite.js"
echo ""
echo "  Useful commands:"
echo "    systemctl status dotbot     # Check server status"
echo "    journalctl -u dotbot -f     # Tail server logs"
echo "    systemctl restart dotbot    # Restart server"
echo "    nano $DEPLOY_DIR/.env       # Edit API keys"
echo ""
echo "  Next: Install the local agent on your Windows machine:"
echo "    irm https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.ps1 | iex"
echo ""
