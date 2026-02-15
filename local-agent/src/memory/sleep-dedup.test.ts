/**
 * Sleep Cycle — Deduplication Tests
 *
 * Tests the generic dedup engine and field-specific configs,
 * particularly open loop dedup with resolutionCriteria matching.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeWordOverlap } from "./sleep-llm.js";

// ============================================
// WORD OVERLAP (unit tests for the heuristic)
// ============================================

describe("computeWordOverlap", () => {
  it("identical strings return 1.0", () => {
    expect(computeWordOverlap("hello world foo", "hello world foo")).toBe(1);
  });

  it("completely different strings return 0", () => {
    expect(computeWordOverlap("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });

  it("partial overlap returns correct ratio", () => {
    const overlap = computeWordOverlap(
      "the quick brown fox jumps",
      "the quick red fox runs",
    );
    // Words > 2 chars: A=[the, quick, brown, fox, jumps], B=[the, quick, red, fox, runs]
    // setA = {the, quick, brown, fox, jumps}
    // B matching: the, quick, fox = 3 out of 5
    // max(5, 5) = 5 → 3/5 = 0.6
    expect(overlap).toBeCloseTo(0.6, 1);
  });

  it("filters words with 2 or fewer characters", () => {
    // "is" and "an" and "to" are all <= 2 chars, filtered out
    const overlap = computeWordOverlap(
      "this is an example",
      "this is an example to test",
    );
    // After filter: A=[this, example], B=[this, example, test]
    // overlap = 2, max(2, 3) = 3 → 2/3 ≈ 0.667
    expect(overlap).toBeCloseTo(0.667, 2);
  });
});

// ============================================
// OPEN LOOP PARAPHRASE DETECTION
// ============================================

describe("Open loop paraphrase detection", () => {
  it("description-only overlap for the reported bug case is below 0.8", () => {
    const descA = "User urgently needs help with open source product launch but hasn't provided any details about the product, timeline, goals, or specific help needed";
    const descB = "User needs help with open source product launch but hasn't specified what product, what kind of help is needed, timeline, goals, or target audience";

    const overlap = computeWordOverlap(descA, descB);
    // This is the bug: description-only overlap is ~0.68, below the old 0.8 threshold
    expect(overlap).toBeLessThan(0.8);
    expect(overlap).toBeGreaterThan(0.5); // But clearly related
  });

  it("combined description+resolutionCriteria overlap is higher", () => {
    const textA = "User urgently needs help with open source product launch but hasn't provided any details about the product, timeline, goals, or specific help needed | User provides details about the open source product, launch timeline, goals, target audience, and specific areas where help is needed";
    const textB = "User needs help with open source product launch but hasn't specified what product, what kind of help is needed, timeline, goals, or target audience | User provides details about the open source product, what specific help they need, timeline, goals, and target audience";

    const overlap = computeWordOverlap(textA, textB);
    // With resolution criteria included, overlap should be higher
    expect(overlap).toBeGreaterThan(0.65);
  });

  it("combined text overlap exceeds the 0.7 loop threshold", () => {
    const textA = "User urgently needs help with open source product launch but hasn't provided any details about the product, timeline, goals, or specific help needed | User provides details about the open source product, launch timeline, goals, target audience, and specific areas where help is needed";
    const textB = "User needs help with open source product launch but hasn't specified what product, what kind of help is needed, timeline, goals, or target audience | User provides details about the open source product, what specific help they need, timeline, goals, and target audience";

    const overlap = computeWordOverlap(textA, textB);
    expect(overlap).toBeGreaterThanOrEqual(0.7);
  });
});

// ============================================
// DEDUP ENGINE (via exported deduplicateModelFields)
// ============================================

// Mock store so deduplicateModelFields can persist
vi.mock("./store.js", () => ({
  saveMentalModel: vi.fn(),
}));

// Mock sleep-llm to control LLM fallback behavior
vi.mock("./sleep-llm.js", async () => {
  const actual = await vi.importActual("./sleep-llm.js");
  return {
    ...actual,
    // scoreSemantic uses computeWordOverlap internally — let it run real code
    // but override isLocalLLMReady to return false (no LLM during tests)
    isLocalLLMReady: vi.fn(() => Promise.resolve(false)),
  };
});

import { deduplicateModelFields } from "./sleep-dedup.js";

describe("deduplicateModelFields — open loops", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges paraphrased open loops with similar description+resolutionCriteria", async () => {
    const model = {
      slug: "test-model",
      name: "Test Model",
      openLoops: [
        {
          id: "loop_1",
          description: "User urgently needs help with open source product launch but hasn't provided any details about the product, timeline, goals, or specific help needed",
          resolutionCriteria: "User provides details about the open source product, launch timeline, goals, target audience, and specific areas where help is needed",
          importance: "high",
          status: "blocked",
          identifiedAt: "2026-02-14T00:00:00Z",
        },
        {
          id: "loop_2",
          description: "User needs help with open source product launch but hasn't specified what product, what kind of help is needed, timeline, goals, or target audience",
          resolutionCriteria: "User provides details about the open source product, what specific help they need, timeline, goals, and target audience",
          importance: "high",
          status: "open",
          identifiedAt: "2026-02-14T01:00:00Z",
        },
      ],
      beliefs: [],
      constraints: [],
      questions: [],
    };

    const removed = await deduplicateModelFields([model], null);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(model.openLoops.length).toBe(1);
  });

  it("does not merge genuinely different open loops", async () => {
    const model = {
      slug: "test-model",
      name: "Test Model",
      openLoops: [
        {
          id: "loop_1",
          description: "User wants to deploy a web application to production",
          resolutionCriteria: "Application is deployed and accessible",
          importance: "high",
          status: "open",
          identifiedAt: "2026-02-14T00:00:00Z",
        },
        {
          id: "loop_2",
          description: "User needs help debugging a memory leak in Python",
          resolutionCriteria: "Memory leak identified and fixed",
          importance: "high",
          status: "open",
          identifiedAt: "2026-02-14T01:00:00Z",
        },
      ],
      beliefs: [],
      constraints: [],
      questions: [],
    };

    const removed = await deduplicateModelFields([model], null);
    expect(removed).toBe(0);
    expect(model.openLoops.length).toBe(2);
  });

  it("keeps resolved loops untouched even if similar to open ones", async () => {
    const model = {
      slug: "test-model",
      name: "Test Model",
      openLoops: [
        {
          id: "loop_1",
          description: "User needs help with product launch",
          resolutionCriteria: "Launch plan created",
          importance: "high",
          status: "resolved",
          identifiedAt: "2026-02-14T00:00:00Z",
        },
        {
          id: "loop_2",
          description: "User needs help with product launch planning",
          resolutionCriteria: "Launch plan created and reviewed",
          importance: "high",
          status: "open",
          identifiedAt: "2026-02-14T01:00:00Z",
        },
      ],
      beliefs: [],
      constraints: [],
      questions: [],
    };

    const removed = await deduplicateModelFields([model], null);
    expect(removed).toBe(0);
    expect(model.openLoops.length).toBe(2);
  });
});
