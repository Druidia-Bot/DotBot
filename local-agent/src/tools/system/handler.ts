/**
 * System Tool Handler — Thin Dispatcher
 *
 * Routes system.* tool calls to focused submodules:
 *   process.ts       — process_list, kill_process
 *   env.ts           — env_get, env_set
 *   service.ts       — service_list, service_manage
 *   scheduled-task.ts — scheduled_task
 *   notification.ts  — notification
 *   lifecycle.ts     — restart, health_check, update, version
 */

import type { ToolExecResult } from "../_shared/types.js";
import { runPowershell } from "../_shared/powershell.js";
import { handleProcessList, handleKillProcess } from "./process.js";
import { handleEnvGet, handleEnvSet } from "./env.js";
import { handleServiceList, handleServiceManage } from "./service.js";
import { handleScheduledTask } from "./scheduled-task.js";
import { handleNotification } from "./notification.js";
import { handleRestart, handleHealthCheck, handleUpdate, handleVersion } from "./lifecycle.js";

export async function handleSystem(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "system.process_list":   return handleProcessList(args);
    case "system.kill_process":   return handleKillProcess(args);
    case "system.info":
      return runPowershell(`
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
@"
OS: $($os.Caption) $($os.Version)
CPU: $($cpu.Name)
RAM: $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) GB total, $([math]::Round($os.FreePhysicalMemory/1MB,1)) GB free
Disk C: $([math]::Round($disk.Size/1GB,1)) GB total, $([math]::Round($disk.FreeSpace/1GB,1)) GB free
Uptime: $((Get-Date) - $os.LastBootUpTime | ForEach-Object { "$($_.Days)d $($_.Hours)h $($_.Minutes)m" })
"@`.trim());
    case "system.env_get":        return handleEnvGet(args);
    case "system.env_set":        return handleEnvSet(args);
    case "system.service_list":   return handleServiceList(args);
    case "system.service_manage": return handleServiceManage(args);
    case "system.scheduled_task": return handleScheduledTask(args);
    case "system.notification":   return handleNotification(args);
    case "system.restart":        return handleRestart(args);
    case "system.health_check":   return handleHealthCheck(args);
    case "system.update":         return handleUpdate(args);
    case "system.version":        return handleVersion(args);
    default:
      return { success: false, output: "", error: `Unknown system tool: ${toolId}` };
  }
}
