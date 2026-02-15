/**
 * Filesystem Tool Handler
 */

import { promises as fs } from "fs";
import { dirname } from "path";
import type { ToolExecResult } from "../_shared/types.js";
import { resolvePath } from "../_shared/path.js";
import { isAllowedRead, isAllowedWrite } from "../_shared/security.js";
import { sanitizeForPS, safeInt, isAllowedUrl, runPowershell } from "../_shared/powershell.js";

export async function handleFilesystem(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  const path = args.path ? resolvePath(args.path) : "";

  switch (toolId) {
    case "filesystem.create_file": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      const dir = dirname(path);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, args.content || "", "utf-8");
      return { success: true, output: `Written ${(args.content || "").length} bytes to ${path}` };
    }
    case "filesystem.read_file": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const stat = await fs.stat(path);
      if (stat.size > 10 * 1024 * 1024) return { success: false, output: "", error: `File too large: ${stat.size} bytes` };
      const content = await fs.readFile(path, "utf-8");
      return { success: true, output: content };
    }
    case "filesystem.read_file_base64": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const statB64 = await fs.stat(path);
      if (statB64.size > 100 * 1024 * 1024) return { success: false, output: "", error: `File too large for base64 transfer: ${(statB64.size / 1024 / 1024).toFixed(1)} MB (limit 100 MB)` };
      const bufferB64 = await fs.readFile(path);
      return { success: true, output: bufferB64.toString("base64") };
    }
    case "filesystem.upload_file": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const uploadUrl = args.uploadUrl as string;
      if (!uploadUrl) return { success: false, output: "", error: "Missing required 'uploadUrl' parameter" };
      // SECURITY: Validate URL to prevent SSRF and data exfiltration (cloud metadata, localhost, private IPs)
      if (!isAllowedUrl(uploadUrl)) {
        return { success: false, output: "", error: "Upload URL blocked: only public HTTP(S) URLs allowed (no localhost, private IPs, or cloud metadata endpoints)" };
      }
      const statUp = await fs.stat(path);
      if (statUp.size > 100 * 1024 * 1024) return { success: false, output: "", error: `File too large: ${(statUp.size / 1024 / 1024).toFixed(1)} MB (limit 100 MB)` };
      const uploadBuffer = await fs.readFile(path);
      const filename = path.split(/[\\/]/).pop() || "file";
      const formData = new FormData();
      formData.append("file", new Blob([uploadBuffer]), filename);
      formData.append("source", args.source || path);
      const uploadResp = await fetch(uploadUrl, { method: "POST", body: formData, signal: AbortSignal.timeout(300_000) });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return { success: false, output: "", error: `Upload failed (${uploadResp.status}): ${errText}` };
      }
      const uploadResult = await uploadResp.text();
      return { success: true, output: uploadResult };
    }
    case "filesystem.append_file": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      const dir2 = dirname(path);
      await fs.mkdir(dir2, { recursive: true });
      await fs.appendFile(path, args.content || "", "utf-8");
      return { success: true, output: `Appended ${(args.content || "").length} bytes to ${path}` };
    }
    case "filesystem.delete_file": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      await fs.unlink(path);
      return { success: true, output: `Deleted ${path}` };
    }
    case "filesystem.move": {
      const src = resolvePath(args.source);
      const dst = resolvePath(args.destination);
      if (!isAllowedRead(src) || !isAllowedWrite(dst)) return { success: false, output: "", error: "Access denied (read source or write destination)" };
      await fs.rename(src, dst);
      return { success: true, output: `Moved ${src} → ${dst}` };
    }
    case "filesystem.copy": {
      const src = resolvePath(args.source);
      const dst = resolvePath(args.destination);
      if (!isAllowedRead(src) || !isAllowedWrite(dst)) return { success: false, output: "", error: "Access denied (read source or write destination)" };
      const recurse = args.recurse !== false;
      await fs.cp(src, dst, { recursive: recurse });
      return { success: true, output: `Copied ${src} → ${dst}` };
    }
    case "filesystem.exists": {
      try {
        await fs.access(path);
        const stat = await fs.stat(path);
        return { success: true, output: `Exists: ${stat.isDirectory() ? "directory" : "file"}` };
      } catch {
        return { success: true, output: "Does not exist" };
      }
    }
    case "filesystem.edit_file": {
      if (!isAllowedWrite(path)) return { success: false, output: "", error: `Write access denied: ${path}` };
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const oldStr = args.old_string;
      const newStr = args.new_string;
      if (typeof oldStr !== "string" || typeof newStr !== "string") {
        return { success: false, output: "", error: "old_string and new_string are required" };
      }
      if (oldStr === newStr) {
        return { success: false, output: "", error: "old_string and new_string are identical — no change needed" };
      }
      const fileContent = await fs.readFile(path, "utf-8");
      if (!fileContent.includes(oldStr)) {
        return { success: false, output: "", error: `old_string not found in file. Make sure it matches exactly (including whitespace and indentation).` };
      }
      if (args.replace_all) {
        const count = fileContent.split(oldStr).length - 1;
        const updated = fileContent.split(oldStr).join(newStr);
        await fs.writeFile(path, updated, "utf-8");
        return { success: true, output: `Replaced ${count} occurrence(s) in ${path}` };
      } else {
        const occurrences = fileContent.split(oldStr).length - 1;
        if (occurrences > 1) {
          return { success: false, output: "", error: `old_string matches ${occurrences} locations — must be unique. Add more surrounding context to make it unique, or set replace_all=true.` };
        }
        const idx = fileContent.indexOf(oldStr);
        const updated = fileContent.substring(0, idx) + newStr + fileContent.substring(idx + oldStr.length);
        await fs.writeFile(path, updated, "utf-8");
        return { success: true, output: `Edited ${path} (replaced 1 occurrence)` };
      }
    }
    case "filesystem.read_lines": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const content = await fs.readFile(path, "utf-8");
      const allLines = content.split(/\r?\n/);
      const startLine = Math.max(1, safeInt(args.start_line, 1));
      const endLine = args.end_line ? Math.min(allLines.length, safeInt(args.end_line, allLines.length)) : allLines.length;
      if (startLine > allLines.length) {
        return { success: false, output: "", error: `start_line ${startLine} exceeds file length (${allLines.length} lines)` };
      }
      const selected = allLines.slice(startLine - 1, endLine);
      const numbered = selected.map((line, i) => `${(startLine + i).toString().padStart(4)}| ${line}`);
      const header = `Lines ${startLine}-${Math.min(endLine, allLines.length)} of ${allLines.length} total`;
      return { success: true, output: `${header}\n${numbered.join("\n")}` };
    }
    case "filesystem.diff": {
      const pathA = args.path_a ? resolvePath(args.path_a) : "";
      if (!pathA) return { success: false, output: "", error: "path_a is required" };
      if (!isAllowedRead(pathA)) return { success: false, output: "", error: `Read access denied: ${pathA}` };
      const contextLines = safeInt(args.context_lines, 3);

      let contentA: string;
      let contentB: string;
      let labelA = pathA;
      let labelB: string;

      try { contentA = await fs.readFile(pathA, "utf-8"); } catch { return { success: false, output: "", error: `Cannot read ${pathA}` }; }

      if (args.content_b != null) {
        contentB = args.content_b;
        labelB = "(provided content)";
      } else if (args.path_b) {
        const pathB = resolvePath(args.path_b);
        if (!isAllowedRead(pathB)) return { success: false, output: "", error: `Read access denied: ${pathB}` };
        try { contentB = await fs.readFile(pathB, "utf-8"); } catch { return { success: false, output: "", error: `Cannot read ${pathB}` }; }
        labelB = pathB;
      } else {
        return { success: false, output: "", error: "Provide either path_b or content_b to compare against" };
      }

      if (contentA === contentB) {
        return { success: true, output: "Files are identical — no differences found." };
      }

      // Simple unified diff implementation
      const linesA = contentA.split(/\r?\n/);
      const linesB = contentB.split(/\r?\n/);
      const hunks: string[] = [];
      hunks.push(`--- ${labelA}`);
      hunks.push(`+++ ${labelB}`);

      // Find changed regions by scanning for mismatched lines
      let i = 0, j = 0;
      while (i < linesA.length || j < linesB.length) {
        // Skip matching lines
        if (i < linesA.length && j < linesB.length && linesA[i] === linesB[j]) {
          i++; j++; continue;
        }
        // Found a difference — build a hunk
        const hunkStartA = Math.max(0, i - contextLines);
        const hunkStartB = Math.max(0, j - contextLines);
        const hunkLines: string[] = [];

        // Context before
        for (let c = hunkStartA; c < i; c++) {
          hunkLines.push(` ${linesA[c]}`);
        }

        // Find the end of this changed region
        let lookAhead = 0;
        let matchCount = 0;
        let ai = i, bj = j;
        while (ai < linesA.length || bj < linesB.length) {
          if (ai < linesA.length && bj < linesB.length && linesA[ai] === linesB[bj]) {
            matchCount++;
            if (matchCount >= contextLines * 2 + 1) { ai -= matchCount - 1; bj -= matchCount - 1; break; }
            ai++; bj++;
          } else {
            matchCount = 0;
            // Advance the shorter side, or both
            if (ai < linesA.length && (bj >= linesB.length || lookAhead % 2 === 0)) { hunkLines.push(`-${linesA[ai]}`); ai++; }
            if (bj < linesB.length && (ai >= linesA.length || lookAhead % 2 === 1)) { hunkLines.push(`+${linesB[bj]}`); bj++; }
            lookAhead++;
          }
          if (hunkLines.length > 200) break; // cap hunk size
        }

        // Context after
        const afterEnd = Math.min(ai + contextLines, Math.max(linesA.length, linesB.length));
        for (let c = ai; c < afterEnd && c < linesA.length; c++) {
          hunkLines.push(` ${linesA[c]}`);
        }

        const removedCount = hunkLines.filter(l => l.startsWith("-")).length;
        const addedCount = hunkLines.filter(l => l.startsWith("+")).length;
        const contextCount = hunkLines.filter(l => l.startsWith(" ")).length;
        hunks.push(`@@ -${hunkStartA + 1},${removedCount + contextCount} +${hunkStartB + 1},${addedCount + contextCount} @@`);
        hunks.push(...hunkLines);

        i = ai; j = bj;
        if (hunkLines.length > 200) break;
      }

      const diffOutput = hunks.join("\n");
      const maxLen = 6000;
      if (diffOutput.length > maxLen) {
        return { success: true, output: diffOutput.substring(0, maxLen) + `\n\n... (truncated, ${diffOutput.length} total chars)` };
      }
      return { success: true, output: diffOutput };
    }
    case "filesystem.file_info": {
      if (!isAllowedRead(path)) return { success: false, output: "", error: `Read access denied: ${path}` };
      const stat = await fs.stat(path);
      return {
        success: true,
        output: JSON.stringify({
          size: stat.size,
          isDirectory: stat.isDirectory(),
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          accessed: stat.atime.toISOString(),
        }, null, 2),
      };
    }
    case "filesystem.download": {
      const url = args.url;
      if (!url) return { success: false, output: "", error: "url is required" };
      // SECURITY: Validate URL to prevent SSRF attacks (cloud metadata, localhost, private IPs)
      if (!isAllowedUrl(url)) {
        return { success: false, output: "", error: "URL blocked: only public HTTP(S) URLs allowed (no localhost, private IPs, or cloud metadata endpoints)" };
      }
      const destPath = args.path ? resolvePath(args.path) : "";
      if (!destPath) return { success: false, output: "", error: "path is required" };
      if (!isAllowedWrite(destPath)) return { success: false, output: "", error: `Write access denied: ${destPath}` };
      const dlTimeout = args.timeout_seconds ? Math.min(safeInt(args.timeout_seconds, 120), 600) * 1000 : 120_000;

      const { default: https } = await import("https");
      const { default: http } = await import("http");
      const fetcher = url.startsWith("https") ? https : http;

      return new Promise((resolve) => {
        const timer = setTimeout(() => { resolve({ success: false, output: "", error: `Download timed out after ${dlTimeout / 1000}s` }); }, dlTimeout);
        const req = fetcher.get(url, async (res: any) => {
          // Follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            clearTimeout(timer);
            req.destroy();
            // SECURITY: Validate redirect URL to prevent SSRF via redirect chain
            const redirectUrl = res.headers.location;
            if (!isAllowedUrl(redirectUrl)) {
              resolve({ success: false, output: "", error: `Redirect blocked: ${redirectUrl} (SSRF protection)` });
              return;
            }
            // Retry with redirect URL
            const redirectFetcher = redirectUrl.startsWith("https") ? https : http;
            const req2 = redirectFetcher.get(redirectUrl, async (res2: any) => {
              if (res2.statusCode !== 200) { clearTimeout(timer); resolve({ success: false, output: "", error: `HTTP ${res2.statusCode}` }); return; }
              const chunks: Buffer[] = [];
              res2.on("data", (c: Buffer) => chunks.push(c));
              res2.on("end", async () => {
                clearTimeout(timer);
                try {
                  const dir = destPath.substring(0, destPath.lastIndexOf("\\") > 0 ? destPath.lastIndexOf("\\") : destPath.lastIndexOf("/"));
                  await fs.mkdir(dir, { recursive: true });
                  await fs.writeFile(destPath, Buffer.concat(chunks));
                  const size = Buffer.concat(chunks).length;
                  resolve({ success: true, output: `Downloaded ${size} bytes to ${destPath}` });
                } catch (e: any) { resolve({ success: false, output: "", error: e.message }); }
              });
            });
            req2.on("error", (e: Error) => { clearTimeout(timer); resolve({ success: false, output: "", error: e.message }); });
            return;
          }
          if (res.statusCode !== 200) { clearTimeout(timer); resolve({ success: false, output: "", error: `HTTP ${res.statusCode}` }); return; }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", async () => {
            clearTimeout(timer);
            try {
              const dir = destPath.substring(0, destPath.lastIndexOf("\\") > 0 ? destPath.lastIndexOf("\\") : destPath.lastIndexOf("/"));
              await fs.mkdir(dir, { recursive: true });
              await fs.writeFile(destPath, Buffer.concat(chunks));
              const size = Buffer.concat(chunks).length;
              resolve({ success: true, output: `Downloaded ${size} bytes to ${destPath}` });
            } catch (e: any) { resolve({ success: false, output: "", error: e.message }); }
          });
        });
        req.on("error", (e: Error) => { clearTimeout(timer); resolve({ success: false, output: "", error: e.message }); });
      });
    }
    case "filesystem.archive": {
      const src = args.source ? resolvePath(args.source) : "";
      const dest = args.destination ? resolvePath(args.destination) : "";
      if (!src) return { success: false, output: "", error: "source is required" };
      if (!dest) return { success: false, output: "", error: "destination is required" };
      if (!isAllowedRead(src)) return { success: false, output: "", error: `Read access denied: ${src}` };
      if (!isAllowedWrite(dest)) return { success: false, output: "", error: `Write access denied: ${dest}` };

      // Use PowerShell's Compress-Archive
      const safeSrc = src.replace(/'/g, "''");
      const safeDest = dest.replace(/'/g, "''");
      return runPowershell(`Compress-Archive -Path '${safeSrc}' -DestinationPath '${safeDest}' -Force; "Archived to ${safeDest}"`, 120_000);
    }
    case "filesystem.extract": {
      const src = args.source ? resolvePath(args.source) : "";
      const dest = args.destination ? resolvePath(args.destination) : "";
      if (!src) return { success: false, output: "", error: "source is required" };
      if (!dest) return { success: false, output: "", error: "destination is required" };
      if (!isAllowedRead(src)) return { success: false, output: "", error: `Read access denied: ${src}` };
      if (!isAllowedWrite(dest)) return { success: false, output: "", error: `Write access denied: ${dest}` };

      const safeSrc = src.replace(/'/g, "''");
      const safeDest = dest.replace(/'/g, "''");
      return runPowershell(`Expand-Archive -Path '${safeSrc}' -DestinationPath '${safeDest}' -Force; "Extracted to ${safeDest}"`, 120_000);
    }
    default:
      return { success: false, output: "", error: `Unknown filesystem tool: ${toolId}` };
  }
}
