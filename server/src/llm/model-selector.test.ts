/**
 * Tests for the model selection engine.
 * Verifies that task characteristics map to the correct model roles
 * and that fallback chains work when providers are unavailable.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  selectModel,
  registerApiKeys,
  estimateTokens,
  detectLargeFileContext,
  detectArchitectTask,
} from "./model-selector.js";

// ============================================
// SETUP: register all providers as available
// ============================================

beforeEach(() => {
  registerApiKeys({
    deepseek: "sk-test-deepseek",
    anthropic: "sk-test-anthropic",
    gemini: "test-gemini-key",
    openai: "sk-test-openai",
  });
});

// ============================================
// CORE SELECTION LOGIC
// ============================================

describe("selectModel — core routing", () => {
  it("defaults to workhorse (DeepSeek) with no criteria", () => {
    const result = selectModel({});
    expect(result.role).toBe("workhorse");
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-chat");
  });

  it("routes to deep_context for large file tasks", () => {
    const result = selectModel({ hasLargeFiles: true });
    expect(result.role).toBe("deep_context");
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-3-pro-preview");
  });

  it("routes to deep_context when estimated tokens exceed threshold", () => {
    const result = selectModel({ estimatedTokens: 60_000 });
    expect(result.role).toBe("deep_context");
    expect(result.provider).toBe("gemini");
  });

  it("stays workhorse when tokens are under threshold", () => {
    const result = selectModel({ estimatedTokens: 10_000 });
    expect(result.role).toBe("workhorse");
    expect(result.provider).toBe("deepseek");
  });

  it("routes to architect for complex design tasks", () => {
    const result = selectModel({ isArchitectTask: true });
    expect(result.role).toBe("architect");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("routes to architect for second opinions", () => {
    const result = selectModel({ isSecondOpinion: true });
    expect(result.role).toBe("architect");
    expect(result.provider).toBe("anthropic");
  });

  it("routes to local when offline", () => {
    const result = selectModel({ isOffline: true });
    expect(result.role).toBe("local");
    expect(result.provider).toBe("local");
    expect(result.model).toBe("qwen2.5-0.5b-instruct-q4_k_m");
  });

  it("honors explicit role override", () => {
    const result = selectModel({ explicitRole: "architect" });
    expect(result.role).toBe("architect");
    expect(result.provider).toBe("anthropic");
  });

  it("explicit role overrides other criteria", () => {
    const result = selectModel({
      explicitRole: "workhorse",
      hasLargeFiles: true,
      isArchitectTask: true,
    });
    expect(result.role).toBe("workhorse");
    expect(result.provider).toBe("deepseek");
  });

  it("maps legacy 'powerful' tier to architect", () => {
    const result = selectModel({ personaModelTier: "powerful" });
    expect(result.role).toBe("architect");
  });

  it("maps legacy 'smart' tier to workhorse", () => {
    const result = selectModel({ personaModelTier: "smart" });
    expect(result.role).toBe("workhorse");
  });

  it("maps legacy 'fast' tier to workhorse", () => {
    const result = selectModel({ personaModelTier: "fast" });
    expect(result.role).toBe("workhorse");
  });
});

// ============================================
// PRIORITY ORDER
// ============================================

describe("selectModel — priority order", () => {
  it("deep_context wins over architect when both triggered", () => {
    // Large files + architect task → deep_context checked first
    const result = selectModel({ hasLargeFiles: true, isArchitectTask: true });
    expect(result.role).toBe("deep_context");
  });

  it("offline wins over everything else", () => {
    const result = selectModel({
      isOffline: true,
      hasLargeFiles: true,
      isArchitectTask: true,
    });
    expect(result.role).toBe("local");
  });
});

// ============================================
// FALLBACK CHAINS
// ============================================

describe("selectModel — fallbacks when providers are unavailable", () => {
  it("falls back from DeepSeek to Gemini Flash when DeepSeek unavailable", () => {
    registerApiKeys({
      deepseek: "",
      anthropic: "sk-test",
      gemini: "test-key",
      openai: "sk-test",
    });
    const result = selectModel({});
    expect(result.role).toBe("workhorse");
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.reason).toContain("FALLBACK");
  });

  it("falls back from Gemini to Anthropic for deep_context", () => {
    registerApiKeys({
      deepseek: "sk-test",
      anthropic: "sk-test",
      gemini: "",
      openai: "",
    });
    const result = selectModel({ hasLargeFiles: true });
    expect(result.role).toBe("deep_context");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("falls back from Anthropic to DeepSeek Reasoner for architect", () => {
    registerApiKeys({
      deepseek: "sk-test",
      anthropic: "",
      gemini: "",
      openai: "",
    });
    const result = selectModel({ isArchitectTask: true });
    expect(result.role).toBe("architect");
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-reasoner");
  });

  it("local stays on local provider (no key needed)", () => {
    // local role always has local available (no key needed),
    // so this tests that local stays on local
    const result = selectModel({ isOffline: true });
    expect(result.provider).toBe("local");
  });
});

// ============================================
// SELECTION ALWAYS RETURNS VALID RESULT
// ============================================

describe("selectModel — always returns valid result", () => {
  it("returns a result even with no API keys", () => {
    registerApiKeys({
      deepseek: "",
      anthropic: "",
      gemini: "",
      openai: "",
    });
    // Should fall through to local (no key needed) or return with warning
    const result = selectModel({});
    expect(result).toBeDefined();
    expect(result.role).toBeDefined();
    expect(result.provider).toBeDefined();
    expect(result.model).toBeDefined();
  });

  it("reason is always a non-empty string", () => {
    const cases = [
      {},
      { hasLargeFiles: true },
      { isArchitectTask: true },
      { isOffline: true },
      { estimatedTokens: 100_000 },
      { explicitRole: "workhorse" as const },
    ];
    for (const criteria of cases) {
      const result = selectModel(criteria);
      expect(result.reason.length, `reason should be non-empty for ${JSON.stringify(criteria)}`).toBeGreaterThan(0);
    }
  });
});

// ============================================
// UTILITY FUNCTIONS
// ============================================

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 ≈ 3
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("detectLargeFileContext", () => {
  it("detects video file references", () => {
    expect(detectLargeFileContext("analyze the file demo.mp4")).toBe(true);
    expect(detectLargeFileContext("check recording.webm")).toBe(true);
  });

  it("detects PDF analysis requests", () => {
    expect(detectLargeFileContext("read and summarize report.pdf")).toBe(true);
    expect(detectLargeFileContext("extract data from invoice.pdf")).toBe(true);
  });

  it("detects whole codebase references", () => {
    expect(detectLargeFileContext("review the entire codebase")).toBe(true);
    expect(detectLargeFileContext("analyze the full repository")).toBe(true);
  });

  it("detects large page counts", () => {
    expect(detectLargeFileContext("summarize this 200 page document")).toBe(true);
  });

  it("does not trigger on normal requests", () => {
    expect(detectLargeFileContext("write a hello world function")).toBe(false);
    expect(detectLargeFileContext("fix the login page")).toBe(false);
  });

  it("does not trigger on incidental file mentions", () => {
    expect(detectLargeFileContext("save the output as report.pdf")).toBe(false);
    expect(detectLargeFileContext("export to .pdf format")).toBe(false);
    expect(detectLargeFileContext("create a video.mp4 file")).toBe(false);
  });
});

describe("detectArchitectTask", () => {
  it("detects architecture requests", () => {
    expect(detectArchitectTask("design the system architecture")).toBe(true);
    expect(detectArchitectTask("what design pattern should I use")).toBe(true);
  });

  it("detects second opinion requests", () => {
    expect(detectArchitectTask("take a second look at this design")).toBe(true);
    expect(detectArchitectTask("give me a second opinion on the approach")).toBe(true);
  });

  it("detects full-system refactoring", () => {
    expect(detectArchitectTask("refactor the entire codebase")).toBe(true);
    expect(detectArchitectTask("restructure the system")).toBe(true);
  });

  it("detects trade-off analysis", () => {
    expect(detectArchitectTask("evaluate the trade-offs between these approaches")).toBe(true);
    expect(detectArchitectTask("what are the pros and cons")).toBe(true);
  });

  it("does not trigger on normal requests", () => {
    expect(detectArchitectTask("write a function to sort an array")).toBe(false);
    expect(detectArchitectTask("fix the CSS on the login page")).toBe(false);
  });
});
