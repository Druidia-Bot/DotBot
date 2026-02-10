/**
 * Visual Grounding Tests — Production Grade
 * 
 * Tests for findInManifest — the pure SoM manifest search function.
 * No Playwright needed; operates on SoMElement arrays directly.
 */

import { describe, it, expect } from "vitest";
import { findInManifest } from "./visual-grounding.js";
import type { SoMElement } from "./set-of-marks.js";

// ============================================
// TEST DATA
// ============================================

function makeSoM(overrides: Partial<SoMElement> & { id: number; tag: string; text: string }): SoMElement {
  return {
    role: "",
    ariaLabel: undefined,
    placeholder: undefined,
    rect: { x: 0, y: 0, width: 100, height: 30 },
    ...overrides,
  } as SoMElement;
}

const SAMPLE_ELEMENTS: SoMElement[] = [
  makeSoM({ id: 1, tag: "button", text: "Submit", role: "button" }),
  makeSoM({ id: 2, tag: "a", text: "Home", role: "link" }),
  makeSoM({ id: 3, tag: "input", text: "", placeholder: "Search...", role: "textbox" }),
  makeSoM({ id: 4, tag: "button", text: "Cancel", role: "button" }),
  makeSoM({ id: 5, tag: "a", text: "About Us", role: "link", ariaLabel: "about page" }),
  makeSoM({ id: 6, tag: "[role=tab]", text: "Settings", role: "tab" }),
  makeSoM({ id: 7, tag: "select", text: "Country", role: "combobox" }),
];

// ============================================
// EMPTY MANIFEST
// ============================================

describe("findInManifest — empty manifest", () => {
  it("returns error when no elements on page", () => {
    const result = findInManifest([], "submit", "");
    expect(result.found).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(result.error).toContain("No interactive elements");
  });
});

// ============================================
// TEXT MATCHING
// ============================================

describe("findInManifest — text matching", () => {
  it("finds exact text match", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "submit", "");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(1);
    expect(result.best_match?.text).toBe("Submit");
  });

  it("finds exact ariaLabel match", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "about page", "");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(5);
  });

  it("finds exact placeholder match", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "search...", "");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(3);
  });

  it("falls back to partial text match", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "about", "");
    expect(result.found).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    // Should match "About Us" (text) or "about page" (ariaLabel)
    expect(result.best_match?.id).toBe(5);
  });

  it("partial match on placeholder", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "search", "");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(3);
  });

  it("returns not found for non-existent text", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "nonexistent", "");
    expect(result.found).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(result.error).toContain("No element matching");
    expect(result.error).toContain("7 interactive elements");
  });

  it("expects lowercased text (caller normalizes)", () => {
    // findInManifest expects text to be pre-lowercased (caller does .toLowerCase())
    const result = findInManifest(SAMPLE_ELEMENTS, "submit", "");
    expect(result.found).toBe(true);
    expect(result.best_match?.text).toBe("Submit");
  });
});

// ============================================
// TYPE FILTERING
// ============================================

describe("findInManifest — type filtering", () => {
  it("filters by button type", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "", "button");
    expect(result.found).toBe(true);
    expect(result.matches.length).toBe(2);
    expect(result.matches.every(m => m.tag === "button" || m.role === "button")).toBe(true);
  });

  it("filters by link type", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "", "link");
    expect(result.found).toBe(true);
    expect(result.matches.length).toBe(2);
    expect(result.matches.every(m => m.tag === "a")).toBe(true);
  });

  it("filters by input type", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "", "input");
    expect(result.found).toBe(true);
    expect(result.matches.some(m => m.tag === "input")).toBe(true);
  });

  it("filters by tab type", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "", "tab");
    expect(result.found).toBe(true);
    expect(result.matches.length).toBe(1);
    expect(result.best_match?.text).toBe("Settings");
  });

  it("radio type filter also matches input elements (broad tag mapping)", () => {
    // radio maps to ["[role=radio]", "input"], so any <input> element matches
    const result = findInManifest(SAMPLE_ELEMENTS, "", "radio");
    expect(result.found).toBe(true);
    expect(result.matches.some(m => m.tag === "input")).toBe(true);
  });

  it("returns not found for type with no matches", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "", "menu_item");
    expect(result.found).toBe(false);
    expect(result.error).toContain("No elements of type");
  });
});

// ============================================
// COMBINED TEXT + TYPE
// ============================================

describe("findInManifest — combined text + type", () => {
  it("filters by both text and type", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "submit", "button");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(1);
  });

  it("returns not found when text exists but not for that type", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "home", "button");
    expect(result.found).toBe(false);
    // "Home" exists but is a link, not a button
    expect(result.error).toContain("No element matching");
  });

  it("finds partial text within type filter", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "canc", "button");
    expect(result.found).toBe(true);
    expect(result.best_match?.text).toBe("Cancel");
  });
});

// ============================================
// EDGE CASES
// ============================================

describe("findInManifest — edge cases", () => {
  it("prefers exact match over partial match", () => {
    const elements: SoMElement[] = [
      makeSoM({ id: 1, tag: "button", text: "Sub" }),
      makeSoM({ id: 2, tag: "button", text: "Submit" }),
    ];
    const result = findInManifest(elements, "sub", "");
    expect(result.found).toBe(true);
    // Exact match for "sub" is element 1
    expect(result.best_match?.id).toBe(1);
  });

  it("returns all partial matches", () => {
    const elements: SoMElement[] = [
      makeSoM({ id: 1, tag: "button", text: "Save Draft" }),
      makeSoM({ id: 2, tag: "button", text: "Save & Publish" }),
      makeSoM({ id: 3, tag: "button", text: "Cancel" }),
    ];
    const result = findInManifest(elements, "save", "");
    expect(result.found).toBe(true);
    expect(result.matches.length).toBe(2);
  });

  it("handles empty text and empty type gracefully", () => {
    // This shouldn't happen in practice (caller validates), but shouldn't crash
    const result = findInManifest(SAMPLE_ELEMENTS, "", "");
    // With no filters, returns all elements
    expect(result.found).toBe(true);
    expect(result.matches.length).toBe(SAMPLE_ELEMENTS.length);
  });
});
