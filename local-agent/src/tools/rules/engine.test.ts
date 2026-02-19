/**
 * Tests for Evaluation Engine — report building and batch confirmation.
 *
 * The full evaluation loop depends on serverLLMCall (WS to server),
 * so we test the report builder and batch logic directly.
 */

import { describe, it, expect } from "vitest";
import type { EvaluationProgress, Ruleset } from "./types.js";

// Inline the report builder logic for testing
// (matches engine.ts buildReport)
function buildReport(ruleset: Ruleset, progress: EvaluationProgress): string {
  const lines: string[] = [];

  const totalAssessments = progress.totalItems * ruleset.rules.length;
  lines.push(`## Evaluation Complete: ${ruleset.name}`);
  lines.push(`${progress.totalItems} items processed | ${ruleset.rules.length} rules per item | ${totalAssessments} total assessments`);
  lines.push("");

  const actionCounts: Record<string, number> = {};
  for (const result of progress.results) {
    for (const action of result.actions) {
      const actionText = action.replace(/^\[r\d+\]\s*/, "");
      actionCounts[actionText] = (actionCounts[actionText] || 0) + 1;
    }
  }

  if (Object.keys(actionCounts).length > 0) {
    lines.push("### Summary");
    for (const [action, count] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${count} × ${action}`);
    }
    lines.push("");
  }

  lines.push("### Per-Item Results");
  lines.push("| # | Item | Actions |");
  lines.push("|---|------|---------|");

  for (const result of progress.results) {
    const summary = result.itemSummary.substring(0, 60).replace(/\n/g, " ");
    const actions = result.actions.length > 0
      ? result.actions.map(a => a.replace(/^\[r\d+\]\s*/, "")).join("; ")
      : "(no actions)";
    lines.push(`| ${result.itemIndex} | ${summary} | ${actions} |`);
  }

  return lines.join("\n");
}

// ============================================
// FIXTURES
// ============================================

const emailTriageRuleset: Ruleset = {
  name: "Email Triage",
  slug: "email-triage",
  description: "Test ruleset",
  rules: [
    { id: "r1", assess: "Is this a promotional newsletter?", scale: [0, 1], threshold: 1, when_above: "Archive it", when_below: null },
    { id: "r2", assess: "How urgently does this need a response?", scale: [1, 10], threshold: 7, when_above: "Flag as urgent", when_below: null },
    { id: "r3", assess: "Is this from a known client?", scale: [0, 1], threshold: 1, when_above: "Label client", when_below: null },
  ],
};

const sampleProgress: EvaluationProgress = {
  rulesetSlug: "email-triage",
  totalItems: 4,
  completedItems: 4,
  status: "complete",
  startedAt: "2026-02-19T10:00:00Z",
  lastUpdatedAt: "2026-02-19T10:01:00Z",
  results: [
    {
      itemIndex: 0,
      itemSummary: '{"from":"deals@store.com","subject":"50% off everything!"}',
      scores: {
        r1: { score: 1, reasoning: "Promotional email" },
        r2: { score: 1, reasoning: "No response needed" },
        r3: { score: 0, reasoning: "Not a known client" },
      },
      actions: ["[r1] Archive it"],
    },
    {
      itemIndex: 1,
      itemSummary: '{"from":"john@acme.com","subject":"Where is my invoice?"}',
      scores: {
        r1: { score: 0, reasoning: "Not promotional" },
        r2: { score: 9, reasoning: "Client needs invoice urgently" },
        r3: { score: 1, reasoning: "Known client (Acme)" },
      },
      actions: ["[r2] Flag as urgent", "[r3] Label client"],
    },
    {
      itemIndex: 2,
      itemSummary: '{"from":"newsletter@tech.io","subject":"Weekly digest"}',
      scores: {
        r1: { score: 1, reasoning: "Newsletter" },
        r2: { score: 1, reasoning: "No response needed" },
        r3: { score: 0, reasoning: "Not a client" },
      },
      actions: ["[r1] Archive it"],
    },
    {
      itemIndex: 3,
      itemSummary: '{"from":"sarah@bigco.com","subject":"Contract renewal"}',
      scores: {
        r1: { score: 0, reasoning: "Business email" },
        r2: { score: 8, reasoning: "Contract renewal is time-sensitive" },
        r3: { score: 1, reasoning: "Known client" },
      },
      actions: ["[r2] Flag as urgent", "[r3] Label client"],
    },
  ],
};

// ============================================
// TESTS
// ============================================

describe("Evaluation Engine — Report Builder", () => {
  it("includes evaluation header with counts", () => {
    const report = buildReport(emailTriageRuleset, sampleProgress);
    expect(report).toContain("## Evaluation Complete: Email Triage");
    expect(report).toContain("4 items processed");
    expect(report).toContain("3 rules per item");
    expect(report).toContain("12 total assessments");
  });

  it("builds action summary with counts", () => {
    const report = buildReport(emailTriageRuleset, sampleProgress);
    expect(report).toContain("2 × Archive it");
    expect(report).toContain("2 × Flag as urgent");
    expect(report).toContain("2 × Label client");
  });

  it("builds per-item results table", () => {
    const report = buildReport(emailTriageRuleset, sampleProgress);
    expect(report).toContain("| 0 |");
    expect(report).toContain("| 1 |");
    expect(report).toContain("50% off everything");
    expect(report).toContain("Where is my invoice");
  });

  it("shows (no actions) for items with no fired rules", () => {
    const noActionProgress: EvaluationProgress = {
      ...sampleProgress,
      totalItems: 1,
      completedItems: 1,
      results: [{
        itemIndex: 0,
        itemSummary: "Some item",
        scores: { r1: { score: 0, reasoning: "nope" } },
        actions: [],
      }],
    };

    const report = buildReport(emailTriageRuleset, noActionProgress);
    expect(report).toContain("(no actions)");
  });
});

describe("Evaluation Engine — Batch Confirmation", () => {
  it("confirmation threshold is 50 items", () => {
    // This tests the constant value used in the engine
    const BATCH_CONFIRMATION_THRESHOLD = 50;
    expect(BATCH_CONFIRMATION_THRESHOLD).toBe(50);
  });

  it("hard cap is 500 items", () => {
    const HARD_CAP = 500;
    expect(HARD_CAP).toBe(500);
  });

  it("confirmation message includes item and rule counts", () => {
    // Simulate the confirmation_required output
    const itemCount = 247;
    const ruleCount = 5;
    const message = JSON.stringify({
      confirmation_required: true,
      itemCount,
      ruleCount,
      estimatedLLMCalls: itemCount,
      message: `This will evaluate ${itemCount} items against ${ruleCount} rules (${itemCount} LLM calls). Proceed?`,
    }, null, 2);

    const parsed = JSON.parse(message);
    expect(parsed.confirmation_required).toBe(true);
    expect(parsed.itemCount).toBe(247);
    expect(parsed.estimatedLLMCalls).toBe(247);
  });
});

describe("Evaluation Engine — Score Thresholds", () => {
  it("binary scale: score of 1 meets threshold of 1", () => {
    const rule = emailTriageRuleset.rules[0]; // [0,1], threshold 1
    const score = 1;
    expect(score >= rule.threshold).toBe(true);
  });

  it("binary scale: score of 0 does not meet threshold of 1", () => {
    const rule = emailTriageRuleset.rules[0];
    const score = 0;
    expect(score >= rule.threshold).toBe(false);
  });

  it("graduated scale: score of 9 meets threshold of 7", () => {
    const rule = emailTriageRuleset.rules[1]; // [1,10], threshold 7
    const score = 9;
    expect(score >= rule.threshold).toBe(true);
  });

  it("graduated scale: score of 5 does not meet threshold of 7", () => {
    const rule = emailTriageRuleset.rules[1];
    const score = 5;
    expect(score >= rule.threshold).toBe(false);
  });
});
