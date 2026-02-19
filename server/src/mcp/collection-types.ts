/**
 * Collection Types — Shared type definitions for the collection pipeline.
 *
 * Used by: introspector, hint-store, result-processor, result-navigator.
 */

/** Structural hints for an MCP tool's output. Learned on first call, cached. */
export interface OutputHints {
  toolId: string;
  lastChecked: string;                    // ISO timestamp
  format: "json" | "json-lines" | "csv" | "plain-text";
  arrayPath: string;                      // dot-path to main array ("ret", "", "data.items")
  sampleItemCount: number;
  itemFields: Record<string, FieldHint>;
  summaryFields: string[];                // small + useful
  noiseFields: string[];                  // large + noisy
  estimatedItemSize: number;              // avg chars per item
}

/** Per-field metadata for items in a collection. */
export interface FieldHint {
  type: string;                           // "string" | "number" | "boolean" | "array" | "object"
  avgSize: number;
  summary: boolean;
  depth: number;                          // 0 = direct field, 1+ = nested
  path?: string;                          // dot-path if nested
}

/** Reference to an active collection (in-memory, 30min TTL). */
export interface CollectionRef {
  collectionId: string;
  filePath: string;                       // absolute path to cache file
  toolId: string;
  hints: OutputHints;
  cachedAt: string;
  itemCount: number;
}
