/**
 * System Tools — Process Management
 *
 * Handlers for process_list and kill_process.
 */

import type { ToolExecResult } from "../_shared/types.js";
import { getProtectedPids } from "../_shared/security.js";
import { sanitizeForPS, safeInt, runPowershell } from "../_shared/powershell.js";

export async function handleProcessList(args: Record<string, any>): Promise<ToolExecResult> {
  const top = safeInt(args.top, 20);
  const filter = args.filter ? `-Name "*${sanitizeForPS(args.filter)}*"` : "";
  return runPowershell(`Get-Process ${filter} | Sort-Object -Property CPU -Descending | Select-Object -First ${top} Name, Id, CPU, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String`);
}

export async function handleKillProcess(args: Record<string, any>): Promise<ToolExecResult> {
  const protectedPids = getProtectedPids();
  if (args.pid) {
    const pid = safeInt(args.pid, -1);
    if (pid < 0) return { success: false, output: "", error: "Invalid PID" };
    if (protectedPids.has(pid)) {
      return { success: false, output: "", error: `Blocked: PID ${pid} is DotBot's own process. The local agent and server must not be terminated by tool calls.` };
    }
    return runPowershell(`Stop-Process -Id ${pid} -Force`);
  }
  if (args.name) {
    const nameLower = (args.name as string).toLowerCase();
    if (nameLower === "node" || nameLower === "node.exe") {
      return { success: false, output: "", error: "Blocked: killing all 'node' processes would terminate DotBot itself. Use a specific PID instead, and verify it is not DotBot's process." };
    }
    return runPowershell(`Stop-Process -Name "${sanitizeForPS(args.name)}" -Force`);
  }
  return { success: false, output: "", error: "Provide either name or pid" };
}
