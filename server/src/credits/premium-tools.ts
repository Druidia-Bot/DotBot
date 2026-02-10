/**
 * Premium Tool Catalog
 * 
 * Server-side tools that use DotBot's API keys (not the user's).
 * Each call costs credits. The server executes these directly — they never
 * reach the local agent.
 */

import * as https from "https";
import { deductCredits, getBalance, InsufficientCreditsError } from "./service.js";
import { createComponentLogger } from "../logging.js";
import { type PremiumApiEntry, SCRAPINGDOG_APIS } from "./premium-catalog.js";

const log = createComponentLogger("premium");

// ============================================
// EXECUTION
// ============================================

const SCRAPINGDOG_API_KEY = process.env.SCRAPING_DOG_API_KEY || process.env.SCRAPINGDOG_API_KEY || "";

export interface PremiumToolResult {
  success: boolean;
  output: string;
  error?: string;
  creditsUsed: number;
  creditsRemaining: number;
}

/**
 * Execute a premium tool call. Checks credits, calls ScrapingDog, deducts on success.
 */
export async function executePremiumTool(
  userId: string,
  toolId: string,
  args: Record<string, any>
): Promise<PremiumToolResult> {
  // Handle meta tools
  if (toolId === "premium.list_apis") {
    return listApis(userId);
  }

  if (toolId === "premium.check_credits") {
    const balance = getBalance(userId);
    return {
      success: true,
      output: `You have ${balance} credits remaining. New users start with 50 credits. Use premium.list_apis to see available APIs and their costs.`,
      creditsUsed: 0,
      creditsRemaining: balance,
    };
  }

  if (toolId !== "premium.execute") {
    return { success: false, output: "", error: `Unknown premium tool: ${toolId}`, creditsUsed: 0, creditsRemaining: getBalance(userId) };
  }

  // premium.execute — gateway to ScrapingDog
  const apiId = args.api;
  if (!apiId) {
    return { success: false, output: "", error: "Missing required field: api. Use premium.list_apis to see available APIs.", creditsUsed: 0, creditsRemaining: getBalance(userId) };
  }

  const api = SCRAPINGDOG_APIS.find(a => a.id === apiId);
  if (!api) {
    return { success: false, output: "", error: `Unknown API: ${apiId}. Use premium.list_apis to see available APIs.`, creditsUsed: 0, creditsRemaining: getBalance(userId) };
  }

  // Check server API key
  if (!SCRAPINGDOG_API_KEY) {
    return { success: false, output: "", error: "ScrapingDog API key not configured on the server. Contact the DotBot administrator.", creditsUsed: 0, creditsRemaining: getBalance(userId) };
  }

  // Check credits
  const balance = getBalance(userId);
  if (balance < api.creditCost) {
    return {
      success: false,
      output: "",
      error: `Insufficient credits. This API costs ${api.creditCost} credits, but you only have ${balance}. You'll need to replenish your credits to use premium tools.`,
      creditsUsed: 0,
      creditsRemaining: balance,
    };
  }

  // Validate required params
  for (const param of api.requiredParams) {
    if (!args[param]) {
      return { success: false, output: "", error: `Missing required parameter: ${param}`, creditsUsed: 0, creditsRemaining: balance };
    }
  }

  // Build the API URL
  const params = new URLSearchParams();
  params.set("api_key", SCRAPINGDOG_API_KEY);

  // Map our param names to ScrapingDog's expected params
  for (const [key, value] of Object.entries(args)) {
    if (key === "api") continue; // Skip the api selector
    if (key === "query") {
      // Most ScrapingDog APIs use 'query' or 'q' depending on endpoint
      params.set("query", String(value));
    } else {
      params.set(key, String(value));
    }
  }

  const url = `${api.endpoint}?${params.toString()}`;

  try {
    let response: string;
    if (api.method === "POST" || args.body || args.headers) {
      // POST mode: send body and headers as JSON payload
      const postPayload: Record<string, any> = { api_key: SCRAPINGDOG_API_KEY };
      for (const [key, value] of Object.entries(args)) {
        if (key === "api") continue;
        if (key === "headers" && typeof value === "string") {
          try { postPayload.headers = JSON.parse(value); } catch { postPayload.headers = value; }
        } else {
          postPayload[key] = value;
        }
      }
      response = await fetchPost(api.endpoint, postPayload);
    } else {
      response = await fetchUrl(url);
    }

    // Deduct credits on success
    const newBalance = deductCredits(
      userId,
      api.creditCost,
      `premium.${apiId}`,
      `${api.name} call`,
      { query: args.query || args.url || args.asin || "N/A" }
    );

    // Format the response
    let output: string;
    try {
      const json = JSON.parse(response);
      output = JSON.stringify(json, null, 2);
      // Truncate very large responses
      if (output.length > 10000) {
        output = output.substring(0, 10000) + "\n... (truncated, response was too large)";
      }
    } catch {
      // Not JSON — return raw (could be HTML from web_scrape)
      output = response.length > 10000
        ? response.substring(0, 10000) + "\n... (truncated)"
        : response;
    }

    log.info("Premium tool executed", { userId, apiId, creditCost: api.creditCost, newBalance });

    return {
      success: true,
      output: `[${api.name}] (${api.creditCost} credits used, ${newBalance} remaining)\n\n${output}`,
      creditsUsed: api.creditCost,
      creditsRemaining: newBalance,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn("Premium tool failed", { userId, apiId, error: msg });
    // Don't deduct credits on failure
    return { success: false, output: "", error: `${api.name} failed: ${msg}`, creditsUsed: 0, creditsRemaining: balance };
  }
}

// ============================================
// LIST APIs
// ============================================

// Category grouping for display
const API_CATEGORIES: { label: string; prefix: string[] }[] = [
  { label: "Web Scraping", prefix: ["web_scrape", "screenshot"] },
  { label: "Google", prefix: ["google_"] },
  { label: "Other Search Engines", prefix: ["bing_", "duckduckgo_", "universal_", "baidu_"] },
  { label: "E-Commerce", prefix: ["amazon_", "walmart_", "ebay_", "flipkart_", "myntra_"] },
  { label: "Social & Professional", prefix: ["linkedin_", "twitter_"] },
  { label: "Video", prefix: ["youtube_"] },
  { label: "Jobs & Real Estate", prefix: ["indeed_", "zillow_"] },
  { label: "Local & Reviews", prefix: ["yelp_"] },
];

function categorizeApi(id: string): string {
  for (const cat of API_CATEGORIES) {
    if (cat.prefix.some(p => id === p || id.startsWith(p))) return cat.label;
  }
  return "Other";
}

function listApis(userId: string): PremiumToolResult {
  const balance = getBalance(userId);

  // Group by category
  const grouped = new Map<string, PremiumApiEntry[]>();
  for (const cat of API_CATEGORIES) grouped.set(cat.label, []);
  for (const api of SCRAPINGDOG_APIS) {
    const cat = categorizeApi(api.id);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(api);
  }

  const sections: string[] = [];
  for (const [category, apis] of grouped) {
    if (apis.length === 0) continue;
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
    sections.push(`**${category}** (${apis.length})\n${lines.join("\n")}`);
  }

  return {
    success: true,
    output: [
      `**Premium APIs** (ScrapingDog) — Your balance: ${balance} credits`,
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

// ============================================
// HTTP HELPER
// ============================================

function fetchPost(endpoint: string, body: Record<string, any>, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(endpoint);
    const data = JSON.stringify(body);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: "POST",
      timeout,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let respBody = "";
        res.on("data", (chunk: Buffer) => { respBody += chunk.toString(); });
        res.on("end", () => {
          reject(new Error(`HTTP ${res.statusCode}: ${respBody.substring(0, 500)}`));
        });
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      res.on("end", () => {
        let respBuf = Buffer.concat(chunks);
        if (res.headers["content-encoding"] === "gzip") {
          try {
            const zlib = require("zlib");
            respBuf = zlib.gunzipSync(respBuf);
          } catch { /* use raw */ }
        }
        resolve(respBuf.toString());
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out (60s)"));
    });
    req.write(data);
    req.end();
  });
}

function fetchUrl(url: string, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 500)}`));
        });
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      res.on("end", () => {
        let body = Buffer.concat(chunks);
        // Handle gzip
        if (res.headers["content-encoding"] === "gzip") {
          try {
            const zlib = require("zlib");
            body = zlib.gunzipSync(body);
          } catch { /* use raw */ }
        }
        resolve(body.toString());
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out (60s)"));
    });
  });
}
