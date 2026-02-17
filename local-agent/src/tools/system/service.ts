/**
 * System Tools — Windows Services
 *
 * Handlers for service_list and service_manage.
 */

import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, runPowershell } from "../_shared/powershell.js";

export async function handleServiceList(args: Record<string, any>): Promise<ToolExecResult> {
  const filter = args.filter ? `*${sanitizeForPS(args.filter)}*` : "*";
  const statusFilter = (args.status || "all").toLowerCase();
  let psFilter = "";
  if (statusFilter === "running") psFilter = "| Where-Object { $_.Status -eq 'Running' }";
  else if (statusFilter === "stopped") psFilter = "| Where-Object { $_.Status -eq 'Stopped' }";
  return runPowershell(`Get-Service -Name '${filter}' -ErrorAction SilentlyContinue ${psFilter} | Select-Object Name, DisplayName, Status, StartType | Format-Table -AutoSize | Out-String -Width 200`);
}

export async function handleServiceManage(args: Record<string, any>): Promise<ToolExecResult> {
  const svcName = args.name;
  const svcAction = (args.action || "").toLowerCase();
  if (!svcName) return { success: false, output: "", error: "name is required" };
  if (!["start", "stop", "restart"].includes(svcAction)) {
    return { success: false, output: "", error: "action must be 'start', 'stop', or 'restart'" };
  }
  const safeSvc = sanitizeForPS(svcName);
  if (svcAction === "restart") {
    return runPowershell(`Restart-Service -Name '${safeSvc}' -Force; Get-Service -Name '${safeSvc}' | Select-Object Name, Status | Format-Table -AutoSize | Out-String`, 60_000);
  }
  const cmdlet = svcAction === "start" ? "Start-Service" : "Stop-Service";
  return runPowershell(`${cmdlet} -Name '${safeSvc}' -Force; Get-Service -Name '${safeSvc}' | Select-Object Name, Status | Format-Table -AutoSize | Out-String`, 60_000);
}
