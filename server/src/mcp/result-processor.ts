/**
 * Result Processor — Collection Pipeline for MCP Tool Results
 *
 * Intercepts large MCP tool results before they hit the 8K truncation.
 * Applies the "learn-once, parse-forever" pattern:
 *
 *   1. Save full raw result to a cache file on the local agent
 *   2. Load structural hints (or introspect if cold/stale)
 *   3. Extract a clean overview using summary fields
 *   4. Return the overview + collection reference to the LLM
 *
 * Small results (< SMALL_RESULT_THRESHOLD) pass through unchanged.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import { introspect, hintsMatchStructure, extractItems, extractSummaryFields } from "./introspector.js";
import { loadHints, saveHints, hintsAreStale, clearHints, flushHintsToDisk } from "./hint-store.js";
import type { OutputHints, CollectionRef } from "./collection-types.js";

const log = createComponentLogger("mcp-gateway.collections");

/** Results below this size pass through without collection processing. */
const SMALL_RESULT_THRESHOLD = 10_000;

/** Max items to show in the overview table. */
const MAX_OVERVIEW_ITEMS = 25;

/** Max characters for a single cell value in the overview table. */
const MAX_CELL_LENGTH = 80;

/** TTL for collection references (extended on access). */
const COLLECTION_REF_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ============================================
// COLLECTION REFERENCE STORE
// ============================================

interface StoredRef {
  ref: CollectionRef;
  expiresAt: number;
}

const collectionRefs = new Map<string, StoredRef>();

/** Periodic cleanup of expired refs (runs every 10 minutes). */
setInterval(() => {
  const now = Date.now();
  for (const [id, stored] of collectionRefs) {
    if (stored.expiresAt < now) collectionRefs.delete(id);
  }
}, 10 * 60 * 1000);

/**
 * Get a collection reference, extending its TTL on access.
 */
export function getCollectionRef(collectionId: string): CollectionRef | null {
  const stored = collectionRefs.get(collectionId);
  if (!stored) return null;
  stored.expiresAt = Date.now() + COLLECTION_REF_TTL_MS; // extend TTL
  return stored.ref;
}

/**
 * Get all active collection references (for diagnostics).
 */
export function getActiveCollections(): CollectionRef[] {
  return [...collectionRefs.values()].map(s => s.ref);
}

// ============================================
// MAIN ENTRY POINT
// ============================================

/**
 * Process an MCP tool result through the collection pipeline.
 *
 * - Small results pass through unchanged.
 * - Large results are cached, introspected, and summarized.
 *
 * Returns the string that should be sent to the LLM as the tool result.
 */
