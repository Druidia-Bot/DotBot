/**
 * Data Processing Tool Handler
 *
 * CSV: built-in (no deps). Excel: requires xlsx package. XML: PowerShell fallback.
 */

import { promises as fs } from "fs";
import { resolve } from "path";
import type { ToolExecResult } from "../_shared/types.js";
import { runPowershell, sanitizeForPS } from "../_shared/powershell.js";

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return resolve(process.env.USERPROFILE || process.env.HOME || "", p.slice(2));
  }
  return resolve(p);
}

function parseCSV(text: string, delimiter: string, hasHeader: boolean): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return [];

  const sep = delimiter || ",";
  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === sep && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  let headers: string[];
  let startIdx: number;
  if (hasHeader !== false && lines.length > 0) {
    headers = parseLine(lines[0]);
    startIdx = 1;
  } else {
    const cols = parseLine(lines[0]).length;
    headers = Array.from({ length: cols }, (_, i) => "col" + (i + 1));
    startIdx = 0;
  }

  const rows: Record<string, string>[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = vals[j] || "";
    }
    rows.push(row);
  }
  return rows;
}

function toCSV(data: Record<string, any>[], delimiter: string, customHeaders?: string[]): string {
  if (data.length === 0) return "";
  const sep = delimiter || ",";
  const headers = customHeaders || Object.keys(data[0]);
  const escape = (v: any): string => {
    const s = String(v ?? "");
    return s.includes(sep) || s.includes('"') || s.includes("\n") ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(escape).join(sep)];
  for (const row of data) {
    lines.push(headers.map(h => escape(row[h])).join(sep));
  }
  return lines.join("\n");
}

