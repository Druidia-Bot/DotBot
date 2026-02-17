/**
 * Brave Search API handler.
 */

import type { ToolExecResult } from "../_shared/types.js";
import { credentialProxyFetch } from "../../credential-proxy.js";

const BRAVE_API_BASE = "https://api.search.brave.com";
const BRAVE_CREDENTIAL_NAME = "BRAVE_SEARCH_API_KEY";

export async function handleBraveSearch(args: Record<string, any>): Promise<ToolExecResult> {
  if (!args.query) return { success: false, output: "", error: "Missing required field: query" };

  // Check if credential is configured via vault
  const { vaultHas } = await import("../../credential-vault.js");
  const hasKey = await vaultHas(BRAVE_CREDENTIAL_NAME);

  if (!hasKey) {
    return {
      success: true,
      output: [
        "⚠️ Brave Search API key not configured.",
        "",
        "Brave Search provides full web search results (2,000 free queries/month).",
        "",
        "To set it up, just say: **\"set up brave search\"** and I'll walk you through it.",
        "",
        "In the meantime, I'll use ddg_instant for quick lookups, or http_request to query specific APIs directly.",
      ].join("\n"),
    };
  }

  const count = Math.min(args.count || 5, 20);
  const searchQuery = encodeURIComponent(args.query);
  const searchPath = `/res/v1/web/search?q=${searchQuery}&count=${count}`;

  try {
    const res = await credentialProxyFetch(searchPath, BRAVE_CREDENTIAL_NAME, {
      baseUrl: BRAVE_API_BASE,
      method: "GET",
      headers: { "Accept": "application/json" },
      placement: { header: "X-Subscription-Token", prefix: "" },
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { success: false, output: "", error: "Brave Search API key is invalid or expired. Re-enter it by saying \"set up brave search\"." };
      }
      return { success: false, output: "", error: `Brave Search returned HTTP ${res.status}: ${res.body.substring(0, 200)}` };
    }

    const json = JSON.parse(res.body);
    if (json.web && json.web.results && json.web.results.length > 0) {
      const results = json.web.results.map((r: any, i: number) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || ""}`
      ).join("\n\n");
      const output = `**Web results for "${args.query}":**\n\n${results}`;

      return { success: true, output };
    } else {
      return { success: true, output: `No web results found for "${args.query}".` };
    }
  } catch (err) {
    return { success: false, output: "", error: `Brave Search request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
