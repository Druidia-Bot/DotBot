/**
 * Collection Introspector — Deterministic JSON Structure Analysis
 *
 * Analyzes a raw MCP tool result to discover its structure:
 * - Detects format (JSON, plain-text)
 * - Finds the main array (walks up to 3 levels deep)
 * - Samples items to classify fields as summary vs noise
 *
 * Pure functions. No LLM calls. No network. Runs in <50ms.
 */

import type { OutputHints, FieldHint } from "./collection-types.js";

/** Threshold: fields with avgSize below this are candidates for summaryFields. */
const SUMMARY_SIZE_THRESHOLD = 500;

/** Threshold: fields with avgSize above this are classified as noise. */
const NOISE_SIZE_THRESHOLD = 500;

/** Noise threshold for object/array fields (higher — small arrays are ok). */
const NOISE_OBJECT_THRESHOLD = 1000;

/** Max number of items to sample for field classification. */
const SAMPLE_SIZE = 3;

/** Max recursion depth when enumerating fields. */
const MAX_FIELD_DEPTH = 3;

/**
 * Introspect a raw MCP tool result and return structural hints.
 *
 * Returns null if the result is not a collection (no array found).
 */
export function introspect(toolId: string, raw: string): OutputHints | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON — try CSV, then fall back to plain-text
    const csvResult = tryParseCSV(raw);
    if (csvResult) {
      return buildCSVHints(toolId, csvResult.headers, csvResult.rows, raw.length);
    }

    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    if (lines.length < 2) return null;
    return {
      toolId,
      lastChecked: new Date().toISOString(),
      format: "plain-text",
      arrayPath: "",
      sampleItemCount: lines.length,
      itemFields: {
        line: { type: "string", avgSize: Math.round(raw.length / lines.length), summary: true, depth: 0 },
      },
      summaryFields: ["line"],
      noiseFields: [],
      estimatedItemSize: Math.round(raw.length / lines.length),
    };
  }

  // Find the array
  const arrayResult = findArray(parsed);
  if (!arrayResult) return null;

  const { path: arrayPath, items } = arrayResult;
  if (items.length === 0) return null;

  // Sample items and analyze fields
  const sampleItems = items.slice(0, SAMPLE_SIZE);
  const fieldStats = analyzeFields(sampleItems);

  // Classify fields
  const summaryFields: string[] = [];
  const noiseFields: string[] = [];
  const itemFields: Record<string, FieldHint> = {};

  for (const [fieldPath, stats] of fieldStats) {
    const avgSize = Math.round(stats.totalSize / stats.count);
    const isSummary = classifyAsSummary(stats.type, avgSize);
    const isNoise = classifyAsNoise(stats.type, avgSize);

    const hint: FieldHint = {
      type: stats.type,
      avgSize,
      summary: isSummary,
      depth: fieldPath.split(".").length - 1,
      ...(fieldPath.includes(".") && { path: fieldPath }),
    };

    itemFields[fieldPath] = hint;

    if (isSummary) summaryFields.push(fieldPath);
    if (isNoise) noiseFields.push(fieldPath);
  }

  // Promote small values inside noise parents (e.g., "From" inside payload.headers)
  promoteNestedSummaryFields(sampleItems, noiseFields, summaryFields, itemFields);

  // Estimate item size
  const estimatedItemSize = sampleItems.reduce<number>(
    (sum, item) => sum + JSON.stringify(item).length,
    0,
  ) / sampleItems.length;

  return {
    toolId,
    lastChecked: new Date().toISOString(),
    format: "json",
    arrayPath,
    sampleItemCount: items.length,
    itemFields,
    summaryFields,
    noiseFields,
    estimatedItemSize: Math.round(estimatedItemSize),
  };
}

/**
 * Check if existing hints still match the actual data structure.
 * Returns false if the data has changed shape.
 */
export function hintsMatchStructure(hints: OutputHints, raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (hints.format === "csv") {
      const csvResult = tryParseCSV(raw);
      if (!csvResult) return false;
      const matchedCols = hints.summaryFields.filter(f => csvResult.headers.includes(f));
      return matchedCols.length >= Math.ceil(hints.summaryFields.length / 2);
    }
    return hints.format === "plain-text";
  }

  // Verify arrayPath resolves
  const items = resolveArrayPath(parsed, hints.arrayPath);
  if (!items || items.length === 0) return false;

  // Verify first item has at least half the expected summary fields
  const firstItem = items[0];
  if (typeof firstItem !== "object" || firstItem === null) return false;

  const matchedFields = hints.summaryFields.filter(f => {
    const topKey = f.split(".")[0];
    return topKey in (firstItem as Record<string, unknown>);
  });

  return matchedFields.length >= Math.ceil(hints.summaryFields.length / 2);
}

/**
 * Extract items from raw data using hints.
 */
