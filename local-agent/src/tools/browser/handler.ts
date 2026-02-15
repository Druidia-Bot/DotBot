/**
 * Browser Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, runPowershell } from "../_shared/powershell.js";

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
      return runPowershell(`Start-Process "${sanitizeForPS(args.url)}"`);
    }
    default:
      return { success: false, output: "", error: `Unknown browser tool: ${toolId}` };
  }
}
