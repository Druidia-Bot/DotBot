#!/bin/bash
# ============================================================
# DotBot Local Agent — Launcher with Self-Update Support
# ============================================================
#
# Usage:
#   chmod +x launcher.sh && ./launcher.sh
#
# What this does:
#   - Starts the local agent (node dist/index.js)
#   - Watches for a self-update staging marker
#   - On update: stops agent, backs up dist, promotes staged build, restarts
#   - On startup failure: rolls back to backup automatically
#   - Logs everything to ~/.bot/launcher.log
#
# Self-update flow:
#   1. DotBot compiles changes in ~/.bot/workspace/dotbot/local-agent/
#   2. DotBot writes staged build to ~/.bot/workspace/staged-dist/
#   3. DotBot creates marker file ~/.bot/workspace/update-pending
#   4. This launcher detects the marker, applies the update, restarts
#
# ============================================================

set -uo pipefail

# --- Paths ---
BOT_DIR="$HOME/.bot"
WORKSPACE_DIR="$BOT_DIR/workspace"
STAGED_DIST_DIR="$WORKSPACE_DIR/staged-dist"
UPDATE_MARKER="$WORKSPACE_DIR/update-pending"
BACKUP_DIST_DIR="$WORKSPACE_DIR/dist-backup"
ROLLBACK_MARKER="$WORKSPACE_DIR/rollback-pending"
LAUNCHER_LOG="$BOT_DIR/launcher.log"

# Resolve agent root — script lives in local-agent/scripts/
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_ROOT="$(dirname "$SCRIPT_DIR")"
if [ ! -f "$AGENT_ROOT/package.json" ]; then
    AGENT_ROOT="$(pwd)"
fi
AGENT_DIST="$AGENT_ROOT/dist"
AGENT_ENTRY="$AGENT_DIST/index.js"

# --- Logging ---
log() {
    local level="${2:-INFO}"
    local ts
    ts=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$ts] [$level] $1"
    echo "[$ts] [$level] $1" >> "$LAUNCHER_LOG" 2>/dev/null
}

# --- Ensure directories ---
mkdir -p "$WORKSPACE_DIR"

# --- Startup check ---
if [ ! -f "$AGENT_ENTRY" ]; then
    log "Agent entry point not found at $AGENT_ENTRY" "ERROR"
    log "Run 'npm run build' in the local-agent directory first." "ERROR"
    exit 1
fi

# --- Main loop ---
MAX_RESTARTS=10
RESTART_COUNT=0
RESTART_WINDOW=300  # Reset counter after 5 minutes of stable running

log "=== DotBot Launcher Started ==="
log "Agent root: $AGENT_ROOT"
log "Agent entry: $AGENT_ENTRY"

while true; do
    # --- Check for pending update BEFORE starting ---
    if [ -f "$UPDATE_MARKER" ]; then
        log "Update marker detected — applying staged update..."

        if [ -d "$STAGED_DIST_DIR" ]; then
            # Backup current dist
            rm -rf "$BACKUP_DIST_DIR"
            if [ -d "$AGENT_DIST" ]; then
                cp -r "$AGENT_DIST" "$BACKUP_DIST_DIR"
                log "Backed up current dist to $BACKUP_DIST_DIR"
            fi

            # Promote staged dist
            rm -rf "$AGENT_DIST"
            cp -r "$STAGED_DIST_DIR" "$AGENT_DIST"
            log "Promoted staged dist to $AGENT_DIST"

            # Clean up
            rm -f "$UPDATE_MARKER"
            rm -rf "$STAGED_DIST_DIR"
            log "Update applied successfully"
        else
            log "Update marker found but no staged-dist directory — ignoring" "WARN"
            rm -f "$UPDATE_MARKER"
        fi
    fi

    # --- Check for rollback ---
    if [ -f "$ROLLBACK_MARKER" ]; then
        log "Rollback marker detected — restoring backup..."
        if [ -d "$BACKUP_DIST_DIR" ]; then
            rm -rf "$AGENT_DIST"
            cp -r "$BACKUP_DIST_DIR" "$AGENT_DIST"
            rm -f "$ROLLBACK_MARKER"
            log "Rollback complete — restored from backup"
        else
            log "Rollback requested but no backup found!" "ERROR"
            rm -f "$ROLLBACK_MARKER"
        fi
    fi

    # --- Start the agent ---
    log "Starting local agent (attempt $((RESTART_COUNT + 1)))..."
    START_TIME=$(date +%s)

    cd "$AGENT_ROOT"
    node "$AGENT_ENTRY" &
    AGENT_PID=$!
    log "Agent started (PID: $AGENT_PID)"

    # Wait for process to exit
    wait $AGENT_PID
    EXIT_CODE=$?
    END_TIME=$(date +%s)
    RUN_DURATION=$((END_TIME - START_TIME))

    log "Agent exited with code $EXIT_CODE after ${RUN_DURATION}s"

    # --- Decide what to do ---

    # If it ran long enough, reset the restart counter
    if [ "$RUN_DURATION" -gt "$RESTART_WINDOW" ]; then
        RESTART_COUNT=0
    fi

    # If an update is pending, don't count this as a crash
    if [ -f "$UPDATE_MARKER" ]; then
        log "Update pending — restarting to apply..."
        continue
    fi

    # If it crashed immediately after an update, rollback
    if [ "$RUN_DURATION" -lt 10 ] && [ -d "$BACKUP_DIST_DIR" ]; then
        log "Agent crashed within 10s — auto-rolling back to previous version" "WARN"
        rm -rf "$AGENT_DIST"
        cp -r "$BACKUP_DIST_DIR" "$AGENT_DIST"
        log "Auto-rollback complete"
        continue
    fi

    # Normal restart with backoff
    RESTART_COUNT=$((RESTART_COUNT + 1))
    if [ "$RESTART_COUNT" -ge "$MAX_RESTARTS" ]; then
        log "Max restarts ($MAX_RESTARTS) reached — giving up" "ERROR"
        break
    fi

    BACKOFF=$((RESTART_COUNT * 2))
    if [ "$BACKOFF" -gt 30 ]; then
        BACKOFF=30
    fi
    log "Restarting in ${BACKOFF}s..."
    sleep "$BACKOFF"
done

log "=== DotBot Launcher Stopped ==="
