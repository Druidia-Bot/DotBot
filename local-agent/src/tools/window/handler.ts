/**
 * Window Management Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, runPowershell } from "../_shared/powershell.js";

export async function handleWindow(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "window.list": {
      const filter = args.filter ? sanitizeForPS(args.filter) : "";
      const where = filter ? ' | Where-Object { $_.MainWindowTitle -like "*' + filter + '*" -or $_.ProcessName -like "*' + filter + '*" }' : "";
      return runPowershell('Get-Process | Where-Object { $_.MainWindowTitle -ne "" }' + where + ' | Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200');
    }
    case "window.focus": {
      if (!args.title && !args.process) return { success: false, output: "", error: "title or process is required" };
      const match = args.title
        ? 'Where-Object { $_.MainWindowTitle -like "*' + sanitizeForPS(args.title) + '*" }'
        : 'Where-Object { $_.ProcessName -like "*' + sanitizeForPS(args.process) + '*" -and $_.MainWindowTitle -ne "" }';
      const script = [
        'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }"',
        '$p = Get-Process | ' + match + ' | Select-Object -First 1',
        'if ($p) { [Win32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [Win32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; "Focused: $($p.MainWindowTitle)" } else { "No matching window found" }',
      ].join("; ");
      return runPowershell(script);
    }
    case "window.resize": {
      if (!args.title && !args.process) return { success: false, output: "", error: "title or process is required" };
      const match = args.title
        ? 'Where-Object { $_.MainWindowTitle -like "*' + sanitizeForPS(args.title) + '*" }'
        : 'Where-Object { $_.ProcessName -like "*' + sanitizeForPS(args.process) + '*" -and $_.MainWindowTitle -ne "" }';
      if (args.state === "minimized" || args.state === "maximized") {
        const sw = args.state === "minimized" ? "6" : "3";
        const script = [
          'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class Win32R { [DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }"',
          '$p = Get-Process | ' + match + ' | Select-Object -First 1',
          'if ($p) { [Win32R]::ShowWindow($p.MainWindowHandle, ' + sw + ') | Out-Null; "Done" } else { "No matching window" }',
        ].join("; ");
        return runPowershell(script);
      }
      const script = [
        'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class Win32M { [DllImport(\\"user32.dll\\")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int W, int H, bool repaint); [DllImport(\\"user32.dll\\")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r); [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; } }"',
        '$p = Get-Process | ' + match + ' | Select-Object -First 1',
        'if (!$p) { "No matching window"; return }',
        '$r = New-Object Win32M+RECT; [Win32M]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null',
        '$x = ' + (args.x !== undefined ? args.x : '$r.L') + '; $y = ' + (args.y !== undefined ? args.y : '$r.T'),
        '$w = ' + (args.width !== undefined ? args.width : '($r.R - $r.L)') + '; $h = ' + (args.height !== undefined ? args.height : '($r.B - $r.T)'),
        '[Win32M]::MoveWindow($p.MainWindowHandle, $x, $y, $w, $h, $true) | Out-Null; "Moved to $x,$y size $w x $h"',
      ].join("; ");
      return runPowershell(script);
    }
    case "window.close": {
      if (!args.title && !args.process) return { success: false, output: "", error: "title or process is required" };
      const match = args.title
        ? 'Where-Object { $_.MainWindowTitle -like "*' + sanitizeForPS(args.title) + '*" }'
        : 'Where-Object { $_.ProcessName -like "*' + sanitizeForPS(args.process) + '*" -and $_.MainWindowTitle -ne "" }';
      if (args.force) {
        return runPowershell('$p = Get-Process | ' + match + ' | Select-Object -First 1; if ($p) { $p | Stop-Process -Force; "Killed: $($p.ProcessName)" } else { "No matching window" }');
      }
      return runPowershell('$p = Get-Process | ' + match + ' | Select-Object -First 1; if ($p) { $p.CloseMainWindow() | Out-Null; "Closed: $($p.MainWindowTitle)" } else { "No matching window" }');
    }
    default:
      return { success: false, output: "", error: "Unknown window tool: " + toolId };
  }
}
