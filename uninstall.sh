#!/bin/bash
# ============================================================
# DotBot Uninstaller — Linux (Server)
# ============================================================
#
# Fully removes DotBot server from this machine.
# Reverses everything install.sh / deploy/setup.sh created.
#
# Removes:
#   - DotBot systemd service (dotbot.service)
#   - Caddy reverse proxy config for DotBot
#   - Deploy directory (default: /opt/.bot)
#   - dotbot system user + home directory (~dotbot/.bot/)
#   - Logrotate config (/etc/logrotate.d/dotbot)
#   - Caddy access logs (/var/log/caddy/dotbot-access.log)
#
# Does NOT remove:
#   - Node.js, Caddy, build tools (shared system packages)
#   - UFW firewall rules (may be shared with other services)
#   - Other Caddy sites (only removes the DotBot block)
#
# Usage:
#   sudo bash uninstall.sh              Interactive (confirms each step)
#   sudo bash uninstall.sh --force      Remove everything without prompting
#   sudo bash uninstall.sh --keep-data  Remove service but keep user data
#   sudo bash uninstall.sh --dry-run    Show what would be removed
#
# ============================================================

set -uo pipefail

# ============================================================
# Constants
# ============================================================

DEPLOY_DIR="${DOTBOT_DEPLOY_DIR:-/opt/.bot}"
BOT_USER="dotbot"
BOT_HOME="/home/$BOT_USER"

# ============================================================
# Parse arguments
# ============================================================

FORCE=false
KEEP_DATA=false
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --force)     FORCE=true ;;
        --keep-data) KEEP_DATA=true ;;
        --dry-run)   DRY_RUN=true ;;
        --help|-h)
            echo "Usage: sudo bash uninstall.sh [--force] [--keep-data] [--dry-run]"
            echo ""
            echo "  --force      Skip all confirmation prompts"
            echo "  --keep-data  Preserve /home/dotbot/.bot/ user data"
            echo "  --dry-run    Show what would be removed without doing it"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg"
            echo "Run with --help for usage"
            exit 1
            ;;
    esac
done

# ============================================================
# Colors
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

action() {
    if [ "$DRY_RUN" = true ]; then
        echo -e "  ${CYAN}[DRY RUN]${NC} $1"
    else
        echo -e "  ${GREEN}[OK]${NC} $1"
    fi
}

skip()   { echo -e "  ${GRAY}[--]${NC} $1"; }
warn()   { echo -e "  ${YELLOW}[!]${NC} $1"; }
fail()   { echo -e "  ${RED}[X]${NC} $1"; }

confirm() {
    if [ "$FORCE" = true ]; then return 0; fi
    read -rp "  $1 (y/N) " response
    [[ "$response" =~ ^[Yy]$ ]]
}

# ============================================================
# Preflight
# ============================================================

if [ "$(id -u)" -ne 0 ]; then
    fail "This script must be run as root (sudo)"
    exit 1
fi

# ============================================================
# Banner
# ============================================================

echo ""
echo -e "  ${RED}=====================================================${NC}"
echo -e "  ${RED}                                                     ${NC}"
echo -e "  ${RED}      DotBot Server Uninstaller                      ${NC}"
echo -e "  ${RED}                                                     ${NC}"
echo -e "  ${RED}=====================================================${NC}"
echo ""

# ============================================================
# Detection
# ============================================================

echo "  Detected installation:"
echo ""

# Service
SERVICE_EXISTS=false
if systemctl list-unit-files dotbot.service &>/dev/null && systemctl cat dotbot.service &>/dev/null 2>&1; then
    SERVICE_EXISTS=true
    SERVICE_STATE=$(systemctl is-active dotbot 2>/dev/null || echo "inactive")
    echo "    Service:           dotbot.service ($SERVICE_STATE)"
else
    echo -e "    Service:           ${GRAY}(not found)${NC}"
fi

# Deploy directory
if [ -d "$DEPLOY_DIR" ] && [ -f "$DEPLOY_DIR/package.json" ]; then
    DEPLOY_SIZE=$(du -sh "$DEPLOY_DIR" 2>/dev/null | cut -f1)
    echo "    Deploy directory:  $DEPLOY_DIR ($DEPLOY_SIZE)"
