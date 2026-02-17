/**
 * Database Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const dbTools: DotBotTool[] = [
  {
    id: "db.sqlite_query", name: "sqlite_query", category: "database", source: "core", executor: "local",
    description: "Execute SQL SELECT query on SQLite database and return results.",
    inputSchema: { type: "object", properties: { db_path: { type: "string", description: "Path to SQLite database file" }, query: { type: "string", description: "SQL SELECT query" }, params: { type: "array", description: "Query parameters for prepared statements" } }, required: ["db_path", "query"] },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "db.sqlite_execute", name: "sqlite_execute", category: "database", source: "core", executor: "local",
    description: "Execute SQL statement (INSERT, UPDATE, DELETE, CREATE) on SQLite database.",
    inputSchema: { type: "object", properties: { db_path: { type: "string" }, statement: { type: "string" }, params: { type: "array" } }, required: ["db_path", "statement"] },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "db.sqlite_import", name: "sqlite_import", category: "database", source: "core", executor: "local",
    description: "Import CSV or JSON data into SQLite table.",
    inputSchema: { type: "object", properties: { db_path: { type: "string" }, table: { type: "string" }, data_path: { type: "string" }, create_table: { type: "boolean" }, truncate: { type: "boolean" } }, required: ["db_path", "table", "data_path"] },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "db.sqlite_export", name: "sqlite_export", category: "database", source: "core", executor: "local",
    description: "Export SQLite table or query results to CSV or JSON.",
    inputSchema: { type: "object", properties: { db_path: { type: "string" }, query: { type: "string" }, output_path: { type: "string" }, format: { type: "string", enum: ["csv", "json"] } }, required: ["db_path", "query", "output_path"] },
    annotations: { mutatingHint: true },
  },
];