export async function processMcpResult(
  deviceId: string,
  toolId: string,
  rawResult: string,
): Promise<string> {
  // Small result — pass through
  if (rawResult.length <= SMALL_RESULT_THRESHOLD) {
    return rawResult;
  }

  log.info("Large MCP result — applying collection pipeline", {
    toolId,
    rawSize: rawResult.length,
  });

  // Generate collection ID and cache file path
  const collectionId = `col_${nanoid(8)}`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeToolId = toolId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const cacheFilename = `${safeToolId}-${timestamp}.json`;
  const cachePath = `~/.bot/memory/research-cache/${cacheFilename}`;

  // Fire-and-forget: save full result to cache file on local agent
  sendExecutionCommand(deviceId, {
    id: `col_save_${nanoid(6)}`,
    type: "tool_execute",
    payload: {
      toolId: "filesystem.create_file",
      toolArgs: { path: cachePath, content: rawResult },
    },
    dryRun: false,
    timeout: 15_000,
    sandboxed: false,
    requiresApproval: false,
  }).then(() => {
    log.info("Collection cached", { toolId, cacheFilename, size: rawResult.length });
  }).catch(err => {
    log.warn("Failed to cache collection", { toolId, cacheFilename, error: err });
  });

  // Load or generate structural hints
  let hints = loadHints(toolId);

  if (hints) {
    const stale = hintsAreStale(hints);
    const structureMatch = !stale && hintsMatchStructure(hints, rawResult);

    if (!stale && structureMatch) {
      // Warm path — use existing hints
      log.info("Using cached hints (warm path)", {
        toolId,
        format: hints.format,
        summaryFields: hints.summaryFields.length,
        lastChecked: hints.lastChecked,
      });
    } else {
      // Cold path — hints exist but are stale or structure changed
      const reason = stale ? "stale (age)" : "structure mismatch";
      log.info(`Hints refresh: ${reason} — re-introspecting`, {
        toolId,
        previousFormat: hints.format,
        previousFields: hints.summaryFields.length,
        lastChecked: hints.lastChecked,
      });
      clearHints(toolId);
      hints = null;
    }
  }

  if (!hints) {
    // Cold path — introspect structure
    hints = introspect(toolId, rawResult);
    if (!hints) {
      // Not a collection (no array found) — fall back to truncation with file pointer
      log.info("No collection structure found — truncating with file pointer", {
        toolId,
        rawSize: rawResult.length,
      });
      const truncated = rawResult.substring(0, SMALL_RESULT_THRESHOLD);
      return truncated + `\n\n...[truncated — full ${rawResult.length} chars saved to ${cachePath}]`;
    }

    log.info("Introspected new structure", {
      toolId,
      format: hints.format,
      arrayPath: hints.arrayPath || "(root)",
      summaryFields: hints.summaryFields,
      noiseFields: hints.noiseFields,
      estimatedItemSize: hints.estimatedItemSize,
      itemCount: hints.sampleItemCount,
    });

    saveHints(hints);

    // Fire-and-forget: flush hints to disk
    flushHintsToDisk(toolId, async (path, content) => {
      await sendExecutionCommand(deviceId, {
        id: `hints_save_${nanoid(6)}`,
        type: "tool_execute",
        payload: {
          toolId: "filesystem.create_file",
          toolArgs: { path, content },
        },
        dryRun: false,
        timeout: 10_000,
        sandboxed: false,
        requiresApproval: false,
      });
    }).catch(err => {
      log.warn("Failed to flush hints to disk", { toolId, error: err });
    });
  }

  // Extract items and build overview
  let items = extractItems(rawResult, hints);

  // Edge case: hints exist but items array is empty (data shape changed silently)
  if (items.length === 0 && rawResult.length > SMALL_RESULT_THRESHOLD) {
    log.warn("Hints produced zero items — re-introspecting", { toolId });
    clearHints(toolId);
    const refreshed = introspect(toolId, rawResult);
    if (refreshed) {
      hints = refreshed;
      saveHints(hints);
      items = extractItems(rawResult, hints);
    }
  }

  const itemCount = items.length;

  // Register collection reference
  const ref: CollectionRef = {
    collectionId,
    filePath: cachePath,
    toolId,
    hints,
    cachedAt: new Date().toISOString(),
    itemCount,
  };
  collectionRefs.set(collectionId, {
    ref,
    expiresAt: Date.now() + COLLECTION_REF_TTL_MS,
  });

  // Build the overview string
  return buildOverview(collectionId, items, hints, cachePath);
}

// ============================================
// OVERVIEW BUILDER
// ============================================

/**
 * Build a markdown overview table from collection items.
 */
export function buildOverview(
  collectionId: string,
  items: unknown[],
  hints: OutputHints,
  cachePath?: string,
): string {
  const displayItems = items.slice(0, MAX_OVERVIEW_ITEMS);
  const summaryFields = hints.summaryFields;

  if (summaryFields.length === 0 || displayItems.length === 0) {
    return `${items.length} items found (collection: ${collectionId}). No summary fields detected.\n` +
      `Use result.get("${collectionId}", 0) to inspect the first item.`;
  }

  // Build header
  const headerLabels = summaryFields.map(f => {
    // Clean up field names for display: "payload.headers[From]" → "From"
    const bracketMatch = f.match(/\[(.+)\]$/);
    if (bracketMatch) return bracketMatch[1];
    const parts = f.split(".");
    return parts[parts.length - 1];
  });

  const lines: string[] = [];
  lines.push(`${items.length} items found (collection: ${collectionId}).${cachePath ? ` Full data cached.` : ""}`);
  lines.push("");
  lines.push(`| # | ${headerLabels.join(" | ")} |`);
  lines.push(`|---|${headerLabels.map(() => "---").join("|")}|`);

  for (let i = 0; i < displayItems.length; i++) {
    const item = displayItems[i];
    const summary = extractSummaryFields(item, summaryFields);
    const cells = summaryFields.map(f => formatCell(summary[f]));
    lines.push(`| ${i} | ${cells.join(" | ")} |`);
  }

  if (items.length > MAX_OVERVIEW_ITEMS) {
    lines.push("");
    lines.push(`...and ${items.length - MAX_OVERVIEW_ITEMS} more items. Use result.filter to narrow.`);
  }

  lines.push("");
  lines.push(`Use result.get("${collectionId}", index) for full item details.`);
  lines.push(`Use result.filter("${collectionId}", field, op, value) to narrow.`);

  return lines.join("\n");
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) {
    const joined = value.join(", ");
    return truncateCell(joined);
  }
  if (typeof value === "object") {
    return truncateCell(JSON.stringify(value));
  }
  return truncateCell(String(value));
}

function truncateCell(value: string): string {
  if (value.length <= MAX_CELL_LENGTH) return value;
  return value.substring(0, MAX_CELL_LENGTH - 3) + "...";
}
