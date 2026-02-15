/**
 * Windows Registry Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, safeInt, runPowershell } from "../_shared/powershell.js";

const VALID_REG_ROOTS = ["HKCU:", "HKLM:", "HKCR:", "HKU:", "HKCC:"];

function isValidRegPath(path: string): boolean {
  return VALID_REG_ROOTS.some(r => path.toUpperCase().startsWith(r.slice(0, -1)));
}

const VALID_REG_TYPES = new Set(["String", "DWord", "QWord", "Binary", "MultiString", "ExpandString"]);

export async function handleRegistry(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "registry.read": {
      if (!args.path || !args.name) return { success: false, output: "", error: "path and name are required" };
      if (!isValidRegPath(args.path)) return { success: false, output: "", error: "Invalid registry path. Must start with HKCU:\\, HKLM:\\, etc." };
      const p = sanitizeForPS(args.path);
      const n = sanitizeForPS(args.name);
      return runPowershell('Get-ItemProperty -Path "' + p + '" -Name "' + n + '" | Select-Object -ExpandProperty "' + n + '"');
    }
    case "registry.write": {
      if (!args.path || !args.name || args.value === undefined) return { success: false, output: "", error: "path, name, and value are required" };
      if (!isValidRegPath(args.path)) return { success: false, output: "", error: "Invalid registry path" };
      const regType = VALID_REG_TYPES.has(args.type) ? args.type : "String";
      const p = sanitizeForPS(args.path);
      const n = sanitizeForPS(args.name);
      const v = sanitizeForPS(String(args.value));
      const lines = [
        'if (!(Test-Path "' + p + '")) { New-Item -Path "' + p + '" -Force | Out-Null }',
        'Set-ItemProperty -Path "' + p + '" -Name "' + n + '" -Value "' + v + '" -Type ' + regType,
        '"Done"',
      ];
      return runPowershell(lines.join("; "));
    }
    case "registry.delete": {
      if (!args.path) return { success: false, output: "", error: "path is required" };
      if (!isValidRegPath(args.path)) return { success: false, output: "", error: "Invalid registry path" };
      const p = sanitizeForPS(args.path);
      if (args.name) {
        const n = sanitizeForPS(args.name);
        return runPowershell('Remove-ItemProperty -Path "' + p + '" -Name "' + n + '" -Force; "Deleted"');
      }
      const recurse = args.recurse ? " -Recurse" : "";
      return runPowershell('Remove-Item -Path "' + p + '" -Force' + recurse + '; "Deleted"');
    }
    case "registry.search": {
      if (!args.root || !args.pattern) return { success: false, output: "", error: "root and pattern are required" };
      if (!isValidRegPath(args.root)) return { success: false, output: "", error: "Invalid registry root path" };
      const max = safeInt(args.max_results, 50);
      const doKeys = args.search_keys !== false ? "$true" : "$false";
      const doVals = args.search_values !== false ? "$true" : "$false";
      const root = sanitizeForPS(args.root);
      const pat = sanitizeForPS(args.pattern);
      const script = [
        '$results = @(); $max = ' + max,
        'Get-ChildItem -Path "' + root + '" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {',
        '  if ($results.Count -ge $max) { return }',
        '  $key = $_',
        '  if (' + doKeys + ' -and $key.PSChildName -like "' + pat + '") { $results += "KEY: $($key.Name)" }',
        '  if (' + doVals + ') { $key.GetValueNames() | Where-Object { $_ -like "' + pat + '" } | ForEach-Object { if ($results.Count -lt $max) { $results += "VALUE: $($key.Name)\\$_" } } }',
        '}',
        'if ($results.Count -eq 0) { "No matches found." } else { $results -join [char]10 }',
      ].join("\n");
      return runPowershell(script, 60_000);
    }
    default:
      return { success: false, output: "", error: "Unknown registry tool: " + toolId };
  }
}
