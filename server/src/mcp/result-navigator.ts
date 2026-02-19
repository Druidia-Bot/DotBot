/**
 * Result Navigator — Server-Side Handlers for Collection Browsing
 *
 * Three tools that let the LLM explore a collection without loading
 * all items into context:
 *
 *   result.overview — Re-generate the summary table
 *   result.get      — Retrieve full data for a specific item
 *   result.filter   — Filter items by field value
 *
 * All handlers read from the in-memory CollectionRef store or re-parse
 * the cache file if the ref has expired.
 */

import { createComponentLogger } from "#logging.js";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import { getCollectionRef } from "./result-processor.js";
import { buildOverview } from "./result-processor.js";
import { extractItems, extractSummaryFields } from "./introspector.js";
import type { ToolHandler, ToolContext } from "../tool-loop/types.js";
import type { CollectionRef } from "./collection-types.js";

const log = createComponentLogger("mcp-gateway.navigator");

/** Max characters for a single item detail response. */
const MAX_ITEM_DETAIL_LENGTH = 8_000;

/** Max items to return from a filter operation. */
const MAX_FILTER_RESULTS = 50;

// ============================================
// HELPER: Resolve collection from ID
// ============================================

async function resolveCollection(
  deviceId: string,
  collectionId: string,
): Promise<{ ref: CollectionRef; rawData: string } | string> {
  const ref = getCollectionRef(collectionId);
  if (!ref) {
    return `Collection "${collectionId}" not found. It may have expired (30min TTL). ` +
      `Re-run the original tool to create a new collection.`;
  }

  // Read the cached file from the local agent
  try {
    const rawData = await sendExecutionCommand(deviceId, {
      id: `col_read_${collectionId}`,
      type: "tool_execute",
      payload: {
        toolId: "filesystem.read_file",
        toolArgs: { path: ref.filePath },
      },
      dryRun: false,
      timeout: 15_000,
      sandboxed: true,
      requiresApproval: false,
    });

    if (!rawData) {
      return `Failed to read cached collection file at ${ref.filePath}. ` +
        `The file may have been pruned. Re-run the original tool.`;
    }

    return { ref, rawData };
  } catch (err) {
    return `Error reading collection: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ============================================
// result.overview
// ============================================

export const handleResultOverview: ToolHandler = async (
  ctx: ToolContext,
  args: Record<string, any>,
): Promise<string> => {
  const { collectionId, fields } = args;

  if (!collectionId) return "Error: collectionId is required.";

  const resolved = await resolveCollection(ctx.deviceId, collectionId);
  if (typeof resolved === "string") return resolved;

  const { ref, rawData } = resolved;
  const items = extractItems(rawData, ref.hints);

  // If custom fields requested, use them; otherwise use hints.summaryFields
  const overviewHints = fields?.length
    ? { ...ref.hints, summaryFields: fields }
    : ref.hints;

  return buildOverview(collectionId, items, overviewHints, ref.filePath);
};

// ============================================
// result.get
// ============================================

export const handleResultGet: ToolHandler = async (
  ctx: ToolContext,
  args: Record<string, any>,
): Promise<string> => {
  const { collectionId, index, fields } = args;

  if (!collectionId) return "Error: collectionId is required.";
  if (index === undefined || index === null) return "Error: index is required.";

  const resolved = await resolveCollection(ctx.deviceId, collectionId);
  if (typeof resolved === "string") return resolved;

  const { ref, rawData } = resolved;
  const items = extractItems(rawData, ref.hints);

  if (index < 0 || index >= items.length) {
    return `Error: index ${index} is out of range. Collection has ${items.length} items (0-${items.length - 1}).`;
  }

  const item = items[index] as Record<string, unknown>;

  // If specific fields requested, filter to those fields
  if (fields?.length) {
    const filtered = extractSummaryFields(item, fields);
    const result = JSON.stringify(filtered, null, 2);
    if (result.length > MAX_ITEM_DETAIL_LENGTH) {
      return result.substring(0, MAX_ITEM_DETAIL_LENGTH) +
        `\n\n...[truncated — request fewer fields]`;
    }
    return `Item ${index} of ${items.length} (collection: ${collectionId}):\n\n${result}`;
  }

  // Full item — apply noise-aware truncation
  const fullJson = JSON.stringify(item, null, 2);
  if (fullJson.length <= MAX_ITEM_DETAIL_LENGTH) {
    return `Item ${index} of ${items.length} (collection: ${collectionId}):\n\n${fullJson}`;
  }

  // Too large — show summary fields + list omitted noise fields
  const summary = extractSummaryFields(item, ref.hints.summaryFields);
  const summaryJson = JSON.stringify(summary, null, 2);
  const omittedFields = ref.hints.noiseFields;

  const lines: string[] = [
    `Item ${index} of ${items.length} (collection: ${collectionId}):`,
    "",
    summaryJson,
    "",
    `Omitted ${omittedFields.length} large fields: ${omittedFields.join(", ")}`,
    `Use result.get("${collectionId}", ${index}, { fields: ["${omittedFields[0]}"] }) to include specific fields.`,
  ];
  return lines.join("\n");
};

// ============================================
// result.filter
// ============================================

type FilterOp = "contains" | "equals" | "not_equals" | "gt" | "lt";

function matchesFilter(itemValue: unknown, op: FilterOp, filterValue: string | number): boolean {
  if (itemValue === null || itemValue === undefined) return false;

  switch (op) {
    case "contains": {
      const str = typeof itemValue === "string" ? itemValue : JSON.stringify(itemValue);
      return str.toLowerCase().includes(String(filterValue).toLowerCase());
    }
    case "equals":
      return String(itemValue).toLowerCase() === String(filterValue).toLowerCase();
    case "not_equals":
      return String(itemValue).toLowerCase() !== String(filterValue).toLowerCase();
    case "gt":
      return Number(itemValue) > Number(filterValue);
    case "lt":
      return Number(itemValue) < Number(filterValue);
    default:
      return false;
  }
}

export const handleResultFilter: ToolHandler = async (
  ctx: ToolContext,
  args: Record<string, any>,
): Promise<string> => {
  const { collectionId, field, operator, value, fields } = args;

  if (!collectionId) return "Error: collectionId is required.";
  if (!field) return "Error: field is required.";
  if (!operator) return "Error: operator is required (contains, equals, not_equals, gt, lt).";
  if (value === undefined || value === null) return "Error: value is required.";

  const validOps: FilterOp[] = ["contains", "equals", "not_equals", "gt", "lt"];
  if (!validOps.includes(operator as FilterOp)) {
    return `Error: invalid operator "${operator}". Use one of: ${validOps.join(", ")}`;
  }

  const resolved = await resolveCollection(ctx.deviceId, collectionId);
  if (typeof resolved === "string") return resolved;

  const { ref, rawData } = resolved;
  const items = extractItems(rawData, ref.hints);

  // Filter items
  const matchingIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const itemValue = getDeepValue(items[i], field);
    if (matchesFilter(itemValue, operator as FilterOp, value)) {
      matchingIndices.push(i);
    }
  }

  if (matchingIndices.length === 0) {
    return `No items match: ${field} ${operator} "${value}" (searched ${items.length} items in ${collectionId}).`;
  }

  // Build summary table for matching items
  const displayFields = fields?.length ? fields : ref.hints.summaryFields;
  const displayIndices = matchingIndices.slice(0, MAX_FILTER_RESULTS);

  const headerLabels = displayFields.map((f: string) => {
    const bracketMatch = f.match(/\[(.+)\]$/);
    if (bracketMatch) return bracketMatch[1];
    const parts = f.split(".");
    return parts[parts.length - 1];
  });

  const lines: string[] = [];
  lines.push(`${matchingIndices.length} items match: ${field} ${operator} "${value}"`);
  lines.push("");
  lines.push(`| # | ${headerLabels.join(" | ")} |`);
  lines.push(`|---|${headerLabels.map(() => "---").join("|")}|`);

  for (const idx of displayIndices) {
    const item = items[idx];
    const summary = extractSummaryFields(item, displayFields);
    const cells = displayFields.map((f: string) => formatFilterCell(summary[f]));
    lines.push(`| ${idx} | ${cells.join(" | ")} |`);
  }

  if (matchingIndices.length > MAX_FILTER_RESULTS) {
    lines.push("");
    lines.push(`...and ${matchingIndices.length - MAX_FILTER_RESULTS} more matches.`);
  }

  lines.push("");
  lines.push(`Use result.get("${collectionId}", index) for full item details.`);

  return lines.join("\n");
};

// ============================================
// result.query
// ============================================

/** Max output length for query results. */
const MAX_QUERY_OUTPUT = 8_000;

export const handleResultQuery: ToolHandler = async (
  ctx: ToolContext,
  args: Record<string, any>,
): Promise<string> => {
  const { collectionId, expression } = args;

  if (!collectionId) return "Error: collectionId is required.";
  if (!expression) return "Error: expression is required.";

  const resolved = await resolveCollection(ctx.deviceId, collectionId);
  if (typeof resolved === "string") return resolved;

  const { ref, rawData } = resolved;
  const items = extractItems(rawData, ref.hints);

  try {
    const result = evaluateExpression(items, expression);
    const output = JSON.stringify(result, null, 2);
    if (output.length > MAX_QUERY_OUTPUT) {
      const truncated = output.substring(0, MAX_QUERY_OUTPUT);
      return `Query: ${expression}\n\n${truncated}\n\n...[truncated — ${output.length} chars total. Use result.filter to narrow first.]`;
    }
    const count = Array.isArray(result) ? `${result.length} results` : "1 result";
    return `Query: ${expression} — ${count}\n\n${output}`;
  } catch (err) {
    return `Error evaluating expression: ${err instanceof Error ? err.message : String(err)}`;
  }
};

/**
 * Evaluate a JSONPath-like expression against collection items.
 *
 * Supported patterns:
 *   [*].field                — extract a field from all items
 *   [*].field1,field2        — extract multiple fields from all items
 *   [0:5].field              — extract from a slice (0-4)
 *   [?status=="active"]      — filter items by field value
 *   [?score>7].name          — filter then project
 *   .length                  — count of items
 *   [*].field | unique       — unique values
 *   [*].field | count        — count grouped by value
 */
function evaluateExpression(items: unknown[], expression: string): unknown {
  const expr = expression.trim();

  // Handle pipe operators
  const pipeIdx = expr.indexOf(" | ");
  if (pipeIdx !== -1) {
    const mainExpr = expr.substring(0, pipeIdx).trim();
    const pipeOp = expr.substring(pipeIdx + 3).trim().toLowerCase();
    const intermediate = evaluateExpression(items, mainExpr);

    if (!Array.isArray(intermediate)) {
      throw new Error(`Pipe operator "${pipeOp}" requires an array input`);
    }

    switch (pipeOp) {
      case "unique":
        return [...new Set(intermediate.map(v => typeof v === "object" ? JSON.stringify(v) : String(v)))];
      case "count": {
        const counts: Record<string, number> = {};
        for (const v of intermediate) {
          const key = v === null || v === undefined ? "(null)" : String(v);
          counts[key] = (counts[key] || 0) + 1;
        }
        return counts;
      }
      case "sum": {
        return intermediate.reduce((sum, v) => sum + (Number(v) || 0), 0);
      }
      case "avg": {
        const nums = intermediate.filter(v => typeof v === "number" || !isNaN(Number(v)));
        if (nums.length === 0) return 0;
        return nums.reduce((sum, v) => sum + Number(v), 0) / nums.length;
      }
      case "min":
        return Math.min(...intermediate.map(Number).filter(n => !isNaN(n)));
      case "max":
        return Math.max(...intermediate.map(Number).filter(n => !isNaN(n)));
      default:
        throw new Error(`Unknown pipe operator: "${pipeOp}". Supported: unique, count, sum, avg, min, max`);
    }
  }

  // .length — item count
  if (expr === ".length" || expr === "length") {
    return items.length;
  }

  // Parse main expression
  let workingItems = items;
  let remaining = expr;

  // Handle slice/filter prefix: [*], [0:5], [?condition]
  const bracketMatch = remaining.match(/^\[([^\]]+)\]/);
  if (bracketMatch) {
    const inner = bracketMatch[1];
    remaining = remaining.substring(bracketMatch[0].length);
    // Remove leading dot
    if (remaining.startsWith(".")) remaining = remaining.substring(1);

    if (inner === "*") {
      // All items — no filtering needed
    } else if (inner.includes(":")) {
      // Slice: [0:5]
      const [startStr, endStr] = inner.split(":");
      const start = parseInt(startStr, 10) || 0;
      const end = endStr ? parseInt(endStr, 10) : workingItems.length;
      workingItems = workingItems.slice(start, end);
    } else if (inner.startsWith("?")) {
      // Filter: [?status=="active"] or [?score>7]
      const condition = inner.substring(1);
      workingItems = workingItems.filter(item => evaluateCondition(item, condition));
    } else {
      // Single index: [3]
      const idx = parseInt(inner, 10);
      if (isNaN(idx) || idx < 0 || idx >= workingItems.length) {
        throw new Error(`Index ${inner} out of range (0-${workingItems.length - 1})`);
      }
      if (!remaining) return workingItems[idx];
      return getDeepValue(workingItems[idx], remaining);
    }
  }

  // No projection field — return filtered items
  if (!remaining) {
    return workingItems;
  }

  // Project field(s): field or field1,field2
  const fields = remaining.split(",").map(f => f.trim());

  if (fields.length === 1) {
    // Single field — return flat array of values
    return workingItems.map(item => getDeepValue(item, fields[0]));
  }

  // Multiple fields — return array of objects
  return workingItems.map(item => {
    const obj: Record<string, unknown> = {};
    for (const field of fields) {
      const label = field.includes(".") ? field.split(".").pop()! : field;
      obj[label] = getDeepValue(item, field);
    }
    return obj;
  });
}

