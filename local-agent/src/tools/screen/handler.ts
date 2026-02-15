/**
 * Screen Capture/Record Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, safeInt, runPowershell } from "../_shared/powershell.js";

export async function handleScreen(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "screen.capture": {
      if (!args.output_path) return { success: false, output: "", error: "output_path is required" };
      const outPath = sanitizeForPS(args.output_path);
      const mode = args.mode || "fullscreen";

      if (mode === "fullscreen") {
        const script = [
          'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
          '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
          '$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          '$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
          '$g.Dispose()',
          '$bmp.Save("' + outPath + '")',
          '$bmp.Dispose()',
          '"Captured fullscreen to ' + outPath + '"',
        ].join("; ");
        return runPowershell(script);
      }

      if (mode === "region") {
        const x = safeInt(args.x, 0);
        const y = safeInt(args.y, 0);
        const w = safeInt(args.width, 800);
        const h = safeInt(args.height, 600);
        const script = [
          'Add-Type -AssemblyName System.Drawing',
          '$bmp = New-Object System.Drawing.Bitmap(' + w + ', ' + h + ')',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          '$g.CopyFromScreen(' + x + ', ' + y + ', 0, 0, (New-Object System.Drawing.Size(' + w + ', ' + h + ')))',
          '$g.Dispose()',
          '$bmp.Save("' + outPath + '")',
          '$bmp.Dispose()',
          '"Captured region to ' + outPath + '"',
        ].join("; ");
        return runPowershell(script);
      }

      if (mode === "window") {
        const title = args.window_title ? sanitizeForPS(args.window_title) : "";
        if (!title) return { success: false, output: "", error: "window_title is required for window mode" };
        const script = [
          'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
          'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class WinCap { [DllImport(\\"user32.dll\\")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; } }"',
          '$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*' + title + '*" } | Select-Object -First 1',
          'if (!$p) { "No matching window"; return }',
          '$r = New-Object WinCap+RECT; [WinCap]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null',
          '$w = $r.R - $r.L; $h = $r.B - $r.T',
          '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          '$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $h)))',
          '$g.Dispose(); $bmp.Save("' + outPath + '"); $bmp.Dispose()',
          '"Captured window to ' + outPath + '"',
        ].join("; ");
        return runPowershell(script);
      }

      return { success: false, output: "", error: "Unknown capture mode: " + mode };
    }
    case "screen.record": {
      return { success: false, output: "", error: "Screen recording requires ffmpeg. Use shell.powershell to run ffmpeg directly if installed." };
    }
    default:
      return { success: false, output: "", error: "Unknown screen tool: " + toolId };
  }
}
