/**
 * Search Tool Handler — thin router delegating to per-tool modules.
 */

import type { ToolExecResult } from "../_shared/types.js";
import { handleDdgInstant } from "./ddg-instant.js";
import { handleBraveSearch } from "./brave.js";
import { handleBackgroundSearch, handleCheckResults } from "./background.js";
import { handleFileSearch } from "./file-search.js";

export { BOT_ES_PATH, ensureEverythingSearch } from "./everything-install.js";

export async function handleSearch(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "search.ddg_instant":   return handleDdgInstant(args);
    case "search.brave":         return handleBraveSearch(args);
    case "search.background":    return handleBackgroundSearch(args);
    case "search.check_results": return handleCheckResults(args);
    case "search.files":         return handleFileSearch(args);
    default:
      return { success: false, output: "", error: `Unknown search tool: ${toolId}` };
  }
}
