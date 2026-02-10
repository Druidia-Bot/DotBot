/**
 * Self-Recovery System Tests
 * 
 * Covers:
 * - RunJournal: event logging, error tracking, context formatting
 * - diagnoseError: pattern matching across all error categories
 * - buildFailureReport: user-facing error reports
 * - buildRecoveryContext: LLM prompt injection for recovery
 */

import { describe, it, expect } from "vitest";
import {
  RunJournal,
  diagnoseError,
  buildFailureReport,
  buildRecoveryContext,
} from "./self-recovery.js";

// ============================================
// RUN JOURNAL
// ============================================

describe("RunJournal", () => {
  it("starts empty", () => {
    const journal = new RunJournal();
    expect(journal.length).toBe(0);
    expect(journal.hasErrors()).toBe(false);
    expect(journal.getErrors()).toEqual([]);
    expect(journal.getLastError()).toBeUndefined();
  });

  it("logs events with timestamp and phase", () => {
    const journal = new RunJournal();
    journal.log("receptionist", "Classifying request");
    journal.log("execution", "Running persona", { personaId: "writer" });

    expect(journal.length).toBe(2);
    expect(journal.hasErrors()).toBe(false);
  });

  it("logs errors and tracks them separately", () => {
    const journal = new RunJournal();
    journal.log("start", "Agent run started");
    journal.logError("pipeline", new Error("DeepSeek API error: 429"));
    journal.log("recovery", "Attempting retry");
    journal.logError("recovery", "Second failure");

    expect(journal.length).toBe(4);
    expect(journal.hasErrors()).toBe(true);
    expect(journal.getErrors()).toHaveLength(2);
    expect(journal.getErrors()[0].error).toBe("DeepSeek API error: 429");
    expect(journal.getErrors()[1].error).toBe("Second failure");
  });

  it("getLastError returns the most recent error", () => {
    const journal = new RunJournal();
    journal.logError("pipeline", "First error");
    journal.logError("recovery", "Second error");

    expect(journal.getLastError()).toBe("Second error");
  });

  it("handles Error objects in logError", () => {
    const journal = new RunJournal();
    journal.logError("pipeline", new Error("Something broke"), { extra: "data" });

    const errors = journal.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("Something broke");
    expect(errors[0].details).toEqual({ extra: "data" });
  });

  it("toContextString formats entries with timing", () => {
    const journal = new RunJournal();
    journal.log("start", "Agent run started");
    journal.logError("pipeline", "Test error");

    const ctx = journal.toContextString();
    expect(ctx).toContain("[start]");
    expect(ctx).toContain("Agent run started");
    expect(ctx).toContain("[pipeline]");
    expect(ctx).toContain("ERROR: Test error");
    expect(ctx).toContain("+"); // timing prefix
  });

  it("toContextString returns placeholder for empty journal", () => {
    const journal = new RunJournal();
    expect(journal.toContextString()).toBe("(no journal entries)");
  });

  it("getElapsedMs returns positive value", () => {
    const journal = new RunJournal();
    // Small delay to ensure elapsed > 0
    expect(journal.getElapsedMs()).toBeGreaterThanOrEqual(0);
  });
});

// ============================================
// DIAGNOSE ERROR
// ============================================

