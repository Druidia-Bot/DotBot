/**
 * Tool Handlers — Web & Search
 *
 * HTTP requests, browser control, and search engine integrations.
 */

import * as https from "https";
import * as zlib from "zlib";
import { promises as fs } from "fs";
import { dirname } from "path";
import type { ToolExecResult } from "./tool-executor.js";
import {
  resolvePath,
  isAllowedUrl,
  isAllowedWrite,
  safeInt,
  sanitizeForPS,
  knownFolders,
} from "./tool-executor.js";
import { credentialProxyFetch } from "../credential-proxy.js";

const BRAVE_API_BASE = "https://api.search.brave.com";
const BRAVE_CREDENTIAL_NAME = "BRAVE_SEARCH_API_KEY";

// ============================================
// HTTP HANDLERS
// ============================================

export async function handleHttp(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "http.render": {
      if (!args.url) {
        return { success: false, output: "", error: "URL is required" };
      }
      // Lazy import to avoid loading Playwright until needed
      const { headlessBridge } = await import("./gui/headless-bridge.js");
      try {
        // Navigate using the browser bridge (handles URL sanitization + bot challenge detection)
        const navResult = await headlessBridge.navigate({ url: args.url });

        // Wait extra time for JS frameworks to finish rendering
        const waitMs = Math.min(Math.max(args.wait_ms || 2000, 0), 15000);
        await new Promise(resolve => setTimeout(resolve, waitMs));

        // Read the rendered page state (ARIA snapshot = full rendered text)
        const stateJson = await headlessBridge.readState({});
        let state: any;
        try { state = JSON.parse(stateJson); } catch { state = {}; }

        // Extract clean text content from the page
        const page = await headlessBridge.getActivePage();
        const textContent = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
        const truncated = textContent.length > 80_000
          ? textContent.substring(0, 80_000) + "\n...[truncated at 80K chars]"
          : textContent;

        return {
          success: true,
          output: JSON.stringify({
            url: state.url || args.url,
            title: state.title || "",
            rendered_text: truncated,
            aria_snapshot: state.aria_snapshot || "",
            char_count: textContent.length,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: `Browser render failed: ${err.message || String(err)}` };
      }
    }
    case "http.request": {
      if (!args.url || !isAllowedUrl(args.url)) {
        return { success: false, output: "", error: "URL must be http/https to a public host (no localhost, private IPs, or cloud metadata)" };
      }
      const method = (args.method || "GET").toUpperCase();
      const timeout = safeInt(args.timeout, 30_000);
      const headers: Record<string, string> = args.headers || {};
      if (args.auth) headers["Authorization"] = args.auth;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const fetchOpts: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };
        if (args.body && ["POST", "PUT", "PATCH"].includes(method)) {
          fetchOpts.body = args.body;
          if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
        }

        const response = await fetch(args.url, fetchOpts);
        clearTimeout(timer);

        const text = await response.text();
        const truncated = text.length > 50_000 ? text.substring(0, 50_000) + "\n...[truncated]" : text;

        return {
          success: response.ok,
          output: `HTTP ${response.status} ${response.statusText}\n\n${truncated}`,
          error: response.ok ? undefined : `HTTP ${response.status}`,
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message || String(err) };
      }
    }
    case "http.download": {
      if (!args.url || !isAllowedUrl(args.url)) {
        return { success: false, output: "", error: "URL must be http/https to a public host (no localhost, private IPs, or cloud metadata)" };
      }
      const destPath = resolvePath(args.path);
      if (!isAllowedWrite(destPath)) return { success: false, output: "", error: `Write access denied: ${destPath}` };

      try {
        const response = await fetch(args.url);
        if (!response.ok) return { success: false, output: "", error: `HTTP ${response.status}` };

        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.mkdir(dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, buffer);
        return { success: true, output: `Downloaded ${buffer.length} bytes to ${destPath}` };
      } catch (err: any) {
        return { success: false, output: "", error: err.message || String(err) };
      }
    }
    default:
      return { success: false, output: "", error: `Unknown http tool: ${toolId}` };
  }
}