/**
 * Evaluate a filter condition like: status=="active" or score>7
 */
function evaluateCondition(item: unknown, condition: string): boolean {
  // Match: field operator value
  const match = condition.match(/^(\S+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) return false;

  const [, field, op, rawValue] = match;
  const itemValue = getDeepValue(item, field);
  if (itemValue === null || itemValue === undefined) return false;

  // Unquote the comparison value
  let compareValue: string | number = rawValue.replace(/^["']|["']$/g, "");
  const numValue = Number(compareValue);
  if (!isNaN(numValue) && rawValue === compareValue) {
    compareValue = numValue;
  }

  switch (op) {
    case "==": return String(itemValue).toLowerCase() === String(compareValue).toLowerCase();
    case "!=": return String(itemValue).toLowerCase() !== String(compareValue).toLowerCase();
    case ">":  return Number(itemValue) > Number(compareValue);
    case "<":  return Number(itemValue) < Number(compareValue);
    case ">=": return Number(itemValue) >= Number(compareValue);
    case "<=": return Number(itemValue) <= Number(compareValue);
    default: return false;
  }
}

// ============================================
// INTERNAL HELPERS
// ============================================

function getDeepValue(obj: unknown, path: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;

  // Handle bracket notation: "payload.headers[From]"
  const bracketMatch = path.match(/^(.+)\[(.+)\]$/);
  if (bracketMatch) {
    const parentPath = bracketMatch[1];
    const lookupKey = bracketMatch[2];
    const parent = getDeepValue(obj, parentPath);
    if (Array.isArray(parent)) {
      const entry = parent.find(
        (e: any) => typeof e === "object" && e !== null && e.name === lookupKey,
      );
      return entry ? (entry as any).value : undefined;
    }
    return undefined;
  }

  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function formatFilterCell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return value.join(", ").substring(0, 80);
  if (typeof value === "object") return JSON.stringify(value).substring(0, 80);
  const str = String(value);
  return str.length > 80 ? str.substring(0, 77) + "..." : str;
}
