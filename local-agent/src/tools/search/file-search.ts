/**
 * Everything file search handler (es.exe).
 */

import type { ToolExecResult } from "../_shared/types.js";
import { BOT_ES_PATH, ensureEverythingSearch } from "./everything-install.js";

let esInstallAttempted = false;

export async function handleFileSearch(args: Record<string, any>): Promise<ToolExecResult> {
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
