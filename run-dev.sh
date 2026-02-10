#!/bin/bash
# ============================================================
# DotBot Development Runner — Server + Agent on one machine
# ============================================================
#
# ⚠️  This is for DEVELOPMENT ONLY.
# In production, the server runs on Linux and the agent on Windows.
#
# Usage:
#   bash run-dev.sh           # Start both
#   bash run-dev.sh --server  # Server only
#   bash run-dev.sh --agent   # Agent only
#   bash run-dev.sh --stop    # Stop everything
#   bash run-dev.sh --update  # Pull + rebuild + run
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PID_FILE="/tmp/dotbot-server.pid"
AGENT_PID_FILE="/tmp/dotbot-agent.pid"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# ── Stop mode ──────────────────────────────────────────

stop_all() {
  echo ""
  echo -e "${YELLOW}  Stopping DotBot...${NC}"

  local killed=0

  # Kill by PID files
  for pidfile in "$SERVER_PID_FILE" "$AGENT_PID_FILE"; do
    if [ -f "$pidfile" ]; then
      local pid
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        echo -e "${GRAY}  Killed PID $pid${NC}"
        killed=$((killed + 1))
      fi
      rm -f "$pidfile"
    fi
  done

  # Kill by port
  for port in 3000 3001; do
    local pid
    pid=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      echo -e "${GRAY}  Killed process on port $port (PID $pid)${NC}"
      killed=$((killed + 1))
    fi
  done

  if [ "$killed" -gt 0 ]; then
    echo -e "${GREEN}  ✅ DotBot stopped${NC}"
  else
    echo -e "${GRAY}  No running DotBot processes found${NC}"
  fi
  echo ""
}

if [[ "${1:-}" == "--stop" ]]; then
  stop_all
  exit 0
fi

# ── Banner ─────────────────────────────────────────────

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║              DotBot — Dev Mode                         ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}  ⚠️  DEVELOPMENT MODE${NC}"
echo -e "${YELLOW}  Running server + agent on the same machine is NOT recommended${NC}"
echo -e "${YELLOW}  for production. In production:${NC}"
echo -e "${YELLOW}    • Server runs on a Linux VPS (install.sh)${NC}"
echo -e "${YELLOW}    • Agent runs on your Windows PC (install.ps1)${NC}"
echo ""

# ── Update mode ────────────────────────────────────────

if [[ "${1:-}" == "--update" ]]; then
  echo -e "${YELLOW}  Updating DotBot...${NC}"
  echo ""

  cd "$SCRIPT_DIR"
  git pull
  echo -e "${GREEN}  ✅ Code updated${NC}"

  npm install --silent 2>/dev/null
  echo -e "${GREEN}  ✅ Dependencies updated${NC}"

  cd "$SCRIPT_DIR/shared" && npm run build --silent 2>/dev/null
  echo -e "${GREEN}  ✅ shared/ built${NC}"

  cd "$SCRIPT_DIR/server" && npm run build --silent 2>/dev/null
  echo -e "${GREEN}  ✅ server/ built${NC}"

  cd "$SCRIPT_DIR/local-agent" && npm run build --silent 2>/dev/null
  echo -e "${GREEN}  ✅ local-agent/ built${NC}"

  echo ""
  echo -e "${GREEN}  Update complete!${NC}"
  echo ""
  shift
fi

# ── Check for .env ────────────────────────────────────

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo -e "${YELLOW}  ⚠️  No .env file found${NC}"
  echo -e "${GRAY}     Copy .env.example to .env and add your API keys${NC}"
  echo ""
  exit 1
fi

# ── Stop existing instances ───────────────────────────

for port in 3000 3001; do
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 0.5

# ── Run ───────────────────────────────────────────────

MODE="${1:-both}"

if [[ "$MODE" == "--server" ]]; then
  echo -e "${GREEN}  Starting Server...${NC}"
  echo -e "${GRAY}  Press Ctrl+C to stop${NC}"
  echo ""
  cd "$SCRIPT_DIR/server"
  npm run dev

elif [[ "$MODE" == "--agent" ]]; then
  echo -e "${GREEN}  Starting Local Agent...${NC}"
  echo -e "${GRAY}  Press Ctrl+C to stop${NC}"
  echo ""
  cd "$SCRIPT_DIR/local-agent"
  npm run dev

else
  # Run both — server in background, agent in foreground
  echo -e "${GREEN}  Starting Server in background...${NC}"
  cd "$SCRIPT_DIR/server"
  npm run dev > /tmp/dotbot-server.log 2>&1 &
  echo $! > "$SERVER_PID_FILE"
  echo -e "${GRAY}  Server PID: $(cat "$SERVER_PID_FILE") — logs: /tmp/dotbot-server.log${NC}"

  sleep 2

  echo -e "${GREEN}  Starting Local Agent...${NC}"
  echo ""
  echo -e "${GRAY}  ════════════════════════════════════════════════════${NC}"
  echo -e "${GRAY}    Press Ctrl+C to stop the agent${NC}"
  echo -e "${GRAY}    Run: bash run-dev.sh --stop  to kill everything${NC}"
  echo -e "${GRAY}  ════════════════════════════════════════════════════${NC}"
  echo ""

  cd "$SCRIPT_DIR/local-agent"
  npm run dev

  # Cleanup server when agent exits
  if [ -f "$SERVER_PID_FILE" ]; then
    kill "$(cat "$SERVER_PID_FILE")" 2>/dev/null || true
    rm -f "$SERVER_PID_FILE"
  fi
fi
