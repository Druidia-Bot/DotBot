/**
 * Receptionist — Polymarket Prediction Market Search
 *
 * Searches Polymarket for prediction markets related to the
 * current request. Uses the existing market.polymarket_search
 * tool on the local agent (Gamma API, no auth required).
 */

import { createComponentLogger } from "../logging.js";
import { execToolOnAgent } from "./agent-exec.js";
import type { ILLMClient } from "../llm/types.js";
import type { EnhancedPromptRequest } from "../types/agent.js";
import type { ClassifyResult } from "../intake/intake.js";

const log = createComponentLogger("receptionist.search-polymarket");

// ── Types ───────────────────────────────────────────────────────────

export interface PolymarketResult { query: string; markets: any[] }

// ── Search ──────────────────────────────────────────────────────────

export async function searchPolymarket(
  llm: ILLMClient,
  deviceId: string,
  agentId: string,
  request: EnhancedPromptRequest,
  intakeResult: ClassifyResult,
): Promise<PolymarketResult[]> {
  const queries = buildPolymarketQueries(request, intakeResult);
  if (queries.length === 0) return [];

  // Phase 1: Collect all markets across queries, deduplicating
  const seenQuestions = new Set<string>();
  const allMarkets: { query: string; market: any }[] = [];

  for (const query of queries) {
    try {
      const output = await execToolOnAgent(deviceId, agentId, "market.polymarket_search",
        { query, limit: 5 }, 15_000);

      if (output.startsWith("No Polymarket") || output.startsWith("Error") || !output.trim()) continue;

      let markets: any[];
      try {
        markets = JSON.parse(output);
        if (!Array.isArray(markets)) continue;
      } catch {
        continue;
      }

      for (const m of markets) {
        const q = m.question || "";
        if (!seenQuestions.has(q)) {
          seenQuestions.add(q);
          allMarkets.push({ query, market: m });
        }
      }
    } catch (err) {
      log.debug("Polymarket search failed", { query, error: err });
      break;
    }
  }

  if (allMarkets.length === 0) return [];

  // Phase 2: LLM-based relevance filtering (single batch call)
  const relevantIndices = await filterMarketsWithLLM(
    llm, request, intakeResult, allMarkets.map(m => m.market.question || ""),
  );

  // Phase 3: Group relevant markets back by query
  const resultsByQuery = new Map<string, any[]>();
  for (const idx of relevantIndices) {
    const { query, market } = allMarkets[idx];
    if (!resultsByQuery.has(query)) resultsByQuery.set(query, []);
    resultsByQuery.get(query)!.push(market);
  }

  const allResults: PolymarketResult[] = [];
  for (const [query, markets] of resultsByQuery) {
    allResults.push({ query, markets });
  }

  log.info("Polymarket relevance filter", {
    total: allMarkets.length,
    relevant: relevantIndices.length,
    queries: allResults.length,
  });

  return allResults;
}

// ── Query Building ──────────────────────────────────────────────────────

function buildPolymarketQueries(
  _request: EnhancedPromptRequest,
  intakeResult: ClassifyResult,
): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  const addQuery = (q: string) => {
    const trimmed = q.slice(0, 80).trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length < 3 || seen.has(key)) return;
    seen.add(key);
    queries.push(trimmed);
  };

  // Primary: use the intake's LLM-generated web search queries
  // These are already short, topic-focused phrases
  const webSearch = intakeResult.webSearch as { helpful?: boolean; queries?: string[] } | undefined;
  if (webSearch?.helpful && webSearch.queries) {
    for (const q of webSearch.queries.slice(0, 3)) {
      addQuery(q);
    }
  }

  // Secondary: relevant memory model names (short topic labels)
  const relevantMemories = (intakeResult.relevantMemories as any[]) || [];
  for (const mem of relevantMemories.slice(0, 2)) {
    if (mem.name && mem.confidence >= 0.6 && queries.length < 3) {
      addQuery(mem.name);
    }
  }

  return queries.slice(0, 3);
}

// ── LLM Relevance Filter ──────────────────────────────────────────────

const RELEVANCE_TIMEOUT_MS = 10_000;

/**
 * Use the LLM to determine which prediction markets are actually relevant
 * to the user's request. Returns indices of relevant markets.
 */
async function filterMarketsWithLLM(
  llm: ILLMClient,
  request: EnhancedPromptRequest,
  intakeResult: ClassifyResult,
  marketQuestions: string[],
): Promise<number[]> {
  if (marketQuestions.length === 0) return [];

  const restated = (intakeResult.restatedRequest as string) || request.prompt;
  const numbered = marketQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n");

  const prompt = [
    `User's request: "${restated.slice(0, 300)}"`,
    "",
    "The following prediction markets were found. Which ones are genuinely relevant to the user's request?",
    "A market is relevant if its outcome would meaningfully inform or impact what the user is asking about.",
    "",
    numbered,
    "",
    "Reply with ONLY the numbers of relevant markets, comma-separated. If none are relevant, reply with: NONE",
  ].join("\n");

  try {
    const response = await Promise.race([
      llm.chat(
        [
          { role: "system", content: "You filter prediction market results for relevance. Reply with only comma-separated numbers or NONE. No explanation." },
          { role: "user", content: prompt },
        ],
        { temperature: 0, maxTokens: 50 },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM relevance filter timed out")), RELEVANCE_TIMEOUT_MS)
      ),
    ]);

    const text = (response.content || "").trim().toUpperCase();
    if (text === "NONE" || !text) return [];

    // Parse comma-separated numbers (1-indexed from prompt → 0-indexed)
    return text
      .split(/[,\s]+/)
      .map(s => parseInt(s, 10) - 1)
      .filter(n => !isNaN(n) && n >= 0 && n < marketQuestions.length);
  } catch (err) {
    log.debug("LLM relevance filter failed, including all markets", { error: err });
    // On LLM failure, include all markets rather than discard blindly
    return marketQuestions.map((_, i) => i);
  }
}
