/**
 * Directory Tool Handler
 */

import { promises as fs } from "fs";
import { resolve } from "path";
import RE2 from "re2";
import type { ToolExecResult } from "../_shared/types.js";
import { resolvePath } from "../_shared/path.js";
import { isAllowedRead, isAllowedWrite } from "../_shared/security.js";
import { sanitizeForPS, safeInt, runPowershell } from "../_shared/powershell.js";

export async function handleDirectory(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  const path = args.path ? resolvePath(args.path) : "";

  switch (toolId) {
    case "directory.list": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const entries = await fs.readdir(path, { withFileTypes: true });
      const lines = await Promise.all(entries.map(async (e) => {
        const fullPath = resolve(path, e.name);
        if (e.isDirectory()) {
          return `[DIR]  ${e.name}`;
        } else {
          try {
            const stat = await fs.stat(fullPath);
            return `[FILE] ${e.name} (${stat.size} bytes)`;
          } catch {
            return `[FILE] ${e.name}`;
          }
        }
      }));
      return { success: true, output: lines.join("\n") };
    }
    case "directory.create": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      await fs.mkdir(path, { recursive: true });
      return { success: true, output: `Created directory: ${path}` };
    }
    case "directory.delete": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      return runPowershell(`Remove-Item -LiteralPath "${sanitizeForPS(path)}" -Recurse -Force`);
    }
    case "directory.find": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const depth = safeInt(args.maxDepth, 5);
      const pattern = sanitizeForPS(args.pattern || "*");
      return runPowershell(`Get-ChildItem -LiteralPath "${sanitizeForPS(path)}" -Filter "${pattern}" -Recurse -Depth ${depth} | Select-Object -ExpandProperty FullName`);
    }
    case "directory.tree": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const depth = safeInt(args.maxDepth, 3);
      const safePath = sanitizeForPS(path);
      return runPowershell(`
function Show-Tree { param($Path, $Indent = "", $Depth = 0, $MaxDepth = ${depth})
  if ($Depth -ge $MaxDepth) { return }
  Get-ChildItem -LiteralPath $Path -ErrorAction SilentlyContinue | Sort-Object { !$_.PSIsContainer }, Name | ForEach-Object {
    $type = if($_.PSIsContainer){"[DIR]"}else{"[FILE]"}
    Write-Output "$Indent$type $($_.Name)"
    if($_.PSIsContainer) { Show-Tree -Path $_.FullName -Indent "$Indent  " -Depth ($Depth+1) -MaxDepth $MaxDepth }
  }
}
Show-Tree -Path "${safePath}"`.trim());
    }
    case "directory.grep": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const pattern = args.pattern;
      if (!pattern) return { success: false, output: "", error: "pattern is required" };
      const maxResults = safeInt(args.max_results, 50);
      const caseSensitive = args.case_sensitive === true;
      const includeGlob = args.include || "";

      // Build a recursive file search + grep using Node.js for cross-platform support
      const results: string[] = [];
      const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache", "coverage"]);
      const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".dylib", ".pdf"]);

      async function grepDir(dir: string, depth: number): Promise<void> {
        if (depth > 8 || results.length >= maxResults) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (results.length >= maxResults) break;
          const fullPath = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) await grepDir(fullPath, depth + 1);
          } else {
            const ext = entry.name.substring(entry.name.lastIndexOf(".")).toLowerCase();
            if (BINARY_EXTS.has(ext)) continue;
            if (includeGlob) {
              const globExt = includeGlob.startsWith("*.") ? includeGlob.substring(1).toLowerCase() : null;
              if (globExt && ext !== globExt) continue;
            }
            try {
              const stat = await fs.stat(fullPath);
              if (stat.size > 1024 * 1024) continue; // skip files > 1MB
              const content = await fs.readFile(fullPath, "utf-8");
              const lines = content.split(/\r?\n/);
              const flags = caseSensitive ? "" : "i";

              // L-05 fix: Use RE2 for ReDoS protection (guarantees linear time execution)
              let regex: RE2 | RegExp;
              try {
                regex = new RE2(pattern, flags);
              } catch {
                // RE2 compilation failed (invalid pattern or unsupported syntax like backreferences)
                // Fall back to escaped literal search with native RegExp
                regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
              }
              for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                if (regex.test(lines[i])) {
                  const relPath = fullPath.substring(path.length).replace(/\\/g, "/").replace(/^\//, "");
                  results.push(`${relPath}:${i + 1}: ${lines[i].trimEnd()}`);
                }
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }

      await grepDir(path, 0);
      if (results.length === 0) {
        return { success: true, output: `No matches found for "${pattern}" in ${path}` };
      }
      const header = results.length >= maxResults ? `Found ${maxResults}+ matches (capped). Narrow your search with 'include' or a more specific pattern.` : `Found ${results.length} match(es)`;
      return { success: true, output: `${header}\n\n${results.join("\n")}` };
    }
    case "directory.size": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      return runPowershell(`(Get-ChildItem -LiteralPath "${sanitizeForPS(path)}" -Recurse -File | Measure-Object -Property Length -Sum).Sum | ForEach-Object { "$([math]::Round($_ / 1MB, 2)) MB" }`);
    }
    default:
      return { success: false, output: "", error: `Unknown directory tool: ${toolId}` };
  }
}