export function extractItems(raw: string, hints: OutputHints): unknown[] {
  if (hints.format === "csv") {
    const csvResult = tryParseCSV(raw);
    if (!csvResult) return [];
    return csvResult.rows.map(row => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < csvResult.headers.length; i++) {
        obj[csvResult.headers[i]] = row[i] ?? "";
      }
      return obj;
    });
  }

  if (hints.format === "plain-text") {
    return raw.split("\n").filter(l => l.trim().length > 0).map(line => ({ line }));
  }

  try {
    const parsed = JSON.parse(raw);
    return resolveArrayPath(parsed, hints.arrayPath) ?? [];
  } catch {
    return [];
  }
}

/**
 * Extract summary fields from an item, producing a flat key→value object.
 */
export function extractSummaryFields(
  item: unknown,
  summaryFields: string[],
): Record<string, unknown> {
  if (typeof item !== "object" || item === null) return {};

  const result: Record<string, unknown> = {};
  for (const fieldPath of summaryFields) {
    const value = getNestedValue(item, fieldPath);
    if (value !== undefined) {
      result[fieldPath] = value;
    }
  }
  return result;
}

// ============================================
// INTERNAL: Array finding
// ============================================

interface ArrayResult {
  path: string;
  items: unknown[];
}

function findArray(parsed: unknown, currentPath = "", depth = 0): ArrayResult | null {
  if (depth > MAX_FIELD_DEPTH) return null;

  // Root is array
  if (Array.isArray(parsed) && parsed.length > 0) {
    return { path: currentPath, items: parsed };
  }

  // Root is object — look for array values
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    // First pass: direct array children
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key]) && (obj[key] as unknown[]).length > 0) {
        const path = currentPath ? `${currentPath}.${key}` : key;
        return { path, items: obj[key] as unknown[] };
      }
    }
    // Second pass: recurse one level into object children
    if (depth < 2) {
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
          const path = currentPath ? `${currentPath}.${key}` : key;
          const result = findArray(obj[key], path, depth + 1);
          if (result) return result;
        }
      }
    }
  }

  return null;
}

function resolveArrayPath(parsed: unknown, arrayPath: string): unknown[] | null {
  if (arrayPath === "") {
    return Array.isArray(parsed) ? parsed : null;
  }

  let current: unknown = parsed;
  for (const key of arrayPath.split(".")) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }

  return Array.isArray(current) ? current : null;
}

// ============================================
// INTERNAL: Field analysis
// ============================================

interface FieldStats {
  type: string;
  totalSize: number;
  count: number;
}

function analyzeFields(items: unknown[]): Map<string, FieldStats> {
  const stats = new Map<string, FieldStats>();

  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    enumerateFields(item as Record<string, unknown>, "", 0, stats);
  }

  return stats;
}

function enumerateFields(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number,
  stats: Map<string, FieldStats>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const type = getType(value);
    const size = estimateSize(value);

    const existing = stats.get(path);
    if (existing) {
      existing.totalSize += size;
      existing.count++;
    } else {
      stats.set(path, { type, totalSize: size, count: 1 });
    }

    // Don't recurse into arrays or deep objects for top-level field analysis
    // (the depth-0 fields are what matter for the overview)
    // But DO track the top-level field's total size including children
  }
}

