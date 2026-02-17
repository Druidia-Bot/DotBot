/**
 * Research Cache
 *
 * Persists web fetch results, search results, and rich media descriptions
 * as .md files in ~/.bot/memory/research-cache/ so Dot can reference them
 * on follow-up questions.
 *
 * Each cache entry is a .md file with YAML frontmatter (source, type,
 * timestamp, tool) and a readable body. An index.json file maintains
 * a lightweight manifest for fast lookups without reading every file.
 *
 * The sleep cycle reviews the cache, promotes valuable findings to
 * knowledge/models, and prunes stale entries (default: 72h TTL).
 */

import { promises as fs } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const CACHE_DIR = join(homedir(), ".bot", "memory", "research-cache");
const INDEX_PATH = join(CACHE_DIR, "index.json");
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

// ============================================
// TYPES
// ============================================

export type CacheEntryType = "web_page" | "web_search" | "api_response" | "pdf_summary" | "video_transcript" | "image_description";

export interface CacheEntry {
  /** Unique filename (without path) */
  filename: string;
  /** Source URL or identifier */
  source: string;
  /** Content type */
  type: CacheEntryType;
  /** Tool that produced this entry */
  tool: string;
  /** ISO timestamp when cached */
  cachedAt: string;
  /** Short summary for index lookups (first ~200 chars of content) */
  summary: string;
  /** Title if available */
  title?: string;
  /** 1-2 sentence synthesis: what is this and why does it matter */
  brief?: string;
  /** Subject tags for fast matching (3-5 keywords) */
  tags?: string[];
  /** Memory model slugs this entry relates to (mini knowledge graph) */
  relatedModels?: string[];
  /** Whether async enrichment has run */
  enriched?: boolean;
  /** Whether the sleep cycle has reviewed this entry */
  reviewed?: boolean;
  /** Whether promoted to permanent knowledge */
  promoted?: boolean;
  /** Whether this entry has been written to the daily journal */
  journaled?: boolean;
}

export interface CacheIndex {
  entries: CacheEntry[];
  lastPrunedAt?: string;
}

// ============================================
// INIT
// ============================================

async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

// ============================================
// INDEX MANAGEMENT
// ============================================

export async function loadCacheIndex(): Promise<CacheIndex> {
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { entries: [] };
  }
}

export async function saveCacheIndex(index: CacheIndex): Promise<void> {
  await ensureCacheDir();
  await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
}

// ============================================
// WRITE CACHE ENTRY
// ============================================

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function buildFrontmatter(entry: Omit<CacheEntry, "filename" | "summary">): string {
  const lines = [
    "---",
    `source: "${entry.source}"`,
    `type: ${entry.type}`,
    `tool: ${entry.tool}`,
    `cachedAt: ${entry.cachedAt}`,
  ];
  if (entry.title) lines.push(`title: "${entry.title.replace(/"/g, '\\"')}"`);
  if (entry.brief) lines.push(`brief: "${entry.brief.replace(/"/g, '\\"')}"`);
  if (entry.tags?.length) lines.push(`tags: [${entry.tags.map(t => `"${t}"`).join(", ")}]`);
  if (entry.relatedModels?.length) lines.push(`relatedModels: [${entry.relatedModels.map(m => `"${m}"`).join(", ")}]`);
  lines.push("---");
  return lines.join("\n");
}

/**
 * Write a research cache entry. Returns the filename.
 */
export async function writeResearchCache(opts: {
  source: string;
  type: CacheEntryType;
  tool: string;
  title?: string;
  content: string;
  brief?: string;
  tags?: string[];
  relatedModels?: string[];
}): Promise<string> {
  await ensureCacheDir();

  const now = new Date();
  const datePrefix = now.toISOString().slice(0, 10); // 2026-02-16
  const slug = slugify(opts.title || opts.source);
  const filename = `${datePrefix}-${slug}.md`;
  const filepath = join(CACHE_DIR, filename);

  const frontmatter = buildFrontmatter({
    source: opts.source,
    type: opts.type,
    tool: opts.tool,
    title: opts.title,
    brief: opts.brief,
    tags: opts.tags,
    relatedModels: opts.relatedModels,
    cachedAt: now.toISOString(),
  });

  const body = opts.content.length > 100_000
    ? opts.content.slice(0, 100_000) + "\n\n...[truncated at 100K chars]"
    : opts.content;

  const fileContent = `${frontmatter}\n\n${body}\n`;
  await fs.writeFile(filepath, fileContent, "utf-8");

  // Update index
  const index = await loadCacheIndex();

  // Remove existing entry with same filename (overwrite)
  index.entries = index.entries.filter(e => e.filename !== filename);

  const summary = opts.content.replace(/\n/g, " ").slice(0, 200);

  index.entries.push({
    filename,
    source: opts.source,
    type: opts.type,
    tool: opts.tool,
    title: opts.title,
    cachedAt: now.toISOString(),
    summary,
    brief: opts.brief,
    tags: opts.tags,
    relatedModels: opts.relatedModels,
    enriched: !!(opts.brief || opts.tags?.length),
  });

  await saveCacheIndex(index);

  return filename;
}

// ============================================
// READ
// ============================================

/**
 * Get the full path to a cache entry file.
 */
export function getCacheFilePath(filename: string): string {
  return join(CACHE_DIR, filename);
}

/**
 * Read a cache entry's content.
 */
export async function readCacheEntry(filename: string): Promise<string | null> {
  try {
    return await fs.readFile(join(CACHE_DIR, filename), "utf-8");
  } catch {
    return null;
  }
}

// ============================================
// PRUNE
// ============================================

/**
 * Remove cache entries older than the TTL that haven't been promoted.
 * Called by the sleep cycle.
 */
export async function pruneStaleCacheEntries(ttlMs: number = DEFAULT_TTL_MS): Promise<number> {
  const index = await loadCacheIndex();
  const cutoff = Date.now() - ttlMs;
  let pruned = 0;

  const kept: CacheEntry[] = [];
  for (const entry of index.entries) {
    const age = new Date(entry.cachedAt).getTime();
    if (age < cutoff && !entry.promoted) {
      // Delete the file
      try {
        await fs.unlink(join(CACHE_DIR, entry.filename));
      } catch { /* file may already be gone */ }
      pruned++;
    } else {
      kept.push(entry);
    }
  }

  if (pruned > 0) {
    index.entries = kept;
    index.lastPrunedAt = new Date().toISOString();
    await saveCacheIndex(index);
  }

  return pruned;
}

/**
 * Mark entries as reviewed by the sleep cycle.
 */
export async function markEntriesReviewed(filenames: string[]): Promise<void> {
  const index = await loadCacheIndex();
  for (const entry of index.entries) {
    if (filenames.includes(entry.filename)) {
      entry.reviewed = true;
    }
  }
  await saveCacheIndex(index);
}

/**
 * Mark an entry as promoted to permanent knowledge.
 */
export async function markEntryPromoted(filename: string): Promise<void> {
  const index = await loadCacheIndex();
  const entry = index.entries.find(e => e.filename === filename);
  if (entry) {
    entry.promoted = true;
    await saveCacheIndex(index);
  }
}

/**
 * Get the cache directory path (for use in system prompts).
 */
export function getCacheDir(): string {
  return CACHE_DIR;
}
