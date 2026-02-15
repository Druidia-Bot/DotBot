/**
 * Database (SQLite) Tool Handler
 *
 * Uses better-sqlite3 which is already a project dependency.
 */

import { resolve } from "path";
import { promises as fs } from "fs";
import type { ToolExecResult } from "../_shared/types.js";

function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return resolve(process.env.USERPROFILE || process.env.HOME || "", p.slice(2));
  }
  return resolve(p);
}

export async function handleDb(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "db.sqlite_query": {
      if (!args.db_path || !args.query) return { success: false, output: "", error: "db_path and query are required" };
      try {
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(resolvePath(args.db_path), { readonly: true });
        try {
          const stmt = db.prepare(args.query);
          const params = Array.isArray(args.params) ? args.params : [];
          const rows = stmt.all(...params);
          const output = JSON.stringify(rows, null, 2);
          const truncated = output.length > 8000 ? output.substring(0, 8000) + "\n...[truncated, " + rows.length + " rows total]" : output;
          return { success: true, output: rows.length + " rows returned\n" + truncated };
        } finally {
          db.close();
        }
      } catch (err: any) {
        if (err.code === "MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
          return { success: false, output: "", error: "SQLite requires 'better-sqlite3'. Run: npm install better-sqlite3 --save -w local-agent" };
        }
        return { success: false, output: "", error: "SQLite query failed: " + err.message };
      }
    }
    case "db.sqlite_execute": {
      if (!args.db_path || !args.statement) return { success: false, output: "", error: "db_path and statement are required" };
      try {
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(resolvePath(args.db_path));
        try {
          const stmt = db.prepare(args.statement);
          const params = Array.isArray(args.params) ? args.params : [];
          const result = stmt.run(...params);
          return { success: true, output: JSON.stringify({ changes: result.changes, lastInsertRowid: String(result.lastInsertRowid) }) };
        } finally {
          db.close();
        }
      } catch (err: any) {
        if (err.code === "MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
          return { success: false, output: "", error: "SQLite requires 'better-sqlite3'. Run: npm install better-sqlite3 --save -w local-agent" };
        }
        return { success: false, output: "", error: "SQLite execute failed: " + err.message };
      }
    }
    case "db.sqlite_import": {
      if (!args.db_path || !args.table || !args.data_path) return { success: false, output: "", error: "db_path, table, and data_path are required" };
      try {
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(resolvePath(args.db_path));
        try {
          const raw = await fs.readFile(resolvePath(args.data_path), "utf-8");
          let rows: Record<string, any>[];
          if (args.data_path.endsWith(".json")) {
            rows = JSON.parse(raw);
          } else {
            const lines = raw.split(/\r?\n/).filter(l => l.trim());
            if (lines.length < 2) return { success: false, output: "", error: "CSV file is empty or has no data rows" };
            const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
            rows = lines.slice(1).map(line => {
              const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
              const row: Record<string, string> = {};
              headers.forEach((h, i) => { row[h] = vals[i] || ""; });
              return row;
            });
          }
          if (!Array.isArray(rows) || rows.length === 0) return { success: false, output: "", error: "No data to import" };

          const table = args.table.replace(/[^a-zA-Z0-9_]/g, "");
          const cols = Object.keys(rows[0]);

          if (args.create_table) {
            const colDefs = cols.map(c => '"' + c + '" TEXT').join(", ");
            db.exec('CREATE TABLE IF NOT EXISTS "' + table + '" (' + colDefs + ')');
          }
          if (args.truncate) {
            db.exec('DELETE FROM "' + table + '"');
          }

          const placeholders = cols.map(() => "?").join(", ");
          const insert = db.prepare('INSERT INTO "' + table + '" (' + cols.map(c => '"' + c + '"').join(", ") + ') VALUES (' + placeholders + ')');
          const tx = db.transaction((data: Record<string, any>[]) => {
            for (const row of data) {
              insert.run(...cols.map(c => row[c] ?? null));
            }
          });
          tx(rows);
          return { success: true, output: "Imported " + rows.length + " rows into " + table };
        } finally {
          db.close();
        }
      } catch (err: any) {
        return { success: false, output: "", error: "SQLite import failed: " + err.message };
      }
    }
    case "db.sqlite_export": {
      if (!args.db_path || !args.query || !args.output_path) return { success: false, output: "", error: "db_path, query, and output_path are required" };
      try {
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(resolvePath(args.db_path), { readonly: true });
        try {
          const rows = db.prepare(args.query).all();
          const outPath = resolvePath(args.output_path);
          const fmt = args.format || (outPath.endsWith(".csv") ? "csv" : "json");

          if (fmt === "csv") {
            if (rows.length === 0) { await fs.writeFile(outPath, "", "utf-8"); return { success: true, output: "Exported 0 rows" }; }
            const headers = Object.keys(rows[0] as Record<string, any>);
            const escape = (v: any): string => { const s = String(v ?? ""); return s.includes(",") || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s; };
            const lines = [headers.join(","), ...rows.map((r: any) => headers.map(h => escape(r[h])).join(","))];
            await fs.writeFile(outPath, lines.join("\n"), "utf-8");
          } else {
            await fs.writeFile(outPath, JSON.stringify(rows, null, 2), "utf-8");
          }
          return { success: true, output: "Exported " + rows.length + " rows to " + outPath };
        } finally {
          db.close();
        }
      } catch (err: any) {
        return { success: false, output: "", error: "SQLite export failed: " + err.message };
      }
    }
    default:
      return { success: false, output: "", error: "Unknown db tool: " + toolId };
  }
}
