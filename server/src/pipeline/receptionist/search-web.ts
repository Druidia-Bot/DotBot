/**
 * Receptionist — Web Search
 *
 * Searches the web via Brave Search for context related to the
 * current request. Also builds the web knowledge markdown file.
 */

import { createComponentLogger } from "#logging.js";
import { execToolOnAgent } from "./agent-exec.js";
import type { EnhancedPromptRequest } from "../../types/agent.js";
import type { ClassifyResult } from "../intake/intake.js";

const log = createComponentLogger("receptionist.search-web");

// ── Types ───────────────────────────────────────────────────────────

interface WebSearchPage { title: string; url: string; description: string }
export interface WebSearchQueryResult { query: string; results: WebSearchPage[] }

// ── Search ──────────────────────────────────────────────────────────

export async function searchWebForContext(
  deviceId: string,
  agentId: string,
  request: EnhancedPromptRequest,
  intakeResult: ClassifyResult,
): Promise<WebSearchQueryResult[]> {
  const queries = buildWebSearchQueries(request, intakeResult);
  if (queries.length === 0) return [];

  const allResults: WebSearchQueryResult[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    try {
      const output = await execToolOnAgent(deviceId, agentId, "search.brave",
        { query, count: 5 }, 15_000);

      if (output.includes("Brave Search API key not configured")) {
        log.info("Brave search not available — skipping web search");
        return [];
      }

      const results = parseBraveResults(output);
      const dedupedResults = results.filter(r => {
        if (seenUrls.has(r.url)) return false;
        seenUrls.add(r.url);
        return true;
      });
      if (dedupedResults.length > 0) allResults.push({ query, results: dedupedResults });
    } catch (err) {
      log.debug("Web search failed", { query, error: err });
      break;
    }
  }
  return allResults;
}

// ── Query Building ──────────────────────────────────────────────────

function buildWebSearchQueries(
  request: EnhancedPromptRequest,
  intakeResult: ClassifyResult,
): string[] {
  const queries: string[] = [];

  const approach = (intakeResult.approach as string[]) || [];
  for (const step of approach) {
    if (queries.length >= 3) break;
    if (/search|research|look\s*up|find\s+(out|info)|investigate/i.test(step)) {
      const cleaned = step
        .replace(/^(search|research|look\s*up|find|investigate)\s+(for|about|info|information|details|on)?\s*/i, "")
        .trim();
      if (cleaned.length > 5) queries.push(cleaned);
    }
  }

  if (queries.length === 0) {
    const shortPrompt = request.prompt.slice(0, 200).trim();
    if (shortPrompt.length > 5) queries.push(shortPrompt);
  }

  if (queries.length < 3) {
    const relevantMemories = (intakeResult.relevantMemories as any[]) || [];
    for (const mem of relevantMemories.slice(0, 1)) {
      if (mem.name && mem.confidence >= 0.7) {
        const already = queries.some(q => q.toLowerCase().includes(mem.name.toLowerCase()));
        if (!already) queries.push(mem.name);
      }
    }
  }
  return queries.slice(0, 3);
}

// ── Result Parsing ──────────────────────────────────────────────────

function parseBraveResults(output: string): WebSearchPage[] {
  const results: WebSearchPage[] = [];
  const blocks = output.split(/\n\d+\.\s+\*\*/);
  for (const block of blocks.slice(1)) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const title = lines[0].replace(/\*\*$/, "").trim();
    const url = lines[1];
    const description = lines.slice(2).join(" ").trim();
    if (title && url && url.startsWith("http")) results.push({ title, url, description });
  }
  return results;
}

