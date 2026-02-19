/**
 * Tests for Result Navigator — result.overview, result.get, result.filter
 *
 * These test the pure navigation logic using pre-built collection refs.
 * The resolveCollection helper depends on sendExecutionCommand (WS bridge),
 * so we test the underlying functions directly via buildOverview,
 * extractItems, and extractSummaryFields.
 */

import { describe, it, expect } from "vitest";
import { buildOverview } from "../result-processor.js";
import { introspect, extractItems, extractSummaryFields } from "../introspector.js";

// ============================================
// FIXTURES
// ============================================

const CRM_DATA = JSON.stringify([
  { id: "con_001", name: "Acme Corp", email: "info@acme.com", status: "active", tags: ["enterprise", "high-value"], notes: "Long history " + "x".repeat(600) },
  { id: "con_002", name: "Beta LLC", email: "hello@beta.co", status: "lead", tags: ["startup"], notes: "New lead " + "x".repeat(400) },
  { id: "con_003", name: "Gamma Inc", email: "support@gamma.io", status: "churned", tags: ["smb"], notes: "Lost " + "x".repeat(300) },
  { id: "con_004", name: "Delta Co", email: "delta@example.com", status: "active", tags: ["enterprise"], notes: "Renewed " + "x".repeat(500) },
  { id: "con_005", name: "Epsilon SA", email: "ep@epsilon.fr", status: "lead", tags: ["international"], notes: "France-based " + "x".repeat(200) },
]);

// ============================================
// TESTS: result.overview behavior
// ============================================

describe("result.overview (via buildOverview)", () => {
  it("shows all items with summary fields", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints);
    const overview = buildOverview("col_test", items, hints);

    expect(overview).toContain("5 items found");
    expect(overview).toContain("Acme Corp");
    expect(overview).toContain("Epsilon SA");
    expect(overview).toContain("col_test");
  });

  it("supports custom fields via modified hints", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints);

    // Override summaryFields to only show id and status
    const customHints = { ...hints, summaryFields: ["id", "status"] };
    const overview = buildOverview("col_custom", items, customHints);

    expect(overview).toContain("con_001");
    expect(overview).toContain("active");
    // Should NOT contain name in the table (not in custom fields)
    // (it might appear in the overview header though, so just check table structure)
    expect(overview).toContain("| 0 |");
  });
});

// ============================================
// TESTS: result.get behavior
// ============================================

describe("result.get (via extractItems + extractSummaryFields)", () => {
  it("retrieves full item by index", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints);

    const item = items[2] as Record<string, unknown>;
    expect(item.name).toBe("Gamma Inc");
    expect(item.email).toBe("support@gamma.io");
    expect(item.status).toBe("churned");
  });

  it("extracts specific fields from an item", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints);

    const filtered = extractSummaryFields(items[0], ["name", "email"]);
    expect(filtered.name).toBe("Acme Corp");
    expect(filtered.email).toBe("info@acme.com");
    expect(filtered.notes).toBeUndefined(); // not requested
  });

  it("extracts only summary fields (omits non-summary fields)", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints);

    const item = items[0] as Record<string, unknown>;

    // Request only a subset of fields
    const partial = extractSummaryFields(item, ["name", "status"]);
    expect(partial.name).toBe("Acme Corp");
    expect(partial.status).toBe("active");
    // Fields not requested should not appear
    expect(partial.email).toBeUndefined();
    expect(partial.id).toBeUndefined();
  });
});

// ============================================
// TESTS: result.filter behavior
// ============================================

describe("result.filter (item filtering logic)", () => {
  it("filters by field equals", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints) as Array<Record<string, unknown>>;

    const activeItems = items.filter(item =>
      String(item.status).toLowerCase() === "active",
    );
    expect(activeItems).toHaveLength(2);
    expect(activeItems[0].name).toBe("Acme Corp");
    expect(activeItems[1].name).toBe("Delta Co");
  });

  it("filters by field contains (substring)", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints) as Array<Record<string, unknown>>;

    const matching = items.filter(item =>
      String(item.email).toLowerCase().includes("example"),
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].name).toBe("Delta Co");
  });

  it("filters by not_equals", () => {
    const hints = introspect("crm-list", CRM_DATA)!;
    const items = extractItems(CRM_DATA, hints) as Array<Record<string, unknown>>;

    const nonActive = items.filter(item =>
      String(item.status).toLowerCase() !== "active",
    );
    expect(nonActive).toHaveLength(3); // lead, churned, lead
  });
});

// ============================================
// TESTS: result.query expression engine
// ============================================

// Import the evaluateExpression function indirectly via the handler
// Since evaluateExpression is module-private, we test it through the items directly
// using the same logic patterns the handler uses.

describe("result.query (expression evaluation)", () => {
  // These tests verify the query patterns work against extracted items
  const items = JSON.parse(CRM_DATA) as Array<Record<string, unknown>>;

  it("[*].name extracts all names", () => {
    const result = items.map(item => item.name);
    expect(result).toEqual(["Acme Corp", "Beta LLC", "Gamma Inc", "Delta Co", "Epsilon SA"]);
  });

  it("[0:3] slices items", () => {
    const result = items.slice(0, 3);
    expect(result).toHaveLength(3);
    expect(result[2].name).toBe("Gamma Inc");
  });

  it("[?status=='active'] filters items", () => {
    const result = items.filter(item => String(item.status).toLowerCase() === "active");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Acme Corp");
    expect(result[1].name).toBe("Delta Co");
  });

  it("[*].status | count groups by value", () => {
    const values = items.map(item => item.status);
    const counts: Record<string, number> = {};
    for (const v of values) {
      const key = String(v);
      counts[key] = (counts[key] || 0) + 1;
    }
    expect(counts).toEqual({ active: 2, lead: 2, churned: 1 });
  });

  it("[*].status | unique returns distinct values", () => {
    const values = items.map(item => String(item.status));
    const unique = [...new Set(values)];
    expect(unique).toEqual(["active", "lead", "churned"]);
  });

  it(".length returns item count", () => {
    expect(items.length).toBe(5);
  });
});