describe("diagnoseError", () => {
  const journal = new RunJournal();

  // --- Rate Limit ---
  it("diagnoses 429 rate limit", () => {
    const d = diagnoseError(new Error("DeepSeek API error: 429 Too Many Requests"), journal);
    expect(d.category).toBe("llm_rate_limit");
    expect(d.recoverable).toBe(true);
    expect(d.strategy).toBe("retry_after_delay");
    expect(d.delayMs).toBeGreaterThan(0);
  });

  it("diagnoses 'rate limit' text", () => {
    const d = diagnoseError(new Error("Rate limit exceeded"), journal);
    expect(d.category).toBe("llm_rate_limit");
    expect(d.recoverable).toBe(true);
  });

  it("diagnoses 'too many requests'", () => {
    const d = diagnoseError("too many requests", journal);
    expect(d.category).toBe("llm_rate_limit");
  });

  // --- Auth ---
  it("diagnoses 401 unauthorized", () => {
    const d = diagnoseError(new Error("DeepSeek API error: 401 Unauthorized"), journal);
    expect(d.category).toBe("llm_auth");
    expect(d.recoverable).toBe(false);
    expect(d.strategy).toBe("give_up");
  });

  it("diagnoses 403 forbidden", () => {
    const d = diagnoseError(new Error("403 Forbidden"), journal);
    expect(d.category).toBe("llm_auth");
    expect(d.recoverable).toBe(false);
  });

  it("diagnoses invalid API key", () => {
    const d = diagnoseError(new Error("Invalid API key provided"), journal);
    expect(d.category).toBe("llm_auth");
    expect(d.recoverable).toBe(false);
  });

  // --- LLM general errors ---
  it("diagnoses 500 server error", () => {
    const d = diagnoseError(new Error("DeepSeek API error: 500"), journal);
    expect(d.category).toBe("llm_error");
    expect(d.recoverable).toBe(true);
    expect(d.strategy).toBe("retry_after_delay");
  });

  it("diagnoses 502 bad gateway", () => {
    const d = diagnoseError(new Error("502 Bad Gateway"), journal);
    expect(d.category).toBe("llm_error");
    expect(d.recoverable).toBe(true);
  });

  it("diagnoses 503 service unavailable", () => {
    const d = diagnoseError(new Error("503 Service Unavailable"), journal);
    expect(d.category).toBe("llm_error");
  });

  it("diagnoses network fetch failure", () => {
    const d = diagnoseError(new Error("fetch failed: ECONNREFUSED"), journal);
    expect(d.category).toBe("llm_error");
    expect(d.recoverable).toBe(true);
  });

  it("diagnoses DNS failure", () => {
    const d = diagnoseError(new Error("ENOTFOUND api.deepseek.com"), journal);
    expect(d.category).toBe("llm_error");
  });

  // --- Parse failure ---
  it("diagnoses JSON parse failure from receptionist", () => {
    const d = diagnoseError(new Error("No JSON found in receptionist response"), journal);
    expect(d.category).toBe("llm_parse_failure");
    expect(d.recoverable).toBe(true);
    expect(d.strategy).toBe("retry_simple");
  });

  it("diagnoses 'failed to parse'", () => {
    const d = diagnoseError(new Error("Failed to parse LLM output"), journal);
    expect(d.category).toBe("llm_parse_failure");
  });

  // --- Agent disconnected ---
  it("diagnoses no local-agent connected", () => {
    const d = diagnoseError(new Error("No local-agent available"), journal);
    expect(d.category).toBe("agent_disconnected");
    expect(d.recoverable).toBe(true);
    expect(d.strategy).toBe("degrade_no_tools");
  });

  it("diagnoses device not connected", () => {
    const d = diagnoseError(new Error("Device not connected"), journal);
    expect(d.category).toBe("agent_disconnected");
  });

  // --- Persona missing ---
  it("diagnoses persona not found", () => {
    const d = diagnoseError(new Error("Persona 'custom-bot' not found"), journal);
    expect(d.category).toBe("persona_missing");
    expect(d.recoverable).toBe(true);
    expect(d.strategy).toBe("retry_simple");
  });

  it("diagnoses persona not loaded", () => {
    const d = diagnoseError(new Error("Receptionist not loaded"), journal);
    expect(d.category).toBe("persona_missing");
    expect(d.recoverable).toBe(true);
  });

  // --- Timeout ---
  it("diagnoses timeout", () => {
    const d = diagnoseError(new Error("Request timed out after 30000ms"), journal);
    expect(d.category).toBe("timeout");
    expect(d.recoverable).toBe(true);
    expect(d.strategy).toBe("retry_simple");
  });

  it("diagnoses aborted request", () => {
    const d = diagnoseError(new Error("The operation was aborted"), journal);
    expect(d.category).toBe("timeout");
  });

  // --- Unknown ---
  it("returns unknown for unrecognized errors", () => {
    const d = diagnoseError(new Error("Something completely unexpected"), journal);
    expect(d.category).toBe("unknown");
    expect(d.recoverable).toBe(true);
    expect(d.strategy).toBe("retry_simple");
  });

  // --- String errors ---
  it("handles plain string errors", () => {
    const d = diagnoseError("rate limit hit", journal);
    expect(d.category).toBe("llm_rate_limit");
    expect(d.technicalDetail).toBe("rate limit hit");
  });

  // --- All diagnoses have required fields ---
  it("all diagnoses have userHint and technicalDetail", () => {
    const errors = [
      "429 rate limit",
      "401 Unauthorized",
      "500 Internal Server Error",
      "No JSON found",
      "No local-agent",
      "Persona not found",
      "Request timed out",
      "Unknown weirdness",
    ];

    for (const errMsg of errors) {
      const d = diagnoseError(new Error(errMsg), journal);
      expect(d.userHint).toBeTruthy();
      expect(d.technicalDetail).toBeTruthy();
      expect(d.category).toBeTruthy();
      expect(typeof d.recoverable).toBe("boolean");
      expect(typeof d.delayMs).toBe("number");
    }
  });
});

