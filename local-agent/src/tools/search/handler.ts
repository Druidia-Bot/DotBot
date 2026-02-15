/**
 * Search Tool Handler
 */

import * as https from "https";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import type { ToolExecResult } from "../_shared/types.js";
import { credentialProxyFetch } from "../../credential-proxy.js";

const BRAVE_API_BASE = "https://api.search.brave.com";
const BRAVE_CREDENTIAL_NAME = "BRAVE_SEARCH_API_KEY";

const BOT_BIN_DIR = join(homedir(), ".bot", "bin");
export const BOT_ES_PATH = join(BOT_BIN_DIR, "es.exe");

let esInstallAttempted = false;

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

      const { startBackgroundSearch } = await import("../background-search.js");
      const taskId = startBackgroundSearch(args.type, args.query);

      return {
        success: true,
        output: `Background search started.\n\nTask ID: ${taskId}\nType: ${args.type}\nQuery: "${args.query}"\n\nUse search.check_results with task_id="${taskId}" to poll for results.`,
      };
    }

    case "search.check_results": {
      if (!args.task_id) return { success: false, output: "", error: "Missing required field: task_id" };

      const { checkSearchResults } = await import("../background-search.js");
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

        // Try es.exe directly (if in PATH), then common install locations, then ~/.bot/bin
        const esPaths = [
          "es.exe",
          "C:\\Program Files\\Everything\\es.exe",
          "C:\\Program Files (x86)\\Everything\\es.exe",
          BOT_ES_PATH,
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
          // Auto-install: download es.exe + ensure Everything is running
          if (!esInstallAttempted) {
            esInstallAttempted = true;
            const installedPath = await ensureEverythingSearch();
            if (installedPath) {
              // Retry with the newly installed es.exe
              try {
                result = await execFileAsync(installedPath, esArgs, {
                  timeout: 10000,
                  maxBuffer: 1024 * 1024,
                  windowsHide: true,
                });
              } catch (retryErr: any) {
                return { success: false, output: "", error: `Everything search installed but query failed: ${retryErr.message || retryErr}` };
              }
            }
          }

          if (!result) {
            return {
              success: false,
              output: "",
              error: [
                "Everything search (es.exe) could not be auto-installed.",
                "",
                "To install manually:",
                "1. Download Everything from https://www.voidtools.com/downloads/",
                "2. Install it (the service runs in the background and indexes all NTFS drives)",
                "3. Download the command-line interface (es.exe) from https://www.voidtools.com/downloads/#cli",
                "4. Place es.exe in your PATH or in the Everything install directory",
                "",
                "Everything must be running for file search to work.",
              ].join("\n"),
            };
          }
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

// ============================================
// EVERYTHING SEARCH AUTO-INSTALL
// ============================================

const ES_CLI_URL = "https://www.voidtools.com/ES-1.1.0.30.x64.zip";

/**
 * Attempt to auto-install Everything Search + es.exe CLI.
 * 1. Download es.exe CLI to ~/.bot/bin/
 * 2. Check if Everything is running; if not, try winget install
 * Returns the path to es.exe on success, null on failure.
 */
export async function ensureEverythingSearch(): Promise<string | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  console.log("[search.files] es.exe not found — attempting auto-install...");

  // Step 1: Download es.exe CLI to ~/.bot/bin/
  if (!existsSync(BOT_ES_PATH)) {
    try {
      mkdirSync(BOT_BIN_DIR, { recursive: true });
      const psScript = [
        "$ErrorActionPreference = 'Stop'",
        `$zipUrl = '${ES_CLI_URL}'`,
        "$zipPath = Join-Path $env:TEMP 'dotbot_es_cli.zip'",
        `$destDir = '${BOT_BIN_DIR.replace(/\\/g, "\\\\")}'`,
        "Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing",
        "Expand-Archive -Path $zipPath -DestinationPath $destDir -Force",
        "Remove-Item $zipPath -Force",
      ].join("; ");

      await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
        timeout: 60_000,
        windowsHide: true,
      });
      console.log("[search.files] es.exe downloaded to", BOT_BIN_DIR);
    } catch (err: any) {
      console.error("[search.files] Failed to download es.exe:", err.message || err);
      return null;
    }
  }

  if (!existsSync(BOT_ES_PATH)) {
    console.error("[search.files] es.exe not found after download attempt");
    return null;
  }

  // Step 2: Check if Everything is running
  let everythingRunning = false;
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq Everything.exe", "/NH"], {
      timeout: 5_000,
      windowsHide: true,
    });
    everythingRunning = stdout.toLowerCase().includes("everything.exe");
  } catch {
    // tasklist failed — can't determine
  }

  if (!everythingRunning) {
    console.log("[search.files] Everything not running — attempting winget install...");
    try {
      await execFileAsync("winget", [
        "install", "voidtools.Everything",
        "--accept-package-agreements", "--accept-source-agreements",
        "--silent",
      ], { timeout: 120_000, windowsHide: true });
      console.log("[search.files] Everything installed via winget");
      // Give the service a moment to start and begin indexing
      await new Promise(r => setTimeout(r, 3_000));
    } catch (err: any) {
      console.error("[search.files] winget install failed:", err.message || err);

      // Try starting Everything if it was already installed but not running
      const everythingPaths = [
        "C:\\Program Files\\Everything\\Everything.exe",
        "C:\\Program Files (x86)\\Everything\\Everything.exe",
      ];
      for (const p of everythingPaths) {
        if (existsSync(p)) {
          try {
            await execFileAsync(p, ["-startup"], { timeout: 5_000, windowsHide: true });
            console.log("[search.files] Started Everything from", p);
            await new Promise(r => setTimeout(r, 2_000));
            everythingRunning = true;
            break;
          } catch { /* ignore */ }
        }
      }

      if (!everythingRunning) {
        console.error("[search.files] Everything is not installed and could not be auto-installed");
        return null;
      }
    }
  }

  return BOT_ES_PATH;
}
