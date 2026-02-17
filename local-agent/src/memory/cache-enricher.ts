/**
 * Cache Enricher
 *
 * Async post-write enrichment for research cache entries.
 * Runs fire-and-forget after the tool result is returned to Dot.
 *
 * Uses the local LLM (Qwen 2.5 0.5B) to generate:
 * 1. Tags — 3-5 subject keywords for fast matching
 * 2. Brief — 1-2 sentence synthesis (headnote)
 * 3. Related models — memory model slugs this content connects to
 *
 * Falls back to server workhorse if local LLM is unavailable.
 * The enriched metadata is written back to the index and the .md frontmatter.
 */

import { loadCacheIndex, getCacheFilePath } from "./research-cache.js";
import * as store from "./store.js";
import { serverLLMCall } from "../server-llm.js";
import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";

const INDEX_PATH = join(homedir(), ".bot", "memory", "research-cache", "index.json");
const LLM_TIMEOUT_MS = 15_000;
const CONTENT_SNIPPET_LENGTH = 2000;
const MAX_MODEL_SLUGS = 30;
const LOCAL_CONTEXT_WINDOW = 4096;
const RESPONSE_BUDGET = 256;
const OVERHEAD_TOKENS = 150; // system prompt + template chrome
const MAX_INPUT_TOKENS = LOCAL_CONTEXT_WINDOW - RESPONSE_BUDGET - OVERHEAD_TOKENS; // ~3690

/** Rough token estimate: ~4 chars per token for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================
// LLM QUERY (local-first, server fallback)
// ============================================

async function queryForEnrichment(prompt: string, systemPrompt: string, maxTokens: number): Promise<string | null> {
  // Try local LLM first
  try {
    const { isLocalModelReady, queryLocalLLM } = await import("../llm/local-llm.js");
    if (isLocalModelReady()) {
      const call = queryLocalLLM(prompt, systemPrompt, maxTokens);
      call.catch(() => {});
      return await Promise.race([
        call,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Local LLM timed out")), LLM_TIMEOUT_MS)
        ),
      ]);
    }
  } catch { /* local unavailable */ }

  // Fallback to server workhorse
  try {
    const result = await Promise.race([
      serverLLMCall({
        role: "workhorse",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        maxTokens,
        temperature: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Server LLM timed out")), LLM_TIMEOUT_MS)
      ),
    ]);
    if (result.success && result.content) return result.content;
  } catch { /* server unavailable */ }

  return null;
}

// ============================================
// LLM-BASED ENRICHMENT
// ============================================

interface EnrichmentResult {
  tags: string[];
  brief: string;
  relatedModels: string[];
}

async function llmEnrich(content: string, title: string | undefined, modelSlugs: string[]): Promise<EnrichmentResult> {
  const titleLine = title ? `Title: ${title}\n` : "";

  // Cap model slugs to avoid blowing context
  const cappedSlugs = modelSlugs.slice(0, MAX_MODEL_SLUGS);
  const modelList = cappedSlugs.length > 0
    ? `\nKnown topics in memory (match if relevant): ${cappedSlugs.join(", ")}`
    : "";

  // Calculate how much room we have for content after template + slugs
  const templateTokens = estimateTokens(titleLine + modelList +
    "Content:\n\nProduce a JSON object with:\n" +
    "- \"tags\": array of 3-5 lowercase subject keywords\n" +
    "- \"brief\": a 1-2 sentence summary\n" +
    "- \"relatedModels\": array of matching slugs\nReply with ONLY the JSON object:");
  const availableTokens = MAX_INPUT_TOKENS - templateTokens;
  const maxContentChars = Math.min(CONTENT_SNIPPET_LENGTH, Math.max(400, availableTokens * 4));
  const snippet = content.slice(0, maxContentChars);

  const systemPrompt = `You analyze cached research content and produce structured metadata. Reply ONLY with valid JSON, no explanation.`;

  const prompt = `${titleLine}Content:\n${snippet}\n${modelList}

Produce a JSON object with:
- "tags": array of 3-5 lowercase subject keywords that describe this content
- "brief": a 1-2 sentence summary of what this content is about and why it matters
- "relatedModels": array of slugs from the known topics list above that this content relates to (empty array if none match)

Reply with ONLY the JSON object:`;

  const raw = await queryForEnrichment(prompt, systemPrompt, 256);
  if (!raw) return { tags: [], brief: "", relatedModels: [] };

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { tags: [], brief: "", relatedModels: [] };

    const parsed = JSON.parse(jsonMatch[0]);
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t: any) => typeof t === "string").slice(0, 5).map((t: string) => t.toLowerCase())
      : [];
    const brief = typeof parsed.brief === "string" ? parsed.brief.slice(0, 300) : "";
    const relatedModels = Array.isArray(parsed.relatedModels)
      ? parsed.relatedModels.filter((m: any) => typeof m === "string" && modelSlugs.includes(m)).slice(0, 5)
      : [];

    return { tags, brief, relatedModels };
  } catch {
    return { tags: [], brief: "", relatedModels: [] };
  }
}

