/**
 * Audio Control Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, safeInt, runPowershell } from "../_shared/powershell.js";

export async function handleAudio(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "audio.set_volume": {
      const vol = safeInt(args.volume, 50);
      if (vol < 0 || vol > 100) return { success: false, output: "", error: "Volume must be 0-100" };
      const script = [
        '$wshShell = New-Object -ComObject WScript.Shell',
        'for ($i = 0; $i -lt 50; $i++) { $wshShell.SendKeys([char]174) }',
        '$steps = [math]::Round(' + vol + ' / 2)',
        'for ($i = 0; $i -lt $steps; $i++) { $wshShell.SendKeys([char]175) }',
        '"Volume set to approximately ' + vol + '%"',
      ].join("; ");
      return runPowershell(script);
    }
    case "audio.get_devices": {
      return runPowershell('Get-CimInstance Win32_SoundDevice | Select-Object Name, Status, Manufacturer | Format-Table -AutoSize | Out-String -Width 200');
    }
    case "audio.set_default": {
      return { success: false, output: "", error: "Setting default audio device requires a third-party module (AudioDeviceCmdlets). Use shell.powershell to install and run it." };
    }
    case "audio.play_sound": {
      if (!args.path) return { success: false, output: "", error: "path is required" };
      const p = sanitizeForPS(args.path);
      const wait = args.wait !== false ? "$true" : "$false";
      const script = [
        '$player = New-Object System.Media.SoundPlayer("' + p + '")',
        'if (' + wait + ') { $player.PlaySync() } else { $player.Play() }',
        '"Playing: ' + p + '"',
      ].join("; ");
      return runPowershell(script, 60_000);
    }
    default:
      return { success: false, output: "", error: "Unknown audio tool: " + toolId };
  }
}
