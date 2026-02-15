/**
 * Premium Tools — API Listing
 *
 * Aggregates catalogs from all registered providers and formats
 * them into a human-readable listing grouped by category.
 * Provider-agnostic — never imports a specific provider directly.
 */

import { getBalance } from "../../credits/service.js";
import { PROVIDERS } from "./providers/index.js";
import type { PremiumApiEntry, PremiumToolResult } from "./types.js";

const CATEGORY_LABELS: Record<string, string> = {
  scraping: "Web Scraping",
  search: "Search",
  news: "News",
  images: "Images & Visual",
  video: "Video",
  ecommerce: "E-Commerce",
  social: "Social & Professional",
  local: "Maps & Local",
  finance: "Finance & Trends",
  shopping: "Shopping",
  academic: "Academic & Patents",
  jobs: "Jobs",
  travel: "Travel",
  realestate: "Real Estate",
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

function labelFor(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function listApis(userId: string): PremiumToolResult {
  const balance = getBalance(userId);

  // Collect from all providers
  const allApis: PremiumApiEntry[] = [];
  for (const provider of PROVIDERS) {
    allApis.push(...provider.getCatalog());
  }

  // Group by category
  const grouped = new Map<string, PremiumApiEntry[]>();
  for (const api of allApis) {
    const cat = api.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(api);
  }

  // Render in defined order, then any extras
  const sections: string[] = [];
  const rendered = new Set<string>();

  for (const cat of CATEGORY_ORDER) {
    const apis = grouped.get(cat);
    if (!apis || apis.length === 0) continue;
    sections.push(formatCategory(labelFor(cat), apis, balance));
    rendered.add(cat);
  }
  for (const [cat, apis] of grouped) {
    if (rendered.has(cat) || apis.length === 0) continue;
    sections.push(formatCategory(labelFor(cat), apis, balance));
  }

  return {
    success: true,
    output: [
      `**Premium APIs** — Your balance: ${balance} credits`,
      "",
      "Use `premium.execute` with `api` parameter set to the API id below:",
      "",
      ...sections,
      "",
      "Example: premium.execute({ api: \"google_search\", query: \"best restaurants in Miami\" })",
    ].join("\n"),
    creditsUsed: 0,
    creditsRemaining: balance,
  };
}

function formatCategory(label: string, apis: PremiumApiEntry[], balance: number): string {
  const lines = apis.map(api => {
    const affordable = balance >= api.creditCost ? "✓" : "✗";
    const params = api.requiredParams.length > 0
      ? `Required: ${api.requiredParams.join(", ")}`
      : "No required params";
    const optional = api.optionalParams.length > 0
      ? ` | Optional: ${api.optionalParams.join(", ")}`
      : "";
    return `  ${affordable} **${api.id}** (${api.creditCost} cr) — ${api.name}\n    ${api.description}\n    ${params}${optional}`;
  });
  return `**${label}** (${apis.length})\n${lines.join("\n")}`;
}
