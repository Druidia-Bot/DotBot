/**
 * Journal — Cache Content Reader
 *
 * Reads the actual file content for un-journaled cache entries.
 * Truncates individual entries and caps total content to stay
 * within LLM context limits.
 */

import { readCacheEntry } from "../research-cache.js";
import type { CacheEntry } from "../research-cache.js";

const MAX_CONTENT_PER_ENTRY = 2000;
const MAX_TOTAL_CONTENT = 12000;

/**
 * Read the actual file content for each cache entry.
 * Returns a map of filename → truncated content.
 */
export async function readEntryContents(entries: CacheEntry[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  let totalLength = 0;

  for (const entry of entries) {
    if (totalLength >= MAX_TOTAL_CONTENT) break;

    const raw = await readCacheEntry(entry.filename);
    if (!raw) continue;

    const budget = Math.min(MAX_CONTENT_PER_ENTRY, MAX_TOTAL_CONTENT - totalLength);
    const truncated = raw.length > budget
      ? raw.slice(0, budget) + "\n[...truncated]"
      : raw;

    contents.set(entry.filename, truncated);
    totalLength += truncated.length;
  }

  return contents;
}
