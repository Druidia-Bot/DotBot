/**
 * Premium Tool Manifest
 * 
 * Tool definitions for premium (server-side) tools that get injected
 * into the tool manifest alongside local agent tools.
 */

import type { ToolManifestEntry } from "#tools/types.js";
import { SCRAPINGDOG_APIS } from "./providers/scrapingdog/catalog.js";

/**
 * Build a compact summary of available premium APIs grouped by category.
 * Injected into the premium.execute tool description so agents know
 * what's available without needing a discovery call.
 */
function buildApiCatalogSummary(): string {
  const grouped = new Map<string, { id: string; cost: number }[]>();
  for (const api of SCRAPINGDOG_APIS) {
    const cat = api.category || "other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push({ id: api.id, cost: api.creditCost });
  }

  const lines: string[] = [];
  for (const [cat, apis] of grouped) {
    const entries = apis.map(a => `${a.id}(${a.cost}cr)`).join(", ");
    lines.push(`${cat}: ${entries}`);
  }
  return lines.join("; ");
}

const apiSummary = buildApiCatalogSummary();

export const PREMIUM_TOOLS: ToolManifestEntry[] = [
  {
    id: "premium.list_apis",
    name: "list_premium_apis",
    description: "List all available premium APIs with their credit costs. Use this to see what premium capabilities are available before making a call.",
    category: "premium",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    id: "premium.check_credits",
    name: "check_credits",
    description: "Check the user's remaining credit balance for premium tools.",
    category: "premium",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    id: "premium.execute",
    name: "premium_execute",
    description: `Execute a premium API call. Costs credits per call. Pass the API id and its required parameters. Available APIs: ${apiSummary}. Call list_premium_apis for full details and parameter docs.`,
    category: "premium",
    inputSchema: {
      type: "object",
      properties: {
        api: { type: "string", description: "API id from the Available APIs list above" },
        query: { type: "string", description: "Search query (for search-type APIs)" },
        url: { type: "string", description: "URL to scrape (for web_scrape and screenshot APIs)" },
        asin: { type: "string", description: "Amazon ASIN (for amazon_product API)" },
        video_id: { type: "string", description: "YouTube video ID (for youtube_transcript API)" },
        country: { type: "string", description: "Country code, e.g., 'us', 'uk' (optional)" },
        language: { type: "string", description: "Language code, e.g., 'en' (optional)" },
        results: { type: "number", description: "Number of results (optional, for search APIs)" },
      },
      required: ["api"],
    },
  },
];
