/**
 * Tests for Hint Store — in-memory cache with staleness check.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { loadHints, saveHints, clearHints, hintsAreStale } from "../hint-store.js";
import type { OutputHints } from "../collection-types.js";

function makeHints(overrides: Partial<OutputHints> = {}): OutputHints {
  return {
    toolId: "test-tool",
    lastChecked: new Date().toISOString(),
    format: "json",
    arrayPath: "items",
    sampleItemCount: 5,
    itemFields: {
      id: { type: "string", avgSize: 10, summary: true, depth: 0 },
    },
    summaryFields: ["id"],
    noiseFields: [],
    estimatedItemSize: 100,
    ...overrides,
  };
}

describe("hint-store", () => {
  beforeEach(() => {
    clearHints("test-tool");
    clearHints("other-tool");
  });

  it("returns null for unknown toolId", () => {
    expect(loadHints("nonexistent-tool")).toBeNull();
  });

  it("saves and loads hints by toolId", () => {
    const hints = makeHints();
    saveHints(hints);

    const loaded = loadHints("test-tool");
    expect(loaded).not.toBeNull();
    expect(loaded!.toolId).toBe("test-tool");
    expect(loaded!.arrayPath).toBe("items");
    expect(loaded!.summaryFields).toEqual(["id"]);
  });

  it("overwrites existing hints on save", () => {
    saveHints(makeHints({ arrayPath: "old" }));
    saveHints(makeHints({ arrayPath: "new" }));

    const loaded = loadHints("test-tool");
    expect(loaded!.arrayPath).toBe("new");
  });

  it("clears hints for a specific toolId", () => {
    saveHints(makeHints({ toolId: "test-tool" }));
    saveHints(makeHints({ toolId: "other-tool" }));

    clearHints("test-tool");

    expect(loadHints("test-tool")).toBeNull();
    expect(loadHints("other-tool")).not.toBeNull();
  });

  it("hintsAreStale returns false for fresh hints", () => {
    const hints = makeHints({ lastChecked: new Date().toISOString() });
    expect(hintsAreStale(hints)).toBe(false);
  });

  it("hintsAreStale returns true for old hints", () => {
    const twoWeeksAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const hints = makeHints({ lastChecked: twoWeeksAgo.toISOString() });
    expect(hintsAreStale(hints)).toBe(true);
  });
});
