/**
 * Premium Tool Manifest
 * 
 * Tool definitions for premium (server-side) tools that get injected
 * into the tool manifest alongside local agent tools.
 */

import type { ToolManifestEntry } from "../agents/tools.js";

export const PREMIUM_TOOLS: ToolManifestEntry[] = [
  {
    id: "premium.list_apis",
    name: "list_premium_apis",
    description: "List all available premium APIs (powered by ScrapingDog) with their credit costs. Use this to see what premium capabilities are available before making a call.",
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
    description: "Execute a premium API call (powered by ScrapingDog). Costs credits per call. Use list_premium_apis first to see available APIs and their costs. Pass the API id and its required parameters.",
    category: "premium",
    inputSchema: {
      type: "object",
      properties: {
        api: { type: "string", description: "API id from list_premium_apis (e.g., 'google_search', 'web_scrape', 'amazon_search')" },
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
