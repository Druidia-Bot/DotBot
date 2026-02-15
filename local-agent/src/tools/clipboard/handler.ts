/**
 * Clipboard Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { runPowershell } from "../_shared/powershell.js";

export async function handleClipboard(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "clipboard.read":
      return runPowershell("Get-Clipboard");
    case "clipboard.write": {
      // Use single-quoted string with only single-quote escaping (PS single-quotes don't expand)
      const safe = (args.content || "").replace(/'/g, "''");
      return runPowershell(`Set-Clipboard -Value '${safe}'`);
    }
    default:
      return { success: false, output: "", error: `Unknown clipboard tool: ${toolId}` };
  }
}
