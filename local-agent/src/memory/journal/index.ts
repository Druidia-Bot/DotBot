/**
 * Journal — Assistant's Log
 *
 * Daily narrative journal written by the agent during the sleep cycle.
 * Each cycle reads un-journaled cache entries, synthesizes a first-person
 * narrative via LLM, and appends it to today's journal file.
 *
 * Structure:
 *   types.ts     — AgentContext interface
 *   identity.ts  — loads agent name, skeleton, backstory from me.json
 *   reader.ts    — reads cache file content with truncation limits
 *   narrator.ts  — LLM call for prose narrative synthesis
 *   fallback.ts  — structured format when LLM is unavailable
 *   store.ts     — journal file I/O (list, read, write)
 *   helpers.ts   — shared constants and utilities
 */

import { loadCacheIndex, saveCacheIndex } from "../research-cache.js";
import { getAgentContext } from "./identity.js";
import { readEntryContents } from "./reader.js";
import { synthesizeNarrative } from "./narrator.js";
import { buildStructuredFallback } from "./fallback.js";
import { readJournal as _readJournal, writeJournalSection } from "./store.js";
import type { CacheEntry } from "../research-cache.js";

// ============================================
// ORCHESTRATOR
// ============================================

/**
 * Append un-journaled cache entries to today's journal file.
 * Called by the sleep cycle. Returns the number of entries journaled.
 *
 * Process:
 *   1. Find un-journaled cache entries
 *   2. Read the actual file content for each entry
 *   3. Load agent identity for narrative voice
 *   4. Send content + identity to server LLM for narrative synthesis
 *   5. Append the narrative to today's journal file
 *   6. Mark entries as journaled in the cache index
 *
 * Falls back to structured format if the LLM call fails.
 */
export async function appendToJournal(): Promise<number> {
  const index = await loadCacheIndex();

  const unjournaled = index.entries.filter(e => !e.journaled);
  if (unjournaled.length === 0) return 0;

  // Group by date (entries may span midnight)
  const byDate = groupByDate(unjournaled);

  // Load identity once for all dates
  const agentContext = await getAgentContext();

  for (const [date, entries] of byDate) {
    const existingJournal = await _readJournal(date) ?? "";
    const entryContents = await readEntryContents(entries);

    // Try LLM narrative, fall back to structured format
    let section: string;
    try {
      section = await synthesizeNarrative(entries, entryContents, existingJournal, agentContext);
    } catch (err) {
      console.warn("[Journal] LLM narrative failed, falling back to structured format:", err);
      section = buildStructuredFallback(entries, entryContents);
    }

    await writeJournalSection(date, section, existingJournal);
  }

  // Mark all as journaled
  for (const entry of unjournaled) {
    entry.journaled = true;
  }
  await saveCacheIndex(index);

  return unjournaled.length;
}

// ============================================
// HELPERS
// ============================================

function groupByDate(entries: CacheEntry[]): Map<string, CacheEntry[]> {
  const byDate = new Map<string, CacheEntry[]>();
  for (const entry of entries) {
    const date = entry.cachedAt.slice(0, 10); // YYYY-MM-DD
    const group = byDate.get(date) || [];
    group.push(entry);
    byDate.set(date, group);
  }
  return byDate;
}

// ============================================
// RE-EXPORTS
// ============================================

export { listJournalFiles, readJournal } from "./store.js";
export type { AgentContext } from "./types.js";