function getType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function estimateSize(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  // For objects and arrays, stringify to get approximate size
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

// ============================================
// INTERNAL: Field classification
// ============================================

function classifyAsSummary(type: string, avgSize: number): boolean {
  if (type === "string" || type === "number" || type === "boolean") {
    return avgSize < SUMMARY_SIZE_THRESHOLD;
  }
  if (type === "array") {
    // Small arrays (like labelIds) are useful in summaries
    return avgSize < SUMMARY_SIZE_THRESHOLD;
  }
  return false;
}

function classifyAsNoise(type: string, avgSize: number): boolean {
  if (type === "object" || type === "array") {
    return avgSize > NOISE_OBJECT_THRESHOLD;
  }
  return avgSize > NOISE_SIZE_THRESHOLD;
}

/**
 * Promote useful entries from a {name, value} array (e.g., HTTP headers).
 */
function promoteFromNameValueArray(
  arr: unknown[],
  arrayPath: string,
  parentNoisePath: string,
  summaryFields: string[],
  itemFields: Record<string, FieldHint>,
): void {
  for (const entry of arr) {
    if (
      typeof entry === "object" && entry !== null &&
      "name" in entry && "value" in entry &&
      typeof (entry as any).name === "string" &&
      typeof (entry as any).value === "string"
    ) {
      const name = (entry as any).name as string;
      const value = (entry as any).value as string;
      if (value.length < 200 && isUsefulHeaderName(name)) {
        const promotedPath = `${arrayPath}[${name}]`;
        if (!summaryFields.includes(promotedPath)) {
          summaryFields.push(promotedPath);
          itemFields[promotedPath] = {
            type: "string",
            avgSize: value.length,
            summary: true,
            depth: parentNoisePath.split(".").length,
            path: promotedPath,
          };
        }
      }
    }
  }
}

/**
 * Look inside noise fields for small, useful values to promote.
 *
 * Example: payload.headers is a 4KB noise field, but individual headers
 * like "From" or "Subject" are small strings worth including in summaries.
 */
function promoteNestedSummaryFields(
  sampleItems: unknown[],
  noiseFields: string[],
  summaryFields: string[],
  itemFields: Record<string, FieldHint>,
): void {
  for (const noisePath of noiseFields) {
    for (const item of sampleItems) {
      const noiseValue = getNestedValue(item, noisePath);
      if (!noiseValue) continue;

      // Handle array of {name, value} objects (common pattern: HTTP headers)
      if (Array.isArray(noiseValue)) {
        promoteFromNameValueArray(noiseValue, noisePath, noisePath, summaryFields, itemFields);
        break; // Only need to check one sample item for the pattern
      }

      // Handle nested objects: promote small strings and recurse into array children
      if (typeof noiseValue === "object" && !Array.isArray(noiseValue)) {
        for (const [key, val] of Object.entries(noiseValue as Record<string, unknown>)) {
          if (typeof val === "string" && val.length < 200) {
            const promotedPath = `${noisePath}.${key}`;
            if (!summaryFields.includes(promotedPath)) {
              summaryFields.push(promotedPath);
              itemFields[promotedPath] = {
                type: "string",
                avgSize: val.length,
                summary: true,
                depth: noisePath.split(".").length + 1,
                path: promotedPath,
              };
            }
          }
          // Also check array children for {name, value} patterns (e.g., payload.headers)
          if (Array.isArray(val)) {
            promoteFromNameValueArray(val, `${noisePath}.${key}`, noisePath, summaryFields, itemFields);
          }
        }
        break;
      }
    }
  }
}

/** Header names worth promoting from noise arrays. */
const USEFUL_HEADERS = new Set([
  "from", "to", "subject", "date", "reply-to", "cc",
  "content-type", "x-mailer", "list-unsubscribe",
]);

function isUsefulHeaderName(name: string): boolean {
  return USEFUL_HEADERS.has(name.toLowerCase());
}

// ============================================
// INTERNAL: CSV parsing
// ============================================

interface CSVResult {
  headers: string[];
  rows: string[][];
}

/**
 * Attempt to parse raw text as CSV.
 * Returns null if the text doesn't look like CSV.
 *
 * Heuristics:
 *   - Must have at least 2 lines (header + data)
 *   - First line must have at least 2 comma-separated fields
 *   - At least 50% of data rows must have the same column count as the header
 */
function tryParseCSV(raw: string): CSVResult | null {
  const lines = raw.split("\n").map(l => l.trimEnd()).filter(l => l.length > 0);
  if (lines.length < 2) return null;

  const headerFields = parseCSVLine(lines[0]);
  if (headerFields.length < 2) return null;

  // Validate that headers look like column names (not long prose)
  if (headerFields.some(h => h.length > 100)) return null;

  const colCount = headerFields.length;
  const dataLines = lines.slice(1);
  const rows: string[][] = [];
  let matchingRows = 0;

  for (const line of dataLines) {
    const fields = parseCSVLine(line);
    rows.push(fields);
    if (fields.length === colCount) matchingRows++;
  }

  // At least 50% of rows must match header column count
  if (matchingRows < dataLines.length * 0.5) return null;

  return { headers: headerFields, rows };
}

/**
 * Parse a single CSV line, handling quoted fields.
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Build OutputHints from parsed CSV data.
 */
function buildCSVHints(
  toolId: string,
  headers: string[],
  rows: string[][],
  totalSize: number,
): OutputHints {
  const sampleRows = rows.slice(0, SAMPLE_SIZE);
  const itemFields: Record<string, FieldHint> = {};
  const summaryFields: string[] = [];
  const noiseFields: string[] = [];

  for (let col = 0; col < headers.length; col++) {
    const name = headers[col];
    const values = sampleRows.map(r => r[col] ?? "");
    const avgSize = Math.round(values.reduce((sum, v) => sum + v.length, 0) / values.length);
    const isSummary = avgSize < SUMMARY_SIZE_THRESHOLD;

    itemFields[name] = {
      type: "string",
      avgSize,
      summary: isSummary,
      depth: 0,
    };

    if (isSummary) summaryFields.push(name);
    else noiseFields.push(name);
  }

  const estimatedItemSize = Math.round(totalSize / (rows.length || 1));

  return {
    toolId,
    lastChecked: new Date().toISOString(),
    format: "csv",
    arrayPath: "",
    sampleItemCount: rows.length,
    itemFields,
    summaryFields,
    noiseFields,
    estimatedItemSize,
  };
}

// ============================================
// INTERNAL: Nested value access
// ============================================

function getNestedValue(obj: unknown, path: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;

  // Handle array-index notation: "payload.headers[From]"
  const bracketMatch = path.match(/^(.+)\[(.+)\]$/);
  if (bracketMatch) {
    const parentPath = bracketMatch[1];
    const lookupKey = bracketMatch[2];
    const parent = getNestedValue(obj, parentPath);
    if (Array.isArray(parent)) {
      // Find {name: lookupKey, value: ...} in the array
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
