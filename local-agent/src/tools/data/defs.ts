/**
 * Data Processing Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const dataTools: DotBotTool[] = [
  {
    id: "data.read_csv", name: "read_csv", category: "data", source: "core", executor: "local",
    description: "Read CSV file and parse into structured data (array of objects).",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to CSV file" }, delimiter: { type: "string", description: "Column delimiter (default: comma)" }, has_header: { type: "boolean", description: "First row contains headers" }, encoding: { type: "string", description: "File encoding (default: utf8)" } }, required: ["path"] },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "data.write_csv", name: "write_csv", category: "data", source: "core", executor: "local",
    description: "Write structured data (array of objects) to CSV file.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to CSV file" }, data: { type: "array", description: "Array of objects to write" }, delimiter: { type: "string" }, headers: { type: "array" }, encoding: { type: "string" } }, required: ["path", "data"] },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "data.read_excel", name: "read_excel", category: "data", source: "core", executor: "local",
    description: "Read Excel file (.xlsx, .xls) and parse into structured data.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, sheet: { type: "string" }, range: { type: "string" }, has_header: { type: "boolean" } }, required: ["path"] },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "data.write_excel", name: "write_excel", category: "data", source: "core", executor: "local",
    description: "Write structured data to Excel file (.xlsx).",
    inputSchema: { type: "object", properties: { path: { type: "string" }, data: { type: "array" }, sheet: { type: "string" }, headers: { type: "array" } }, required: ["path", "data"] },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "data.transform_json", name: "transform_json", category: "data", source: "core", executor: "local",
    description: "Advanced JSON manipulation: filter, map, merge, deep operations.",
    inputSchema: { type: "object", properties: { input: { type: "string", description: "JSON string or path to JSON file" }, operation: { type: "string", enum: ["filter", "map", "merge", "extract", "flatten", "unflatten"] }, params: { type: "object" } }, required: ["input", "operation"] },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "data.transform_xml", name: "transform_xml", category: "data", source: "core", executor: "local",
    description: "Parse XML to JSON or extract specific elements using XPath.",
    inputSchema: { type: "object", properties: { input: { type: "string", description: "XML string or path to XML file" }, xpath: { type: "string" }, to_json: { type: "boolean" } }, required: ["input"] },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
];
