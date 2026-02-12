#!/bin/bash
# ============================================================
# DotBot Bootstrap Installer — Linux (Server)
# ============================================================
#
# One-liner install (curl):
#   curl -fsSL https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.sh | sudo bash
#
# Or with wget:
#   wget -qO- https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.sh | sudo bash
#
# Or download first and run locally:
#   curl -fsSL https://raw.githubusercontent.com/Druidia-Bot/DotBot/main/install.sh -o install.sh
#   chmod +x install.sh && sudo ./install.sh
#
# What this does:
#   1. Runs pre-flight checks (disk space, internet, DNS)
#   2. Installs Node.js 20, Caddy, build tools
#   3. Clones the DotBot repo with retry logic
#   4. Prompts for your domain and API keys (all skippable)
#   5. Builds the server with automatic retries
#   6. Configures systemd + Caddy + firewall + log rotation
#   7. Verifies HTTPS certificate provisioning
#   8. Starts the server and generates invite token
#
# ============================================================

set -euo pipefail

# ============================================================
# Constants
# ============================================================

REPO_URL="https://github.com/Druidia-Bot/DotBot.git"
DEPLOY_DIR="${DOTBOT_DEPLOY_DIR:-/opt/.bot}"
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
# PREFLIGHT CHECKS
# ============================================================

step "Preflight Checks"

# Check disk space (need 2GB free)
AVAILABLE_GB=$(df -BG / | awk 'NR==2 {print $4}' | sed 's/G//')
if [ "$AVAILABLE_GB" -lt 2 ]; then
  err "Insufficient disk space: ${AVAILABLE_GB}GB free (need 2GB+)"
fi
log "Disk space: ${AVAILABLE_GB}GB available"

# Check internet connectivity
if ! ping -c 1 -W 5 8.8.8.8 &>/dev/null && ! ping -c 1 -W 5 1.1.1.1 &>/dev/null; then
  err "No internet connection detected. Check network settings."
fi
log "Internet connectivity verified"

# Check required commands
for cmd in curl git systemctl; do
  if ! command -v $cmd &>/dev/null; then
    err "Required command not found: $cmd"
  fi
done
log "Required commands available"

# ============================================================
# RETRY WRAPPER FOR NETWORK OPERATIONS
# ============================================================

retry_command() {
  local max_attempts="${1}"
  local delay="${2}"
  local description="${3}"
  shift 3
  local cmd=("$@")
  local attempt=1

  while [ $attempt -le $max_attempts ]; do
    if "${cmd[@]}"; then
      return 0
    else
      if [ $attempt -lt $max_attempts ]; then
        warn "$description failed (attempt $attempt/$max_attempts)"
        echo "  Retrying in ${delay}s..."
        sleep "$delay"
        attempt=$((attempt + 1))
      else
        err "$description failed after $max_attempts attempts"
      fi
    fi
  done
  return 1
}

# ============================================================
# 1. Collect configuration
# ============================================================

step "1/7 — Configuration"

echo ""
echo -e "  ${BOLD}Domain Setup${NC}"
echo "  Your server needs a domain with a DNS A record pointing to this IP."
echo "  Caddy will automatically provision HTTPS certificates."
echo ""

# Get server's public IP
SERVER_IP=$(curl -s -m 5 ifconfig.me || curl -s -m 5 icanhazip.com || echo "unknown")
if [ "$SERVER_IP" != "unknown" ]; then
  echo "  This server's public IP: ${SERVER_IP}"
  echo ""
fi

ask "  Enter your domain (e.g. dotbot.example.com): "
read -r DOMAIN
if [ -z "$DOMAIN" ]; then
  warn "Example: dotbot.example.com"
  err "No domain entered. A valid domain is required for HTTPS."
fi
if echo "$DOMAIN" | grep -qi "yourdomain"; then
  warn "Enter your actual domain (e.g. dotbot.example.com)"
  err "Domain '$DOMAIN' looks like a placeholder."
fi

# Validate domain format
if ! echo "$DOMAIN" | grep -qE '^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'; then
  err "Invalid domain format: $DOMAIN"
fi

log "Domain: $DOMAIN"

# Check DNS propagation
echo ""
echo "  Checking DNS records for $DOMAIN..."
RESOLVED_IP=$(dig +short "$DOMAIN" A | tail -n1)

if [ -z "$RESOLVED_IP" ]; then
  warn "DNS record not found for $DOMAIN"
  echo ""
  echo -e "  ${YELLOW}IMPORTANT: DNS Setup Required${NC}"
  echo "  Create an A record for $DOMAIN pointing to: ${SERVER_IP}"
  echo ""
  echo "  DNS changes can take 5-60 minutes to propagate."
  echo "  Caddy HTTPS certificate provisioning will FAIL until DNS is correct."
  echo ""
  read -p "  Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
  warn "Proceeding without DNS — HTTPS will fail until you configure DNS"
elif [ "$RESOLVED_IP" != "$SERVER_IP" ] && [ "$SERVER_IP" != "unknown" ]; then
  warn "DNS mismatch: $DOMAIN resolves to $RESOLVED_IP (expected: $SERVER_IP)"
  echo ""
  echo "  Your DNS A record points to the wrong IP."
  echo "  Update it to: $SERVER_IP"
  echo ""
  read -p "  Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
  warn "Proceeding with DNS mismatch — HTTPS may fail"
else
  log "DNS verified: $DOMAIN → $RESOLVED_IP"