// ============================================
// BROWSER HANDLERS
// ============================================

export async function handleBrowser(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "browser.open_url": {
      // Only validate protocol — browser opens in user's own browser, not a server fetch
      // Localhost is allowed (dev workflows). Only block non-http protocols (file://, etc.)
      try {
        const url = new URL(args.url || "");
        if (!["http:", "https:"].includes(url.protocol)) {
          return { success: false, output: "", error: `Only http:// and https:// URLs are allowed (got ${url.protocol})` };
        }
      } catch {
        return { success: false, output: "", error: "Invalid URL" };
      }
      const { runPowershell } = await import("./tool-executor.js");
      return runPowershell(`Start-Process "${sanitizeForPS(args.url)}"`);
    }
    default:
      return { success: false, output: "", error: `Unknown browser tool: ${toolId}` };
  }
}

// ============================================
// SEARCH HANDLERS
// ============================================

export async function handleSearch(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "search.ddg_instant": {
      if (!args.query) return { success: false, output: "", error: "Missing required field: query" };

      const query = encodeURIComponent(args.query);
      const url = `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`;

      return new Promise((resolve) => {
        https.get(url, (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              const parts: string[] = [];

              // Abstract (Wikipedia-style summary)
              if (json.AbstractText) {
                parts.push(`**Summary**: ${json.AbstractText}`);
                if (json.AbstractSource) parts.push(`Source: ${json.AbstractSource} — ${json.AbstractURL}`);
              }

              // Direct answer (calculations, conversions, etc.)
              if (json.Answer) {
                parts.push(`**Answer**: ${json.Answer}`);
              }

              // Definition
              if (json.Definition) {
                parts.push(`**Definition**: ${json.Definition}`);
                if (json.DefinitionSource) parts.push(`Source: ${json.DefinitionSource}`);
              }

              // Related topics (up to 5)
              if (json.RelatedTopics && json.RelatedTopics.length > 0) {
                const topics = json.RelatedTopics
                  .filter((t: any) => t.Text)
                  .slice(0, 5)
                  .map((t: any) => `- ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ""}`);
                if (topics.length > 0) {
                  parts.push(`\n**Related Topics**:\n${topics.join("\n")}`);
                }
              }

              // Infobox
              if (json.Infobox && json.Infobox.content && json.Infobox.content.length > 0) {
                const info = json.Infobox.content
                  .slice(0, 8)
                  .map((item: any) => `- ${item.label}: ${item.value}`)
                  .join("\n");
                parts.push(`\n**Info**:\n${info}`);
              }

              if (parts.length === 0) {
                resolve({ success: true, output: `No instant answer found for "${args.query}". Try rephrasing, or use brave_search for full web results.` });
              } else {
                resolve({ success: true, output: parts.join("\n") });
              }
            } catch {
              resolve({ success: false, output: "", error: "Failed to parse DuckDuckGo response" });
            }
          });
          res.on("error", (err: Error) => {
            resolve({ success: false, output: "", error: `DuckDuckGo request failed: ${err.message}` });
          });
        }).on("error", (err: Error) => {
          resolve({ success: false, output: "", error: `DuckDuckGo request failed: ${err.message}` });
        });
      });
    }

    case "search.brave": {
      if (!args.query) return { success: false, output: "", error: "Missing required field: query" };

      // Check if credential is configured via vault
      const { vaultHas } = await import("../credential-vault.js");
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
          return { success: true, output: `**Web results for "${args.query}":**\n\n${results}` };
        } else {
          return { success: true, output: `No web results found for "${args.query}".` };
        }
      } catch (err) {
        return { success: false, output: "", error: `Brave Search request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "search.background": {
      if (!args.type) return { success: false, output: "", error: "Missing required field: type" };
      if (!args.query) return { success: false, output: "", error: "Missing required field: query" };

      const validTypes = ["file_content", "deep_memory", "archived_threads"];
      if (!validTypes.includes(args.type)) {
        return { success: false, output: "", error: `Invalid search type: ${args.type}. Must be one of: ${validTypes.join(", ")}` };
      }

      const { startBackgroundSearch } = await import("./background-search.js");
      const taskId = startBackgroundSearch(args.type, args.query);

      return {
        success: true,
        output: `Background search started.\n\nTask ID: ${taskId}\nType: ${args.type}\nQuery: "${args.query}"\n\nUse search.check_results with task_id="${taskId}" to poll for results.`,
      };
    }

    case "search.check_results": {
      if (!args.task_id) return { success: false, output: "", error: "Missing required field: task_id" };

      const { checkSearchResults } = await import("./background-search.js");
      const task = checkSearchResults(args.task_id);

      if (!task) {
        return { success: false, output: "", error: `No search task found with ID: ${args.task_id}` };
      }

      if (task.status === "running") {
        const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
        return {
          success: true,
          output: `Search still running (${elapsed}s elapsed).\nType: ${task.type}\nQuery: "${task.query}"\n\nCheck again shortly with search.check_results({ task_id: "${task.id}" }).`,
        };
      }

      if (task.status === "error") {
        return { success: false, output: "", error: `Search failed: ${task.error}` };
      }

      const elapsed = task.completedAt ? Math.round((task.completedAt - task.startedAt) / 1000) : 0;
      return {
        success: true,
        output: `Search complete (${elapsed}s, ${task.resultCount || 0} results).\nType: ${task.type}\nQuery: "${task.query}"\n\n${task.results || "No results."}`,
      };
    }

    case "search.files": {
      if (!args.query) return { success: false, output: "", error: "Missing required field: query" };

      const maxResults = Math.min(args.max_results || 50, 200);
      const matchPath = args.match_path || false;

      // Build es.exe arguments
      const esArgs: string[] = [];
      esArgs.push("-n", String(maxResults));

      // Sort order
      const sort = args.sort || "date-modified";
      switch (sort) {
        case "name": esArgs.push("-sort", "name"); break;
        case "path": esArgs.push("-sort", "path"); break;
        case "size": esArgs.push("-sort", "size"); break;
        case "date-modified": esArgs.push("-sort", "dm"); break;
      }

      if (matchPath) esArgs.push("-match-path");

      // Output size and date modified
      esArgs.push("-size", "-dm");

      esArgs.push(args.query);

      try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);

        // Try es.exe directly (if in PATH), then common install locations
        const esPaths = [
          "es.exe",
          "C:\\Program Files\\Everything\\es.exe",
          "C:\\Program Files (x86)\\Everything\\es.exe",
        ];

        let result: { stdout: string; stderr: string } | null = null;
        let lastError: string = "";

        for (const esPath of esPaths) {
          try {
            result = await execFileAsync(esPath, esArgs, {
              timeout: 10000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
            });
            break;
          } catch (err: any) {
            if (err.code === "ENOENT") {
              lastError = "not found";
              continue;
            }
            // es.exe found but returned an error
            lastError = err.stderr || err.message || String(err);
            break;
          }
        }

        if (!result && lastError === "not found") {
          return {
            success: false,
            output: "",
            error: [
              "Everything search (es.exe) is not installed or not in PATH.",
              "",
              "To install:",
              "1. Download Everything from https://www.voidtools.com/downloads/",
              "2. Install it (the service runs in the background and indexes all NTFS drives)",
              "3. Download the command-line interface (es.exe) from https://www.voidtools.com/downloads/#cli",
              "4. Place es.exe in your PATH or in the Everything install directory",
              "",
              "Everything must be running for file search to work.",
            ].join("\n"),
          };
        }

        if (!result) {
          return { success: false, output: "", error: `Everything search failed: ${lastError}` };
        }

        const lines = result.stdout.trim().split("\n").filter(Boolean);
        if (lines.length === 0) {
          return { success: true, output: `No files found matching "${args.query}".` };
        }

        return {
          success: true,
          output: `Found ${lines.length} file(s) matching "${args.query}":\n\n${lines.join("\n")}`,
        };
      } catch (err) {
        return { success: false, output: "", error: `File search failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    default:
      return { success: false, output: "", error: `Unknown search tool: ${toolId}` };
  }
}
