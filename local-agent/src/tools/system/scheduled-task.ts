/**
 * System Tools — Windows Task Scheduler
 *
 * Handler for scheduled_task (create, list, delete).
 */

import type { ToolExecResult } from "../_shared/types.js";
import { matchesDangerousPattern } from "../_shared/security.js";
import { sanitizeForPS, runPowershell } from "../_shared/powershell.js";

export async function handleScheduledTask(args: Record<string, any>): Promise<ToolExecResult> {
  const taskAction = (args.action || "").toLowerCase();
  const folder = args.folder || "\\DotBot";

  if (taskAction === "list") {
    return runPowershell(`
try { $tasks = Get-ScheduledTask -TaskPath '${sanitizeForPS(folder)}\\' -ErrorAction Stop } catch { $tasks = @() }
if ($tasks.Count -eq 0) { "No tasks found in ${folder}" } else {
  $tasks | ForEach-Object {
    $info = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
    [PSCustomObject]@{ Name=$_.TaskName; State=$_.State; NextRun=$info.NextRunTime; LastRun=$info.LastRunTime; LastResult=$info.LastTaskResult }
  } | Format-Table -AutoSize | Out-String -Width 200
}`, 30_000);
  }

  if (taskAction === "delete") {
    const taskName = args.name;
    if (!taskName) return { success: false, output: "", error: "name is required for delete" };
    return runPowershell(`Unregister-ScheduledTask -TaskName '${sanitizeForPS(taskName)}' -TaskPath '${sanitizeForPS(folder)}\\' -Confirm:$false; "Deleted task: ${taskName}"`, 30_000);
  }

  if (taskAction === "create") {
    const taskName = args.name;
    const taskCommand = args.command;
    const trigger = args.trigger;
    if (!taskName) return { success: false, output: "", error: "name is required for create" };
    if (!taskCommand) return { success: false, output: "", error: "command is required for create" };
    if (!trigger) return { success: false, output: "", error: "trigger is required for create (e.g., 'daily 03:00', 'onlogon', 'hourly')" };

    // SECURITY: Check for dangerous PowerShell patterns in scheduled task commands
    const dangerMatch = matchesDangerousPattern(taskCommand);
    if (dangerMatch) {
      console.error(`[SECURITY] Blocked scheduled task with dangerous PowerShell pattern: ${dangerMatch}`);
      return { success: false, output: "", error: `Command blocked: contains dangerous pattern (${dangerMatch}). Scheduled tasks are persistence mechanisms and require extra scrutiny.` };
    }

    // Parse trigger into PowerShell trigger object
    const safeName = sanitizeForPS(taskName);
    const safeCmd = taskCommand.replace(/'/g, "''");
    const safeFolder = sanitizeForPS(folder);

    // SECURITY: Log all scheduled task creations prominently
    console.warn(`[SCHEDULED TASK] Creating persistent task: "${taskName}" in folder "${folder}"`);
    console.warn(`[SCHEDULED TASK] Command: ${taskCommand}`);
    console.warn(`[SCHEDULED TASK] Trigger: ${trigger}`);
    let triggerPS = "";

    if (trigger === "onlogon") {
      triggerPS = "$trigger = New-ScheduledTaskTrigger -AtLogon";
    } else if (trigger === "onstart") {
      triggerPS = "$trigger = New-ScheduledTaskTrigger -AtStartup";
    } else if (trigger === "hourly") {
      triggerPS = "$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 365)";
    } else if (trigger.startsWith("daily ")) {
      const time = trigger.substring(6).trim();
      triggerPS = `$trigger = New-ScheduledTaskTrigger -Daily -At '${sanitizeForPS(time)}'`;
    } else if (trigger.startsWith("weekly ")) {
      const parts = trigger.substring(7).trim().split(/\s+/);
      const day = parts[0] || "Monday";
      const time = parts[1] || "00:00";
      triggerPS = `$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${sanitizeForPS(day)} -At '${sanitizeForPS(time)}'`;
    } else if (trigger.startsWith("once ")) {
      const dateTime = trigger.substring(5).trim();
      triggerPS = `$trigger = New-ScheduledTaskTrigger -Once -At '${sanitizeForPS(dateTime)}'`;
    } else {
      return { success: false, output: "", error: `Unknown trigger format: '${trigger}'. Use: 'daily HH:MM', 'weekly DAY HH:MM', 'hourly', 'onlogon', 'onstart', or 'once YYYY-MM-DD HH:MM'` };
    }

    return runPowershell(`
${triggerPS}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command ''${safeCmd}'''
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName '${safeName}' -TaskPath '${safeFolder}' -Trigger $trigger -Action $action -Settings $settings -Force | Select-Object TaskName, State | Format-Table | Out-String`, 30_000);
  }

  return { success: false, output: "", error: "action must be 'create', 'list', or 'delete'" };
}