else
    echo -e "    Deploy directory:  ${GRAY}(not found)${NC}"
fi

# User + home
USER_EXISTS=false
if id "$BOT_USER" &>/dev/null; then
    USER_EXISTS=true
    if [ -d "$BOT_HOME/.bot" ]; then
        DATA_SIZE=$(du -sh "$BOT_HOME/.bot" 2>/dev/null | cut -f1)
        echo "    User data:         $BOT_HOME/.bot ($DATA_SIZE)"
    else
        echo "    User:              $BOT_USER (no .bot data)"
    fi
else
    echo -e "    User:              ${GRAY}(not found)${NC}"
fi

# Caddy config
CADDY_HAS_DOTBOT=false
if [ -f /etc/caddy/Caddyfile ] && grep -q "reverse_proxy localhost:300" /etc/caddy/Caddyfile 2>/dev/null; then
    CADDY_HAS_DOTBOT=true
    echo "    Caddy config:      DotBot block found in Caddyfile"
else
    echo -e "    Caddy config:      ${GRAY}(no DotBot block found)${NC}"
fi

# Logrotate
LOGROTATE_EXISTS=false
if [ -f /etc/logrotate.d/dotbot ]; then
    LOGROTATE_EXISTS=true
    echo "    Logrotate:         /etc/logrotate.d/dotbot"
else
    echo -e "    Logrotate:         ${GRAY}(not found)${NC}"
fi

echo ""

# Nothing to do?
if [ "$SERVICE_EXISTS" = false ] && [ ! -d "$DEPLOY_DIR" ] && [ "$USER_EXISTS" = false ]; then
    echo "  Nothing to uninstall -- DotBot server does not appear to be installed."
    echo ""
    exit 0
fi

# Confirmation
if [ "$FORCE" = false ] && [ "$DRY_RUN" = false ]; then
    echo -e "  ${RED}This will permanently remove the DotBot server from this machine.${NC}"
    if [ "$KEEP_DATA" = true ]; then
        echo -e "  ${GREEN}User data ($BOT_HOME/.bot/) will be preserved.${NC}"
    else
        echo -e "  ${RED}ALL server data (database, credentials, logs) will be deleted.${NC}"
        echo -e "  ${YELLOW}Use --keep-data to preserve $BOT_HOME/.bot/${NC}"
    fi
    echo ""
    if ! confirm "Proceed with uninstall?"; then
        echo "  Cancelled."
        exit 0
    fi
fi

echo ""
echo "  ----------------------------------------"
echo ""

# ============================================================
# STEP 1: Stop and disable systemd service
# ============================================================

echo -e "  ${YELLOW}[1/6]${NC} Stopping DotBot service..."

if [ "$SERVICE_EXISTS" = true ]; then
    if [ "$DRY_RUN" = false ]; then
        systemctl stop dotbot 2>/dev/null || true
        systemctl disable dotbot 2>/dev/null || true
        rm -f /etc/systemd/system/dotbot.service
        systemctl daemon-reload
    fi
    action "Stopped and removed dotbot.service"
else
    skip "Service not found"
fi

# ============================================================
# STEP 2: Remove Caddy DotBot config
# ============================================================

echo -e "  ${YELLOW}[2/6]${NC} Removing Caddy config..."

if [ "$CADDY_HAS_DOTBOT" = true ]; then
    if [ "$DRY_RUN" = false ]; then
        # Back up the Caddyfile before modifying
        cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-dotbot-uninstall

        # Count how many server blocks exist (top-level lines ending with {)
        BLOCK_COUNT=$(grep -cE '^\S+.*\{' /etc/caddy/Caddyfile 2>/dev/null || echo "0")

        if [ "$BLOCK_COUNT" -le 1 ]; then
            # Only DotBot's block -- clear the file
            echo "# Caddyfile -- DotBot block removed by uninstaller" > /etc/caddy/Caddyfile
            action "Cleared Caddyfile (was DotBot-only)"
        else
            # Multiple blocks -- warn user to edit manually
            warn "Caddyfile has multiple server blocks"
            echo "    Backup saved to: /etc/caddy/Caddyfile.pre-dotbot-uninstall"
            echo "    Please manually remove the DotBot block from /etc/caddy/Caddyfile"
        fi

        # Reload Caddy if it's running
        if systemctl is-active --quiet caddy 2>/dev/null; then
            systemctl reload caddy 2>/dev/null || true
        fi
    else
        action "Would modify Caddyfile to remove DotBot block"
    fi