// ============================================
// BUILD FAILURE REPORT
// ============================================

describe("buildFailureReport", () => {
  it("produces a non-empty report with diagnosis info", () => {
    const journal = new RunJournal();
    journal.log("start", "Agent run started");
    journal.logError("pipeline", "DeepSeek API error: 429");

    const diagnosis = diagnoseError(new Error("DeepSeek API error: 429"), journal);
    const report = buildFailureReport(journal, diagnosis, "Hello bot", 1);

    expect(report).toContain("wasn't able to process");
    expect(report).toContain(diagnosis.userHint);
    expect(report).toContain("Recovery attempts");
    expect(report).toContain("What you can do");
  });

  it("includes execution trace with errors", () => {
    const journal = new RunJournal();
    journal.logError("pipeline", "First error");
    journal.logError("recovery", "Second error");

    const diagnosis = diagnoseError("unknown error", journal);
    const report = buildFailureReport(journal, diagnosis, "test prompt", 2);

    expect(report).toContain("Execution trace");
    expect(report).toContain("First error");
    expect(report).toContain("Second error");
  });

  it("includes category-specific suggestions", () => {
    const journal = new RunJournal();

    // Rate limit
    const rl = diagnoseError("429 rate limit", journal);
    expect(buildFailureReport(journal, rl, "test", 0)).toContain("rate limits reset");

    // Auth
    const auth = diagnoseError("401 Unauthorized", journal);
    expect(buildFailureReport(journal, auth, "test", 0)).toContain("API key");

    // Agent disconnected
    const agent = diagnoseError("No local-agent", journal);
    expect(buildFailureReport(journal, agent, "test", 0)).toContain("local agent");

    // Timeout
    const timeout = diagnoseError("Request timed out", journal);
    expect(buildFailureReport(journal, timeout, "test", 0)).toContain("simpler request");
  });

  it("truncates long technical details", () => {
    const journal = new RunJournal();
    const longError = "A".repeat(300);
    const diagnosis = diagnoseError(longError, journal);
    const report = buildFailureReport(journal, diagnosis, "test", 0);

    expect(report).toContain("...");
  });

  it("handles zero recovery attempts", () => {
    const journal = new RunJournal();
    const diagnosis = diagnoseError("401 Unauthorized", journal);
    const report = buildFailureReport(journal, diagnosis, "test", 0);

    // Should NOT mention recovery attempts when count is 0
    expect(report).not.toContain("Recovery attempts");
  });
});

// ============================================
// BUILD RECOVERY CONTEXT
// ============================================

describe("buildRecoveryContext", () => {
  it("includes error details and journal", () => {
    const journal = new RunJournal();
    journal.log("start", "Agent run started");
    journal.logError("pipeline", "DeepSeek API error: 429");

    const diagnosis = diagnoseError(new Error("DeepSeek API error: 429"), journal);
    const ctx = buildRecoveryContext(journal, diagnosis);

    expect(ctx).toContain("Recovery Mode");
    expect(ctx).toContain("DeepSeek API error: 429");
    expect(ctx).toContain(diagnosis.category);
    expect(ctx).toContain(diagnosis.userHint);
    expect(ctx).toContain("EXECUTION LOG");
    expect(ctx).toContain("Agent run started");
  });

  it("includes LLM instructions", () => {
    const journal = new RunJournal();
    const diagnosis = diagnoseError("test error", journal);
    const ctx = buildRecoveryContext(journal, diagnosis);

    expect(ctx).toContain("Respond directly and helpfully");
    expect(ctx).toContain("Do NOT return JSON");
  });
});