fi

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
  retry_command 3 10 "git pull" sudo -u "$BOT_USER" git -C "$DEPLOY_DIR" pull
elif [ -n "$REPO_URL" ]; then
  retry_command 3 10 "git clone" sudo -u "$BOT_USER" git clone "$REPO_URL" "$DEPLOY_DIR"
  if [ $? -ne 0 ]; then
    err "Failed to clone repository after 3 attempts. Check network and URL."
  fi
  log "Cloned repo to $DEPLOY_DIR"
else
  warn "No REPO_URL configured and no existing repo found."
  ask "  Enter Git clone URL: "
  read -r REPO_URL
  if [ -z "$REPO_URL" ]; then
    err "Repository URL is required."
  fi
  retry_command 3 10 "git clone" git clone "$REPO_URL" "$DEPLOY_DIR"
  if [ $? -ne 0 ]; then
    err "Failed to clone repository after 3 attempts. Check network and URL."
  fi
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

  # xAI
  echo -e "  ${BOLD}xAI API Key${NC} (optional — oracle persona, market sentiment)"
  echo "    Get one: https://console.x.ai/"
  ask "    XAI_API_KEY: "
  read -r KEY_VAL
  if [ -n "$KEY_VAL" ]; then
    ENV_CONTENT+="XAI_API_KEY=$KEY_VAL\n"
    KEY_COUNT=$((KEY_COUNT + 1))
    log "XAI_API_KEY set"
  else
    ENV_CONTENT+="# XAI_API_KEY=\n"
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

BUILD_LOG="$DEPLOY_DIR/build.log"

# npm install with retry logic
retry_command 3 10 "npm install" sudo -u "$BOT_USER" npm install --production=false >> "$BUILD_LOG" 2>&1
if [ $? -ne 0 ]; then
    err "npm install failed after 3 attempts. Last 20 lines:"
    tail -20 "$BUILD_LOG"
    echo ""
    echo -e "${YELLOW}Possible causes:${NC}"
    echo "  • Network/proxy blocking npm registry"
    echo "  • Insufficient disk space"
    echo "  • Node.js version incompatible"
    echo ""
    echo -e "${YELLOW}Manual recovery:${NC}"
    echo "  cd $DEPLOY_DIR && sudo -u $BOT_USER npm install"
    exit 1
fi
log "Dependencies installed"

# Build shared package
if ! sudo -u "$BOT_USER" npm run build -w shared >> "$BUILD_LOG" 2>&1; then
    err "shared/ build failed. Last 20 lines:"
    tail -20 "$BUILD_LOG"
    echo ""
    echo -e "${YELLOW}Manual recovery:${NC}"
    echo "  cd $DEPLOY_DIR/shared && sudo -u $BOT_USER npm run build"
    exit 1
fi
log "Shared package built"

# Build server package
if ! sudo -u "$BOT_USER" npm run build -w server >> "$BUILD_LOG" 2>&1; then
    err "server/ build failed. Last 20 lines:"
    tail -20 "$BUILD_LOG"
    echo ""
    echo -e "${YELLOW}Manual recovery:${NC}"
    echo "  cd $DEPLOY_DIR/server && sudo -u $BOT_USER npm run build"
    exit 1
fi
log "Server built"

# ============================================================
# 6. Configure services
# ============================================================

step "6/7 — Configuring systemd, Caddy, firewall, log rotation"

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
Documentation=https://github.com/Druidia-Bot/DotBot
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

# Add required rules without destroying existing ones
ufw allow ssh 2>/dev/null || true
ufw allow 80/tcp 2>/dev/null || true
ufw allow 443/tcp 2>/dev/null || true
ufw default deny incoming 2>/dev/null || true
ufw default allow outgoing 2>/dev/null || true
ufw --force enable 2>/dev/null || true
log "Firewall rules added (SSH + HTTP + HTTPS)"

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
    sleep 5

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
  sleep 5

  if systemctl is-active --quiet dotbot; then
    log "DotBot server is running"
  else
    warn "DotBot may have failed to start. Check: journalctl -u dotbot -n 50"
  fi

  systemctl enable caddy
  systemctl restart caddy

  if systemctl is-active --quiet caddy; then
    log "Caddy is running"

    # Verify HTTPS certificate provisioning
    echo ""
    echo "  Verifying HTTPS certificate provisioning..."
    echo "  (This may take 30-60 seconds for Let's Encrypt to issue certificate)"

    HTTPS_SUCCESS=false
    for attempt in {1..12}; do
      sleep 5
      if curl -sf --max-time 5 "https://$DOMAIN/" &>/dev/null; then
        HTTPS_SUCCESS=true
        break
      fi
      echo "    Attempt $attempt/12: Certificate not ready yet..."
    done

    if [ "$HTTPS_SUCCESS" = true ]; then
      log "HTTPS certificate provisioned successfully"
      echo -e "  ${GREEN}✓${NC} Your server is accessible at: https://$DOMAIN"
    else
      warn "HTTPS certificate provisioning may have failed"
      echo ""
      echo -e "  ${YELLOW}Troubleshooting:${NC}"
      echo "    1. Check Caddy logs: journalctl -u caddy -n 50"
      echo "    2. Verify DNS: dig +short $DOMAIN A"
      echo "    3. Ensure ports 80/443 are open: ufw status"
      echo "    4. Check Let's Encrypt rate limits"
      echo ""
      echo "  Certificate provisioning can take up to 5 minutes."
      echo "  Monitor progress: journalctl -u caddy -f"
    fi
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
