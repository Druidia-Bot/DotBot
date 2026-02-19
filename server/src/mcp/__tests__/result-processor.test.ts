/**
 * Tests for Result Processor — overview builder and collection refs.
 *
 * The processMcpResult function relies on sendExecutionCommand (WS bridge),
 * so we test the pure functions directly: buildOverview, getCollectionRef.
 */

import { describe, it, expect } from "vitest";
import { buildOverview, getCollectionRef, getActiveCollections } from "../result-processor.js";
import { introspect, extractItems } from "../introspector.js";
import type { OutputHints } from "../collection-types.js";

// ============================================
// FIXTURES
// ============================================

const CRM_DATA = JSON.stringify([
  { id: "con_001", name: "Acme Corp", email: "info@acme.com", status: "active", tags: ["enterprise"] },
  { id: "con_002", name: "Beta LLC", email: "hello@beta.co", status: "lead", tags: ["startup"] },
  { id: "con_003", name: "Gamma Inc", email: "support@gamma.io", status: "churned", tags: ["smb"] },
]);

// ============================================
// TESTS: buildOverview()
// ============================================

describe("buildOverview", () => {
  it("generates a markdown table with correct headers", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints);
    const overview = buildOverview("col_test123", items, hints);

    // Should contain item count and collection ID
    expect(overview).toContain("3 items found");
    expect(overview).toContain("col_test123");

    // Should contain table structure
    expect(overview).toContain("|");
    expect(overview).toContain("---");

    // Should contain summary field values
    expect(overview).toContain("Acme Corp");
    expect(overview).toContain("Beta LLC");
    expect(overview).toContain("info@acme.com");
  });

  it("includes result.get hint in the output", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints);
    const overview = buildOverview("col_abc", items, hints);

    expect(overview).toContain('result.get("col_abc"');
    expect(overview).toContain('result.filter("col_abc"');
  });

  it("includes cache path info when provided", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints);
    const overview = buildOverview("col_abc", items, hints, "~/.bot/memory/research-cache/test.json");

    expect(overview).toContain("Full data cached");
  });

  it("handles empty summaryFields gracefully", () => {
    const emptyHints: OutputHints = {
      toolId: "test",
      lastChecked: new Date().toISOString(),
      format: "json",
      arrayPath: "",
      sampleItemCount: 2,
      itemFields: {},
      summaryFields: [],
      noiseFields: [],
      estimatedItemSize: 100,
    };

    const items = [{ a: 1 }, { b: 2 }];
    const overview = buildOverview("col_empty", items, emptyHints);

    expect(overview).toContain("2 items found");
    expect(overview).toContain("No summary fields detected");
    expect(overview).toContain('result.get("col_empty"');
  });

  it("handles empty items array", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const overview = buildOverview("col_none", [], hints);

    expect(overview).toContain("0 items found");
  });

  it("truncates long cell values", () => {
    const data = JSON.stringify([
      { id: "1", description: "A".repeat(200) },
      { id: "2", description: "B".repeat(200) },
    ]);
    const hints = introspect("test-tool", data)!;
    const items = extractItems(data, hints);
    const overview = buildOverview("col_trunc", items, hints);

    // Should not contain full 200-char string
    expect(overview).toContain("...");
    // But should contain truncated version
    expect(overview).toContain("A".repeat(77)); // 80 - 3 for "..."
  });

  it("shows overflow message when items exceed MAX_OVERVIEW_ITEMS", () => {
    // Create 30 items
    const manyItems = Array.from({ length: 30 }, (_, i) => ({
      id: `item_${i}`,
      name: `Item ${i}`,
    }));
    const data = JSON.stringify(manyItems);
    const hints = introspect("test-tool", data)!;
    const items = extractItems(data, hints);
    const overview = buildOverview("col_many", items, hints);

    expect(overview).toContain("30 items found");
    expect(overview).toContain("...and 5 more items");
  });
});

// ============================================
// TESTS: Collection ref store
// ============================================

describe("getCollectionRef / getActiveCollections", () => {
  it("returns null for unknown collection ID", () => {
    expect(getCollectionRef("nonexistent_id")).toBeNull();
  });

  it("getActiveCollections returns an array", () => {
    const active = getActiveCollections();
    expect(Array.isArray(active)).toBe(true);
  });
});
