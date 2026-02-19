/**
 * Hint Store — In-Memory Cache with Lazy Filesystem Flush
 *
 * Stores structural hints per MCP tool. Hints are cheap to regenerate
 * (~50ms of JSON parsing), so in-memory is the primary store.
 * Filesystem writes are fire-and-forget background ops.
 *
 * Hints are stored on disk at:
 *   ~/.bot/mcp/hints/{serverName}/{toolName}.json
 *
 * Disk writes go through sendExecutionCommand → filesystem.create_file
 * (same pattern as research-wrapper.ts) since the server doesn't have
 * direct access to the local agent's filesystem.
 */

import { createComponentLogger } from "#logging.js";
import type { OutputHints } from "./collection-types.js";

const log = createComponentLogger("mcp-gateway.hints");

/** How old hints can be before they're considered stale. */
const HINT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// ============================================
// IN-MEMORY STORE
// ============================================

/** toolId → OutputHints */
const hintCache = new Map<string, OutputHints>();

/**
 * Load hints for a tool. Returns null if not cached.
 */
export function loadHints(toolId: string): OutputHints | null {
  return hintCache.get(toolId) ?? null;
}

/**
 * Save hints for a tool. Stores in memory immediately.
 * Caller is responsible for flushing to disk if desired.
 */
export function saveHints(hints: OutputHints): void {
  hintCache.set(hints.toolId, hints);
  log.info("Hints cached", { toolId: hints.toolId, fields: hints.summaryFields.length });
}

/**
 * Check if hints are stale (older than 14 days).
 */
export function hintsAreStale(hints: OutputHints): boolean {
  const age = Date.now() - new Date(hints.lastChecked).getTime();
  return age > HINT_MAX_AGE_MS;
}

/**
 * Remove hints for a tool (e.g., on structure mismatch before re-introspection).
 */
export function clearHints(toolId: string): void {
  hintCache.delete(toolId);
}

/**
 * Get all cached hints (for diagnostics / testing).
 */
export function getAllHints(): Map<string, OutputHints> {
  return new Map(hintCache);
}

/**
 * Build the filesystem path for a tool's hints file.
 * Returns a path relative to ~/.bot/ that can be used with
 * sendExecutionCommand → filesystem.create_file.
 */
export function getHintFilePath(toolId: string): string {
  // toolId: "mcp.lobsterbands.gmail-find-email"
  const parts = toolId.split(".");
  if (parts.length < 3 || parts[0] !== "mcp") {
    return `~/.bot/mcp/hints/${toolId.replace(/\./g, "/")}.json`;
  }
  const serverName = parts[1];
  const toolName = parts.slice(2).join(".");
  return `~/.bot/mcp/hints/${serverName}/${toolName}.json`;
}

/**
 * Flush a hint to disk via the local agent's filesystem.
 *
 * This is a fire-and-forget operation. The caller provides a
 * `writeFile` function that handles the actual I/O (typically
 * sendExecutionCommand → filesystem.create_file).
 */
export async function flushHintsToDisk(
  toolId: string,
  writeFile: (path: string, content: string) => Promise<void>,
): Promise<void> {
  const hints = hintCache.get(toolId);
  if (!hints) return;

  const filePath = getHintFilePath(toolId);
  try {
    await writeFile(filePath, JSON.stringify(hints, null, 2));
    log.info("Hints flushed to disk", { toolId, path: filePath });
  } catch (err) {
    log.warn("Failed to flush hints to disk", { toolId, path: filePath, error: err });
  }
}