// ============================================
// ENRICHMENT PIPELINE
// ============================================

/**
 * Enrich a cache entry with tags, brief, and related models via local LLM.
 * Updates both the index and the .md file's frontmatter.
 *
 * Called fire-and-forget after writeResearchCache — never blocks tool execution.
 */
export async function enrichCacheEntry(filename: string, content: string, title?: string): Promise<void> {
  try {
    // Gather recent model slugs for the LLM to match against.
    // Only top-of-mind models (most recently updated) — not the full archive.
    let modelSlugs: string[] = [];
    try {
      const l0Index = await store.getL0MemoryIndex();
      const sorted = [...l0Index.models].sort((a, b) =>
        (b.lastUpdatedAt || "").localeCompare(a.lastUpdatedAt || "")
      );
      modelSlugs = sorted.slice(0, MAX_MODEL_SLUGS).map(m => m.slug);
    } catch { /* no models yet */ }

    // Ask the LLM
    const { tags, brief, relatedModels } = await llmEnrich(content, title, modelSlugs);

    // Skip if LLM returned nothing useful
    if (tags.length === 0 && !brief) {
      console.log(`[CacheEnricher] LLM returned empty enrichment for ${filename}, skipping`);
      return;
    }

    // Update the index
    const index = await loadCacheIndex();
    const entry = index.entries.find(e => e.filename === filename);
    if (!entry) return;

    entry.tags = tags;
    entry.brief = brief;
    entry.relatedModels = relatedModels;
    entry.enriched = true;

    await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2));

    // Rewrite the .md file with enriched frontmatter
    const filePath = getCacheFilePath(filename);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const fmEnd = raw.indexOf("---", 4);
      if (fmEnd > 0) {
        const body = raw.slice(fmEnd + 3).trimStart();
        const newFm = [
          "---",
          `source: "${entry.source}"`,
          `type: ${entry.type}`,
          `tool: ${entry.tool}`,
          `cachedAt: ${entry.cachedAt}`,
        ];
        if (entry.title) newFm.push(`title: "${entry.title.replace(/"/g, '\\"')}"`);
        if (brief) newFm.push(`brief: "${brief.replace(/"/g, '\\"')}"`);
        if (tags.length) newFm.push(`tags: [${tags.map(t => `"${t}"`).join(", ")}]`);
        if (relatedModels.length) newFm.push(`relatedModels: [${relatedModels.map(m => `"${m}"`).join(", ")}]`);
        newFm.push("---");

        await fs.writeFile(filePath, `${newFm.join("\n")}\n\n${body}`, "utf-8");
      }
    } catch {
      // File rewrite failed — index is still updated, which is what matters
    }

    console.log(`[CacheEnricher] Enriched ${filename}: ${tags.length} tags, ${relatedModels.length} related models, brief=${brief.length > 0}`);
  } catch (err) {
    console.error(`[CacheEnricher] Failed to enrich ${filename}:`, err);
  }
}