else
    skip "No DotBot config in Caddyfile"
fi

# ============================================================
# STEP 3: Remove deploy directory
# ============================================================

echo -e "  ${YELLOW}[3/6]${NC} Removing deploy directory..."

if [ -d "$DEPLOY_DIR" ]; then
    if [ "$DRY_RUN" = false ]; then
        rm -rf "$DEPLOY_DIR"
    fi
    action "Removed $DEPLOY_DIR"
else
    skip "Deploy directory not found"
fi

# ============================================================
# STEP 4: Remove user data / user account
# ============================================================

echo -e "  ${YELLOW}[4/6]${NC} Removing user data..."

if [ "$USER_EXISTS" = true ]; then
    if [ "$KEEP_DATA" = true ]; then
        skip "Preserving user data at $BOT_HOME/.bot/ (--keep-data)"
    else
        if [ "$DRY_RUN" = false ]; then
            # Remove the user account + home directory
            userdel -r "$BOT_USER" 2>/dev/null || true
            # userdel -r should remove home, but clean up if it didn't
            if [ -d "$BOT_HOME" ]; then
                rm -rf "$BOT_HOME"
            fi
        fi
        action "Removed user '$BOT_USER' and home directory"
    fi
else
    skip "User '$BOT_USER' not found"
fi

# ============================================================
# STEP 5: Remove logrotate config
# ============================================================

echo -e "  ${YELLOW}[5/6]${NC} Removing logrotate config..."

if [ "$LOGROTATE_EXISTS" = true ]; then
    if [ "$DRY_RUN" = false ]; then
        rm -f /etc/logrotate.d/dotbot
    fi
    action "Removed /etc/logrotate.d/dotbot"
else
    skip "Logrotate config not found"
fi

# ============================================
# STEP 6: Clean up logs
# ============================================

echo -e "  ${YELLOW}[6/6]${NC} Cleaning up logs..."

CADDY_LOG="/var/log/caddy/dotbot-access.log"
if [ -f "$CADDY_LOG" ] || ls "${CADDY_LOG}"* &>/dev/null 2>&1; then
    if [ "$DRY_RUN" = false ]; then
        rm -f "${CADDY_LOG}"*
    fi
    action "Removed Caddy access logs"
else
    skip "No DotBot Caddy logs found"
fi

# ============================================================
# Summary
# ============================================================

echo ""
echo "  ----------------------------------------"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo -e "  ${CYAN}[DRY RUN] No changes were made.${NC}"
    echo -e "  ${CYAN}Run without --dry-run to perform the uninstall.${NC}"
else
    echo -e "  ${GREEN}========================================${NC}"
    echo -e "  ${GREEN}[OK] DotBot server has been uninstalled.${NC}"
    echo -e "  ${GREEN}========================================${NC}"

    if [ "$KEEP_DATA" = true ]; then
        echo ""
        echo -e "  ${YELLOW}User data preserved at: $BOT_HOME/.bot/${NC}"
        echo -e "  ${GRAY}To remove it later: rm -rf $BOT_HOME${NC}"
    fi
fi

echo ""
echo -e "  ${GRAY}Note: Node.js, Caddy, and system packages were NOT removed.${NC}"
echo -e "  ${GRAY}Uninstall them separately if desired:${NC}"
echo -e "  ${GRAY}  apt remove nodejs caddy${NC}"
echo ""
echo -e "  ${GRAY}UFW firewall rules were NOT modified.${NC}"
echo -e "  ${GRAY}Review with: ufw status${NC}"
echo ""
