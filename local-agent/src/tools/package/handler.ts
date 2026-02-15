/**
 * Package Management Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, safeInt, runPowershell } from "../_shared/powershell.js";

export async function handlePackage(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "package.winget_install": {
      if (!args.package_id) return { success: false, output: "", error: "package_id is required" };
      const id = sanitizeForPS(args.package_id);
      const version = args.version ? ' --version "' + sanitizeForPS(args.version) + '"' : "";
      const silent = args.silent !== false ? " --silent" : "";
      return runPowershell('winget install --id "' + id + '"' + version + silent + ' --accept-package-agreements --accept-source-agreements 2>&1 | Out-String', 300_000);
    }
    case "package.winget_search": {
      if (!args.query) return { success: false, output: "", error: "query is required" };
      const q = sanitizeForPS(args.query);
      const limit = safeInt(args.limit, 20);
      return runPowershell('winget search "' + q + '" --count ' + limit + ' 2>&1 | Out-String', 30_000);
    }
    case "package.choco_install": {
      if (!args.package_name) return { success: false, output: "", error: "package_name is required" };
      const pkg = sanitizeForPS(args.package_name);
      const version = args.version ? ' --version "' + sanitizeForPS(args.version) + '"' : "";
      const params = args.params ? ' ' + sanitizeForPS(args.params) : "";
      return runPowershell('choco install "' + pkg + '"' + version + ' -y' + params + ' 2>&1 | Out-String', 300_000);
    }
    case "package.list_installed": {
      const filter = args.filter ? sanitizeForPS(args.filter) : "";
      const source = args.source || "registry";
      if (source === "winget") {
        const where = filter ? ' | Select-String "' + filter + '"' : "";
        return runPowershell('winget list' + where + ' 2>&1 | Out-String', 30_000);
      }
      if (source === "chocolatey") {
        return runPowershell('choco list 2>&1 | Out-String', 15_000);
      }
      const where = filter ? ' | Where-Object { $_.DisplayName -like "*' + filter + '*" }' : "";
      return runPowershell('Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName }' + where + ' | Select-Object DisplayName, DisplayVersion, Publisher | Sort-Object DisplayName | Format-Table -AutoSize | Out-String -Width 200', 30_000);
    }
    default:
      return { success: false, output: "", error: "Unknown package tool: " + toolId };
  }
}
