/**
 * System Tools — Environment Variables
 *
 * Handlers for env_get and env_set.
 */

import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, runPowershell } from "../_shared/powershell.js";

export async function handleEnvGet(args: Record<string, any>): Promise<ToolExecResult> {
  return { success: true, output: process.env[args.name] || `(not set: ${args.name})` };
}

export async function handleEnvSet(args: Record<string, any>): Promise<ToolExecResult> {
  const varName = args.name;
  const varValue = args.value ?? "";
  if (!varName) return { success: false, output: "", error: "name is required" };
  const level = (args.level || "process").toLowerCase();

  // Always set at process level
  process.env[varName] = varValue;

  if (level === "user") {
    // Persist to user environment (survives restarts)
    const safeName = sanitizeForPS(varName);
    const safeValue = varValue.replace(/'/g, "''");
    const result = await runPowershell(`[System.Environment]::SetEnvironmentVariable('${safeName}', '${safeValue}', 'User'); "Set ${safeName} at User level"`);
    if (!result.success) return result;
    return { success: true, output: `Set ${varName}=${varValue} (user level, persists across sessions)` };
  }
  return { success: true, output: `Set ${varName}=${varValue} (process level, current session only)` };
}
