/**
 * Schema Extractor
 * 
 * Extracts structural information from files:
 * - Spreadsheets (xlsx, csv)
 * - Documents (txt, json, xml)
 * - Directories
 */

import { promises as fs } from "fs";
import { resolve, extname, basename } from "path";
import * as XLSX from "xlsx";
import type { SchemaReport } from "./types.js";

// ============================================
// MAIN EXTRACTOR
// ============================================

export async function extractSchema(filePath: string): Promise<SchemaReport> {
  const resolvedPath = resolve(filePath);
  const ext = extname(resolvedPath).toLowerCase();

  try {
    const stat = await fs.stat(resolvedPath);

    if (stat.isDirectory()) {
      return await extractDirectorySchema(resolvedPath);
    }

    switch (ext) {
      case ".xlsx":
      case ".xls":
        return await extractSpreadsheetSchema(resolvedPath);
      
      case ".csv":
        return await extractCSVSchema(resolvedPath);
      
      case ".json":
        return await extractJSONSchema(resolvedPath);
      
      case ".txt":
      case ".md":
        return await extractTextSchema(resolvedPath);
      
      default:
        return {
          type: "unknown",
          path: resolvedPath,
          structure: { extension: ext, size: stat.size },
          preview: `File: ${basename(resolvedPath)}, Size: ${formatBytes(stat.size)}`
        };
    }
  } catch (error) {
    throw new Error(`Failed to extract schema: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

// ============================================
// SPREADSHEET SCHEMA
// ============================================

async function extractSpreadsheetSchema(filePath: string): Promise<SchemaReport> {
  const buffer = await fs.readFile(filePath);
  const workbook = XLSX.read(buffer, { type: "buffer" });

  const sheets: Record<string, any> = {};
  let preview = "";

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    
    // Get headers (first row)
    const headers: string[] = [];
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: range.s.r, c: col });
      const cell = sheet[cellAddress];
      headers.push(cell ? String(cell.v) : `Column ${col + 1}`);
    }

    // Sample first few rows
    const sampleData: any[] = [];
    const sampleRows = Math.min(5, range.e.r - range.s.r);
    
    for (let row = range.s.r + 1; row <= range.s.r + sampleRows; row++) {
      const rowData: Record<string, any> = {};
      for (let col = range.s.c; col <= range.e.c; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = sheet[cellAddress];
        const header = headers[col - range.s.c] || `Column ${col + 1}`;
        rowData[header] = cell ? cell.v : null;
      }
      sampleData.push(rowData);
    }

    // Detect column types
    const columnTypes: Record<string, string> = {};
    for (let col = range.s.c; col <= range.e.c; col++) {
      const header = headers[col - range.s.c];
      const types = new Set<string>();
      
      for (let row = range.s.r + 1; row <= Math.min(range.s.r + 100, range.e.r); row++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = sheet[cellAddress];
        if (cell) {
          types.add(cell.t); // n=number, s=string, b=boolean, d=date
        }
      }
      
      columnTypes[header] = Array.from(types).map(t => 
        ({ n: "number", s: "string", b: "boolean", d: "date" }[t] || "unknown")
      ).join("|");
    }

    // Find cells containing "total" (case insensitive)
    const totalCells: string[] = [];
    for (let row = range.s.r; row <= range.e.r; row++) {
      for (let col = range.s.c; col <= range.e.c; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = sheet[cellAddress];
        if (cell && typeof cell.v === "string" && 
            cell.v.toLowerCase().includes("total")) {
          totalCells.push(`${sheetName}!${cellAddress}: "${cell.v}"`);
        }
      }
    }

    sheets[sheetName] = {
      rowCount: range.e.r - range.s.r + 1,
      columnCount: range.e.c - range.s.c + 1,
      headers,
      columnTypes,
      sampleData,
      totalCells
    };

    preview += `Sheet "${sheetName}": ${sheets[sheetName].rowCount} rows, ${sheets[sheetName].columnCount} columns\n`;
    preview += `  Headers: ${headers.slice(0, 5).join(", ")}${headers.length > 5 ? "..." : ""}\n`;
    if (totalCells.length > 0) {
      preview += `  Totals found: ${totalCells.slice(0, 3).join(", ")}${totalCells.length > 3 ? "..." : ""}\n`;
    }
  }

  return {
    type: "spreadsheet",
    path: filePath,
    structure: {
      sheetCount: workbook.SheetNames.length,
      sheetNames: workbook.SheetNames,
      sheets
    },
    preview: preview.trim()
  };
}

// ============================================
// CSV SCHEMA
// ============================================

async function extractCSVSchema(filePath: string): Promise<SchemaReport> {
  const content = await fs.readFile(filePath, "utf-8");
  const records = splitCSVRecords(content);
  
  if (records.length === 0) {
    return {
      type: "spreadsheet",
      path: filePath,
      structure: { headers: [], rowCount: 0 },
      preview: "Empty CSV file"
    };
  }

  // Detect delimiter
  const firstLine = records[0];
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  
  // Parse headers
  const headers = parseCSVLine(firstLine, delimiter);
  
  // Sample data
  const sampleData: any[] = [];
  for (let i = 1; i < Math.min(6, records.length); i++) {
    const values = parseCSVLine(records[i], delimiter);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });
    sampleData.push(row);
  }

  return {
    type: "spreadsheet",
    path: filePath,
    structure: {
      headers,
      rowCount: records.length - 1,
      delimiter,
      sampleData
    },
    preview: `CSV: ${records.length - 1} rows, ${headers.length} columns\nHeaders: ${headers.join(", ")}`
  };
}

function splitCSVRecords(content: string): string[] {
  const records: string[] = [];
  let current = "";
  let inQuotes = false;
  
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && content[i + 1] === '\n') i++; // skip \r\n
      if (current.trim()) records.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) records.push(current);
  return records;
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'; // RFC 4180: "" → literal "
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  
  return result;
}

// ============================================
// JSON SCHEMA
// ============================================

async function extractJSONSchema(filePath: string): Promise<SchemaReport> {
  const content = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(content);
  
  const schema = inferJSONSchema(data);
  
  return {
    type: "document",
    path: filePath,
    structure: schema,
    preview: `JSON: ${JSON.stringify(schema, null, 2).slice(0, 500)}`
  };
}

function inferJSONSchema(data: any, depth: number = 0): any {
  if (depth > 3) return "..."; // Limit recursion
  
  if (data === null) return "null";
  if (Array.isArray(data)) {
    if (data.length === 0) return "array<empty>";
    return `array<${inferJSONSchema(data[0], depth + 1)}>[${data.length}]`;
  }
  if (typeof data === "object") {
    const schema: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      schema[key] = inferJSONSchema(value, depth + 1);
    }
    return schema;
  }
  return typeof data;
}

// ============================================
// TEXT SCHEMA
// ============================================

async function extractTextSchema(filePath: string): Promise<SchemaReport> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const words = content.split(/\s+/).length;
  const chars = content.length;
  
  // First 500 chars as preview
  const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "");
  
  return {
    type: "document",
    path: filePath,
    structure: {
      lineCount: lines.length,
      wordCount: words,
      charCount: chars
    },
    preview: `Text: ${lines.length} lines, ${words} words\n\nPreview:\n${preview}`
  };
}

// ============================================
// DIRECTORY SCHEMA
// ============================================

async function extractDirectorySchema(dirPath: string): Promise<SchemaReport> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  
  const files: string[] = [];
  const directories: string[] = [];
  const summary: Record<string, number> = {};
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      directories.push(entry.name);
    } else {
      files.push(entry.name);
      const ext = extname(entry.name).toLowerCase() || "no-extension";
      summary[ext] = (summary[ext] || 0) + 1;
    }
  }

  return {
    type: "directory",
    path: dirPath,
    structure: {
      fileCount: files.length,
      directoryCount: directories.length,
      files: files.slice(0, 20),
      directories: directories.slice(0, 20),
      extensionSummary: summary
    },
    preview: `Directory: ${files.length} files, ${directories.length} folders\nExtensions: ${Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join(", ")}`
  };
}

// ============================================
// UTILITIES
// ============================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
