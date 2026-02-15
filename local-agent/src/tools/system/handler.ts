/**
 * System Tool Handler
 */

import { join } from "path";
import type { ToolExecResult } from "../_shared/types.js";
import { getProtectedPids, matchesDangerousPattern } from "../_shared/security.js";
import { sanitizeForPS, safeInt, runPowershell } from "../_shared/powershell.js";
import { isRuntimeAvailable, runPreRestartHook } from "../tool-executor.js";

export async function handleSystem(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "system.process_list": {
      const top = safeInt(args.top, 20);
      const filter = args.filter ? `-Name "*${sanitizeForPS(args.filter)}*"` : "";
      return runPowershell(`Get-Process ${filter} | Sort-Object -Property CPU -Descending | Select-Object -First ${top} Name, Id, CPU, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String`);
    }
    case "system.kill_process": {
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
    case "system.env_get":
      return { success: true, output: process.env[args.name] || `(not set: ${args.name})` };
    case "system.env_set": {
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
    case "system.service_list": {
      const filter = args.filter ? `*${sanitizeForPS(args.filter)}*` : "*";
      const statusFilter = (args.status || "all").toLowerCase();
      let psFilter = "";
      if (statusFilter === "running") psFilter = "| Where-Object { $_.Status -eq 'Running' }";
      else if (statusFilter === "stopped") psFilter = "| Where-Object { $_.Status -eq 'Stopped' }";
      return runPowershell(`Get-Service -Name '${filter}' -ErrorAction SilentlyContinue ${psFilter} | Select-Object Name, DisplayName, Status, StartType | Format-Table -AutoSize | Out-String -Width 200`);
    }
    case "system.service_manage": {
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
    case "system.scheduled_task": {
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
    case "system.notification": {
      const title = args.title || "DotBot";
      const message = args.message || "";
      if (!message) return { success: false, output: "", error: "message is required" };

      // M-07 fix: Escape XML special characters first, then PowerShell quotes
      const xmlEscape = (str: string) => str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

      const safeTitle = xmlEscape(title);
      const safeMsg = xmlEscape(message);
      return runPowershell(`
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>${safeTitle}</text>
      <text>${safeMsg}</text>
    </binding>
  </visual>
</toast>
"@
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DotBot').Show($toast)
"Notification sent: ${safeTitle}"`, 15_000);
    }
    case "system.restart": {
      const reason = args.reason || "No reason provided";
      console.log(`[System] Restart requested: ${reason}`);
      // Cancel server-side tasks before exiting so they don't run against a dead agent
      setTimeout(async () => {
        try {
          console.log("[System] Cancelling server tasks before restart...");
          await runPreRestartHook();
        } catch (err) {
          console.error("[System] Pre-restart hook failed (proceeding with restart):", err);
        }
        console.log("[System] Exiting with code 42 (restart signal)...");
        process.exit(42);
      }, 500);
      return { success: true, output: `Restart initiated: ${reason}. The agent will restart momentarily.` };
    }
    case "system.health_check": {
      const checks: { name: string; status: string; detail: string }[] = [];
      const check = async (name: string, cmd: string) => {
        try {
          const r = await runPowershell(cmd, 10_000);
          checks.push({ name, status: r.success ? "pass" : "fail", detail: r.output.trim() || r.error || "" });
        } catch {
          checks.push({ name, status: "fail", detail: "check timed out" });
        }
      };
      await check("Node.js", "node --version");
      await check("Git", "git --version");
      await check("Python", "python --version 2>&1");
      await check("Tesseract", "tesseract --version 2>&1 | Select-Object -First 1");
      await check("~/.bot/ directory", `if (Test-Path (Join-Path $env:USERPROFILE '.bot')) { 'exists' } else { throw 'missing' }`);
      await check("Memory system", `if (Test-Path (Join-Path $env:USERPROFILE '.bot/memory/index.json')) { 'initialized' } else { 'not initialized' }`);
      await check("Skills directory", `(Get-ChildItem (Join-Path $env:USERPROFILE '.bot/skills') -Directory).Count.ToString() + ' skills installed'`);
      await check("Discord config", `if ($env:DISCORD_BOT_TOKEN -or (Select-String -Path (Join-Path $env:USERPROFILE '.bot/.env') -Pattern 'DISCORD_BOT_TOKEN' -Quiet -ErrorAction SilentlyContinue)) { 'configured' } else { 'not configured' }`);
      await check("Server connection", `'Connected to ' + $env:DOTBOT_SERVER`);

      const passed = checks.filter(c => c.status === "pass").length;
      const failed = checks.filter(c => c.status === "fail").length;
      const summary = checks.map(c => `${c.status === "pass" ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n");
      return { success: true, output: `Health Check: ${passed} passed, ${failed} failed\n\n${summary}` };
    }
    case "system.update": {
      const installDir = join(process.env.DOTBOT_INSTALL_DIR || "C:\\Program Files\\.bot");
      const safeDir = installDir.replace(/'/g, "''");
      try {
        // Check if git repo exists
        const gitCheck = await runPowershell(`Test-Path (Join-Path '${safeDir}' '.git')`, 5_000);
        if (!gitCheck.output.trim().toLowerCase().includes("true")) {
          return { success: false, output: "", error: `No git repository found at ${installDir}. Update only works for git-installed DotBot.` };
        }
        // Get current commit before pull
        const beforeHash = await runPowershell(`cd '${safeDir}'; git rev-parse --short HEAD`, 5_000);
        // Pull latest
        const pullResult = await runPowershell(`cd '${safeDir}'; git pull 2>&1`, 30_000);
        if (!pullResult.success) {
          return { success: false, output: pullResult.output, error: `git pull failed: ${pullResult.error}` };
        }
        // Install deps + build (scoped to shared + local-agent only — server may not be present on client-only machines)
        await runPowershell(`cd '${safeDir}'; npm install -w shared -w local-agent 2>&1; npm run build -w shared -w local-agent 2>&1`, 120_000);
        // Get new commit
        const afterHash = await runPowershell(`cd '${safeDir}'; git rev-parse --short HEAD`, 5_000);
        // Get diff summary
        const diffSummary = await runPowershell(`cd '${safeDir}'; git log --oneline ${beforeHash.output.trim()}..HEAD 2>&1`, 5_000);

        const output = [
          `Update complete: ${beforeHash.output.trim()} → ${afterHash.output.trim()}`,
          pullResult.output.trim(),
          diffSummary.output.trim() ? `\nChanges:\n${diffSummary.output.trim()}` : "",
          "\nRestarting to apply update...",
        ].filter(Boolean).join("\n");

        // Trigger restart after returning result
        setTimeout(async () => {
          try {
            await runPreRestartHook();
          } catch { /* proceed */ }
          process.exit(42);
        }, 1000);

        return { success: true, output };
      } catch (err) {
        return { success: false, output: "", error: `Update failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    default:
      return { success: false, output: "", error: `Unknown system tool: ${toolId}` };
  }
}