export async function handleData(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "data.read_csv": {
      if (!args.path) return { success: false, output: "", error: "path is required" };
      try {
        const filePath = resolvePath(args.path);
        const encoding = (args.encoding || "utf-8") as BufferEncoding;
        const text = await fs.readFile(filePath, encoding);
        const rows = parseCSV(text, args.delimiter, args.has_header);
        const preview = rows.length > 50 ? rows.slice(0, 50) : rows;
        const truncated = rows.length > 50 ? "\n...(showing 50 of " + rows.length + " rows)" : "";
        return { success: true, output: JSON.stringify(preview, null, 2) + truncated };
      } catch (err: any) {
        return { success: false, output: "", error: "Failed to read CSV: " + err.message };
      }
    }
    case "data.write_csv": {
      if (!args.path || !args.data) return { success: false, output: "", error: "path and data are required" };
      try {
        const data = typeof args.data === "string" ? JSON.parse(args.data) : args.data;
        if (!Array.isArray(data)) return { success: false, output: "", error: "data must be an array of objects" };
        const csv = toCSV(data, args.delimiter, args.headers);
        const filePath = resolvePath(args.path);
        await fs.writeFile(filePath, csv, (args.encoding || "utf-8") as BufferEncoding);
        return { success: true, output: "Wrote " + data.length + " rows to " + filePath };
      } catch (err: any) {
        return { success: false, output: "", error: "Failed to write CSV: " + err.message };
      }
    }
    case "data.read_excel": {
      if (!args.path) return { success: false, output: "", error: "path is required" };
      try {
        const xlsx = await import("xlsx");
        const filePath = resolvePath(args.path);
        const wb = xlsx.readFile(filePath);
        const sheetName = args.sheet || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        if (!ws) return { success: false, output: "", error: "Sheet not found: " + sheetName + ". Available: " + wb.SheetNames.join(", ") };
        const opts: any = { header: args.has_header !== false ? 1 : "A" };
        if (args.range) opts.range = args.range;
        const data = xlsx.utils.sheet_to_json(ws, opts);
        const preview = data.length > 50 ? data.slice(0, 50) : data;
        const truncated = data.length > 50 ? "\n...(showing 50 of " + data.length + " rows)" : "";
        return { success: true, output: JSON.stringify(preview, null, 2) + truncated };
      } catch (err: any) {
        if (err.code === "MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
          return { success: false, output: "", error: "Excel support requires the 'xlsx' npm package. Run: npm install xlsx --save -w local-agent" };
        }
        return { success: false, output: "", error: "Failed to read Excel: " + err.message };
      }
    }
    case "data.write_excel": {
      if (!args.path || !args.data) return { success: false, output: "", error: "path and data are required" };
      try {
        const xlsx = await import("xlsx");
        const data = typeof args.data === "string" ? JSON.parse(args.data) : args.data;
        if (!Array.isArray(data)) return { success: false, output: "", error: "data must be an array of objects" };
        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(data, args.headers ? { header: args.headers } : undefined);
        xlsx.utils.book_append_sheet(wb, ws, args.sheet || "Sheet1");
        const filePath = resolvePath(args.path);
        xlsx.writeFile(wb, filePath);
        return { success: true, output: "Wrote " + data.length + " rows to " + filePath };
      } catch (err: any) {
        if (err.code === "MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
          return { success: false, output: "", error: "Excel support requires the 'xlsx' npm package. Run: npm install xlsx --save -w local-agent" };
        }
        return { success: false, output: "", error: "Failed to write Excel: " + err.message };
      }
    }
    case "data.transform_json": {
      if (!args.input || !args.operation) return { success: false, output: "", error: "input and operation are required" };
      try {
        let data: any;
        if (args.input.trim().startsWith("{") || args.input.trim().startsWith("[")) {
          data = JSON.parse(args.input);
        } else {
          const raw = await fs.readFile(resolvePath(args.input), "utf-8");
          data = JSON.parse(raw);
        }

        switch (args.operation) {
          case "flatten": {
            const flat: Record<string, any> = {};
            const walk = (obj: any, prefix: string) => {
              for (const [k, v] of Object.entries(obj)) {
                const key = prefix ? prefix + "." + k : k;
                if (v && typeof v === "object" && !Array.isArray(v)) { walk(v, key); }
                else { flat[key] = v; }
              }
            };
            walk(data, "");
            return { success: true, output: JSON.stringify(flat, null, 2) };
          }
          case "extract": {
            const key = args.params?.key || args.params?.path;
            if (!key) return { success: false, output: "", error: "params.key is required for extract" };
            const parts = key.split(".");
            let current = data;
            for (const p of parts) {
              if (current == null) break;
              current = current[p];
            }
            return { success: true, output: JSON.stringify(current, null, 2) };
          }
          case "filter": {
            if (!Array.isArray(data)) return { success: false, output: "", error: "filter requires an array input" };
            const field = args.params?.field;
            const value = args.params?.value;
            if (!field) return { success: false, output: "", error: "params.field is required for filter" };
            const filtered = data.filter((item: any) => String(item[field]) === String(value));
            return { success: true, output: JSON.stringify(filtered, null, 2) };
          }
          default:
            return { success: true, output: JSON.stringify(data, null, 2).substring(0, 8000) };
        }
      } catch (err: any) {
        return { success: false, output: "", error: "JSON transform failed: " + err.message };
      }
    }
    case "data.transform_xml": {
      if (!args.input) return { success: false, output: "", error: "input is required" };
      const isFile = !args.input.trim().startsWith("<");
      if (isFile) {
        const p = sanitizeForPS(resolvePath(args.input));
        const xpath = args.xpath ? sanitizeForPS(args.xpath) : "";
        if (xpath) {
          return runPowershell('[xml]$x = Get-Content "' + p + '"; $x.SelectNodes("' + xpath + '") | ForEach-Object { $_.OuterXml } | Out-String');
        }
        return runPowershell('[xml]$x = Get-Content "' + p + '"; $x.OuterXml');
      }
      return { success: false, output: "", error: "Inline XML parsing not supported. Save to a file first." };
    }
    default:
      return { success: false, output: "", error: "Unknown data tool: " + toolId };
  }
}
