/**
 * Browser Utils Tests — Production Grade
 * 
 * Tests for pure utility functions extracted from headless-bridge.ts:
 * - sanitizeUrl: URL validation, scheme blocking, auto-prepend https
 * - clampTimeout: range clamping with default fallback
 * - buildBotChallengeResult: structured challenge result construction
 * 
 * These are synchronous/pure functions — no Playwright or browser needed.
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeUrl,
  clampTimeout,
  buildBotChallengeResult,
  MAX_WAIT_TIMEOUT_MS,
} from "./browser-utils.js";

// ============================================
// sanitizeUrl
// ============================================

describe("sanitizeUrl", () => {
  it("passes through valid https URL unchanged", () => {
    const { url, error } = sanitizeUrl("https://example.com/path?q=1");
    expect(error).toBeUndefined();
    expect(url).toBe("https://example.com/path?q=1");
  });

  it("passes through valid http URL", () => {
    const { url, error } = sanitizeUrl("http://localhost:3000");
    expect(error).toBeUndefined();
    expect(url).toBe("http://localhost:3000/");
  });

  it("auto-prepends https:// when no scheme", () => {
    const { url, error } = sanitizeUrl("example.com");
    expect(error).toBeUndefined();
    expect(url).toBe("https://example.com/");
  });

  it("auto-prepends https:// for domain with path", () => {
    const { url, error } = sanitizeUrl("example.com/search?q=test");
    expect(error).toBeUndefined();
    expect(url).toBe("https://example.com/search?q=test");
  });

  it("blocks javascript: scheme", () => {
    const { url, error } = sanitizeUrl("javascript:alert(1)");
    expect(url).toBe("");
    expect(error).toContain("Blocked URL scheme");
    expect(error).toContain("javascript:");
  });

  it("blocks file: scheme", () => {
    const { url, error } = sanitizeUrl("file:///etc/passwd");
    expect(url).toBe("");
    expect(error).toContain("Blocked URL scheme");
  });

  it("blocks data: scheme", () => {
    const { url, error } = sanitizeUrl("data:text/html,<h1>hi</h1>");
    expect(url).toBe("");
    expect(error).toContain("Blocked URL scheme");
  });

  it("blocks ftp: scheme", () => {
    const { url, error } = sanitizeUrl("ftp://files.example.com");
    expect(url).toBe("");
    expect(error).toContain("Blocked URL scheme");
  });

  it("returns error for completely invalid URL", () => {
    const { url, error } = sanitizeUrl("://broken");
    expect(url).toBe("");
    expect(error).toContain("Invalid URL");
  });

  it("handles URL with port", () => {
    const { url, error } = sanitizeUrl("https://localhost:8080/api");
    expect(error).toBeUndefined();
    expect(url).toBe("https://localhost:8080/api");
  });

  it("handles URL with authentication (no injection)", () => {
    const { url, error } = sanitizeUrl("https://user:pass@example.com");
    expect(error).toBeUndefined();
    expect(url).toContain("example.com");
  });

  it("normalizes URL encoding", () => {
    const { url, error } = sanitizeUrl("https://example.com/path with spaces");
    expect(error).toBeUndefined();
    expect(url).toContain("example.com");
  });
});

// ============================================
// clampTimeout
// ============================================

describe("clampTimeout", () => {
  it("returns value when within range", () => {
    expect(clampTimeout(5000, 10000)).toBe(5000);
  });

  it("returns default for NaN input", () => {
    expect(clampTimeout(NaN, 10000)).toBe(10000);
  });

  it("returns default for undefined input", () => {
    expect(clampTimeout(undefined, 10000)).toBe(10000);
  });

  it("returns default for string input", () => {
    expect(clampTimeout("fast", 10000)).toBe(10000);
  });

  it("returns default for null input", () => {
    expect(clampTimeout(null, 10000)).toBe(10000);
  });

  it("clamps to minimum 100ms", () => {
    expect(clampTimeout(10, 10000)).toBe(100);
    expect(clampTimeout(0, 10000)).toBe(100);
    expect(clampTimeout(-500, 10000)).toBe(100);
  });

  it("clamps to MAX_WAIT_TIMEOUT_MS ceiling", () => {
    expect(clampTimeout(999_999_999, 10000)).toBe(MAX_WAIT_TIMEOUT_MS);
  });

  it("allows exact boundary values", () => {
    expect(clampTimeout(100, 10000)).toBe(100);
    expect(clampTimeout(MAX_WAIT_TIMEOUT_MS, 10000)).toBe(MAX_WAIT_TIMEOUT_MS);
  });
});

// ============================================
// buildBotChallengeResult
// ============================================

describe("buildBotChallengeResult", () => {
  it("returns structured result for opened system browser", () => {
    const result = buildBotChallengeResult(
      "https://example.com",
      "title_match:just a moment",
      true,
      "Google Chrome"
    );

    expect(result.navigated).toBe(false);
    expect(result.url).toBe("https://example.com");
    expect(result.bot_challenge).toBe(true);
    expect(result.challenge_type).toBe("title_match:just a moment");
    expect(result.fallback).toBe("system_browser");
    expect(result.browser_app_name).toBe("Google Chrome");
    expect(result.hint).toContain("Bot challenge detected");
    expect(result.hint).toContain("Google Chrome");
    expect(result.hint).toContain("DO NOT call gui.navigate again");
  });

  it("returns fallback=none when system browser failed to open", () => {
    const result = buildBotChallengeResult(
      "https://example.com",
      "body_match:cf-browser-verification",
      false,
      null
    );

    expect(result.fallback).toBe("none");
    expect(result.browser_app_name).toBe("Google Chrome"); // default
    expect(result.hint).toContain("Could not open system browser");
  });

  it("includes pending action in hint when provided", () => {
    const result = buildBotChallengeResult(
      "https://example.com",
      "title_match:checking your browser",
      true,
      "Microsoft Edge",
      "Search for 'test query'"
    );

    expect(result.pending_action).toBe("Search for 'test query'");
    expect(result.hint).toContain("Search for 'test query'");
    expect(result.browser_app_name).toBe("Microsoft Edge");
  });

  it("includes step-by-step instructions with correct app_name", () => {
    const result = buildBotChallengeResult(
      "https://protected.site/page",
      "body_match:hcaptcha",
      true,
      "Firefox"
    );

    expect(result.hint).toContain("app_name='Firefox'");
    expect(result.hint).toContain("gui.read_state");
    expect(result.hint).toContain("gui.click");
    expect(result.hint).toContain("gui.wait_for");
    expect(result.hint).toContain("protected.site");
  });

  it("pending_action is null when not provided", () => {
    const result = buildBotChallengeResult(
      "https://example.com",
      "title_match:access denied",
      true,
      null
    );

    expect(result.pending_action).toBeNull();
  });
});
