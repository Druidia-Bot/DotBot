/**
 * Grok Search Handlers — xAI Responses API
 *
 * Server-side search tools that use Grok's built-in web_search and x_search
 * via the xAI Responses API (/v1/responses). The xAI API key lives on the
 * server, so these bypass the local agent entirely.
 *
 * Three tools:
 *   - search.grok_web  — web search via Grok
 *   - search.grok_x    — X/Twitter search via Grok
 *   - search.web       — unified: runs both in parallel, falls back gracefully
 */

import { createComponentLogger } from "#logging.js";
import { PROVIDER_CONFIGS } from "#llm/providers.js";
import { getApiKeyForProvider } from "#llm/selection/model-selector.js";
import type { ToolHandler, ToolContext } from "../types.js";

const log = createComponentLogger("tool-loop.grok-search");

const XAI_RESPONSES_URL = `${PROVIDER_CONFIGS.xai.baseUrl}/responses`;
const SEARCH_MODEL = "grok-4-1-fast-non-reasoning";
const SEARCH_TIMEOUT_MS = 60_000;

// ============================================
// TYPES
// ============================================

interface GrokSearchResult {
  text: string;
  citations: string[];
}

interface ResponsesAPIOutput {
  id: string;
  output_text?: string;
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  citations?: string[];
  error?: { message: string };
}

// ============================================
// CORE: xAI Responses API call
// ============================================

/**
 * Call the xAI Responses API with a built-in search tool.
 * Returns the model's synthesized answer + citation URLs.
 */
async function callGrokSearch(
  query: string,
  toolType: "web_search" | "x_search",
): Promise<GrokSearchResult> {
  const apiKey = getApiKeyForProvider("xai");
  if (!apiKey) {
    throw new Error("xAI API key not configured");
  }

  const body = {
    model: SEARCH_MODEL,
    tools: [{ type: toolType }],
    input: [
      {
        role: "user",
        content: query,
      },
    ],
    store: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const res = await fetch(XAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`xAI Responses API returned HTTP ${res.status}: ${errText.substring(0, 200)}`);
    }

    const json = await res.json() as ResponsesAPIOutput;

    if (json.error) {
      throw new Error(`xAI API error: ${json.error.message}`);
    }

    // Extract text from output_text (primary) or output array (fallback)
    let text = json.output_text || "";
    if (!text && json.output) {
      for (const item of json.output) {
        if (item.type === "message" && item.content) {
          for (const block of item.content) {
            if (block.type === "output_text" && block.text) {
              text += block.text;
            }
          }
        }
      }
    }

    return {
      text: text || "(No results)",
      citations: json.citations || [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================
// INDIVIDUAL HANDLERS
// ============================================

/**
 * search.grok_web — Web search via Grok's built-in web_search tool.
 */
export const handleGrokWebSearch: ToolHandler = async (_ctx: ToolContext, args: Record<string, any>) => {
  const query = args.query;
  if (!query || typeof query !== "string") {
    return "Error: Missing required field: query";
  }

  const apiKey = getApiKeyForProvider("xai");
  if (!apiKey) {
    return "⚠️ xAI API key not configured. Grok web search is unavailable. Use search.brave or search.ddg_instant instead.";
  }

  try {
    log.info("Grok web search", { query });
    const result = await callGrokSearch(query, "web_search");

    const parts = [`**Grok Web Search: "${query}"**\n`, result.text];
    if (result.citations.length > 0) {
      parts.push(`\n\n**Sources (${result.citations.length}):**`);
      for (const url of result.citations.slice(0, 15)) {
        parts.push(`- ${url}`);
      }
    }
    return parts.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("Grok web search failed", { query, error: msg });
    return `Error: Grok web search failed: ${msg}`;
  }
};

/**
 * search.grok_x — X/Twitter search via Grok's built-in x_search tool.
 */
export const handleGrokXSearch: ToolHandler = async (_ctx: ToolContext, args: Record<string, any>) => {
  const query = args.query;
  if (!query || typeof query !== "string") {
    return "Error: Missing required field: query";
  }

  const apiKey = getApiKeyForProvider("xai");
  if (!apiKey) {
    return "⚠️ xAI API key not configured. Grok X search is unavailable.";
  }

  try {
    log.info("Grok X search", { query });
    const result = await callGrokSearch(query, "x_search");

    const parts = [`**Grok X Search: "${query}"**\n`, result.text];
    if (result.citations.length > 0) {
      parts.push(`\n\n**Sources (${result.citations.length}):**`);
      for (const url of result.citations.slice(0, 15)) {
        parts.push(`- ${url}`);
      }
    }
    return parts.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("Grok X search failed", { query, error: msg });
    return `Error: Grok X search failed: ${msg}`;
  }
};

// ============================================
// UNIFIED HANDLER
// ============================================

/**
 * search.web — Unified web search.
 *
 * When xAI key is available: runs grok_web + grok_x in parallel, merges results.
 * When xAI key is missing: falls back to local-agent search tools (brave/ddg)
 * by returning a message telling the LLM to use those instead.
 */
export const handleUnifiedWebSearch: ToolHandler = async (ctx: ToolContext, args: Record<string, any>) => {
  const query = args.query;
  if (!query || typeof query !== "string") {
    return "Error: Missing required field: query";
  }

  const includeX = args.include_x !== false; // default true
  const apiKey = getApiKeyForProvider("xai");

  if (!apiKey) {
    return [
      "⚠️ xAI API key not configured — Grok search unavailable.",
      "",
      "Falling back: use **search.brave** for web results or **search.ddg_instant** for quick answers.",
    ].join("\n");
  }

  log.info("Unified web search", { query, includeX });

  // Run searches in parallel
  const searches: Promise<{ source: string; result: GrokSearchResult }>[] = [
    callGrokSearch(query, "web_search").then(r => ({ source: "web", result: r })),
  ];

  if (includeX) {
    searches.push(
      callGrokSearch(query, "x_search").then(r => ({ source: "x", result: r })),
    );
  }

  const settled = await Promise.allSettled(searches);
  const parts: string[] = [`**Web Search: "${query}"**\n`];
  const allCitations: string[] = [];
  let anySuccess = false;

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const { source, result } = outcome.value;
      anySuccess = true;
      const label = source === "web" ? "🌐 Web Results" : "𝕏 X/Twitter Results";
      parts.push(`### ${label}\n`);
      parts.push(result.text);
      parts.push("");
      allCitations.push(...result.citations);
    } else {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      log.warn("Unified search: one source failed", { reason });
    }
  }

  if (!anySuccess) {
    return `Error: All search sources failed for "${query}". Try search.brave or search.ddg_instant as fallback.`;
  }

  // Deduplicated citations
  const uniqueCitations = [...new Set(allCitations)];
  if (uniqueCitations.length > 0) {
    parts.push(`**Sources (${uniqueCitations.length}):**`);
    for (const url of uniqueCitations.slice(0, 20)) {
      parts.push(`- ${url}`);
    }
  }

  return parts.join("\n");
};
