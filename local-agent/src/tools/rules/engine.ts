/**
 * Evaluation Engine — Batch processing with progress tracking.
 *
 * Scores every item in a collection against every rule in a ruleset.
 * Uses serverLLMCall() with the workhorse model role.
 *
 * Features:
 *   - One LLM call per item (all rules scored together)
 *   - Progress tracking to ~/.bot/rulesets/.progress/{slug}-{timestamp}.json
 *   - Resumability: skip already-evaluated items on restart
 *   - Batch confirmation: >50 items requires explicit confirmation
 *   - Hard cap at 500 items
 */

import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";
import { serverLLMCall } from "../../server-llm.js";
import { readRuleset } from "./store.js";
import type { Ruleset, EvaluationProgress, ItemResult } from "./types.js";

const PROGRESS_DIR = join(homedir(), ".bot", "rulesets", ".progress");

const BATCH_CONFIRMATION_THRESHOLD = 50;
const HARD_CAP = 500;

// ============================================
// PUBLIC API
// ============================================

export async function evaluateRuleset(opts: {
  slug: string;
  collectionId?: string;
  items?: unknown[];
  confirmed?: boolean;
}): Promise<string> {
  const { slug, collectionId, items: inlineItems, confirmed } = opts;

  // Load ruleset
  const ruleset = await readRuleset(slug);
  if (!ruleset) throw new Error(`Ruleset "${slug}" not found`);
  if (ruleset.rules.length === 0) throw new Error(`Ruleset "${slug}" has no rules`);

  // Resolve items
  let items: unknown[];
  if (inlineItems && inlineItems.length > 0) {
    items = inlineItems;
  } else if (collectionId) {
    // Read from collection — items must be fetched by the server and passed to us.
    // For now, the handler should have resolved the collection before calling evaluate.
    // If collectionId is provided but no items, we ask the user to use result.get.
    throw new Error(
      `Collection-based evaluation requires the server to resolve the collection first. ` +
      `Use result.filter or result.overview to narrow items, then pass them inline via the 'items' parameter.`,
    );
  } else {
    throw new Error("Either collectionId or items is required");
  }

  // Hard cap
  if (items.length > HARD_CAP) {
    throw new Error(
      `Collection has ${items.length} items, which exceeds the hard cap of ${HARD_CAP}. ` +
      `Use result.filter to narrow the collection first.`,
    );
  }

  // Batch confirmation
  if (items.length > BATCH_CONFIRMATION_THRESHOLD && !confirmed) {
    return JSON.stringify({
      confirmation_required: true,
      itemCount: items.length,
      ruleCount: ruleset.rules.length,
      estimatedLLMCalls: items.length,
      message: `This will evaluate ${items.length} items against ${ruleset.rules.length} rules (${items.length} LLM calls). Proceed?`,
    }, null, 2);
  }

  // Initialize progress
  const progress: EvaluationProgress = {
    rulesetSlug: slug,
    collectionId,
    totalItems: items.length,
    completedItems: 0,
    status: "in_progress",
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    results: [],
  };

  // Check for existing progress (resumability — only resume in_progress runs)
  const existingProgress = await loadLatestProgress(slug);
  let startIndex = 0;

  if (existingProgress && existingProgress.status === "in_progress") {
    startIndex = existingProgress.completedItems;
    progress.results = existingProgress.results;
    progress.completedItems = existingProgress.completedItems;
    progress.startedAt = existingProgress.startedAt;
  }

  // Evaluate each item
  try {
    for (let i = startIndex; i < items.length; i++) {
      const item = items[i];
      const itemResult = await evaluateItem(item, i, ruleset);
      progress.results.push(itemResult);
      progress.completedItems = i + 1;
      progress.lastUpdatedAt = new Date().toISOString();

      // Save progress after each item
      await saveProgress(slug, progress);
    }

    progress.status = "complete";
    await saveProgress(slug, progress);
  } catch (err) {
    progress.status = "failed";
    progress.lastUpdatedAt = new Date().toISOString();
    await saveProgress(slug, progress);
    throw err;
  }

  // Build output report
  return buildReport(ruleset, progress);
}

// ============================================
// ITEM EVALUATION
// ============================================

async function evaluateItem(
  item: unknown,
  index: number,
  ruleset: Ruleset,
): Promise<ItemResult> {
  // Build item summary for display
  const itemStr = typeof item === "string" ? item : JSON.stringify(item, null, 2);
  const itemSummary = itemStr.substring(0, 200);

  // Truncate item context for the prompt (keep it under ~4K chars)
  const itemContext = itemStr.length > 4000
    ? itemStr.substring(0, 4000) + "\n...[truncated]"
    : itemStr;

  // Build rules text
  const rulesText = ruleset.rules.map(r =>
    `[${r.id}] "${r.assess}" — Scale: ${r.scale[0]}-${r.scale[1]}`,
  ).join("\n");

  const prompt = `You are evaluating a single item against a set of rules.
Score each rule independently. Do not skip any rule.

## Item
${itemContext}

## Rules
${rulesText}

## Response Format (JSON only, no markdown)
{
  "scores": {
${ruleset.rules.map(r => `    "${r.id}": { "score": <number>, "reasoning": "<brief explanation>" }`).join(",\n")}
  }
}`;

  try {
    const result = await serverLLMCall({
      role: "workhorse",
      messages: [
        { role: "user", content: prompt },
      ],
      maxTokens: 1024,
      temperature: 0.1,
    });

    if (!result.success || !result.content) {
      // Return a failed evaluation for this item
      return {
        itemIndex: index,
        itemSummary,
        scores: Object.fromEntries(
          ruleset.rules.map(r => [r.id, { score: 0, reasoning: "LLM evaluation failed" }]),
        ),
        actions: [],
      };
    }

    // Parse scores
    const cleaned = result.content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const scores: Record<string, { score: number; reasoning: string }> = parsed.scores || {};

    // Determine which actions fire
    const actions: string[] = [];
    for (const rule of ruleset.rules) {
      const scoreEntry = scores[rule.id];
      if (!scoreEntry) continue;

      if (scoreEntry.score >= rule.threshold) {
        if (rule.when_above) actions.push(`[${rule.id}] ${rule.when_above}`);
      } else {
        if (rule.when_below) actions.push(`[${rule.id}] ${rule.when_below}`);
      }
    }

    return { itemIndex: index, itemSummary, scores, actions };
  } catch (err) {
    return {
      itemIndex: index,
      itemSummary,
      scores: Object.fromEntries(
        ruleset.rules.map(r => [r.id, { score: 0, reasoning: `Error: ${err instanceof Error ? err.message : "unknown"}` }]),
      ),
      actions: [],
    };
  }
}

// ============================================
// PROGRESS PERSISTENCE
// ============================================

async function saveProgress(slug: string, progress: EvaluationProgress): Promise<void> {
  await fs.mkdir(PROGRESS_DIR, { recursive: true });
  const filename = `${slug}-latest.json`;
  await fs.writeFile(join(PROGRESS_DIR, filename), JSON.stringify(progress, null, 2), "utf-8");
}

async function loadLatestProgress(slug: string): Promise<EvaluationProgress | null> {
  try {
    const filename = `${slug}-latest.json`;
    const raw = await fs.readFile(join(PROGRESS_DIR, filename), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ============================================
// REPORT BUILDER
// ============================================

function buildReport(ruleset: Ruleset, progress: EvaluationProgress): string {
  const lines: string[] = [];

  // Summary stats
  const totalAssessments = progress.totalItems * ruleset.rules.length;
  lines.push(`## Evaluation Complete: ${ruleset.name}`);
  lines.push(`${progress.totalItems} items processed | ${ruleset.rules.length} rules per item | ${totalAssessments} total assessments`);
  lines.push("");

  // Action summary
  const actionCounts: Record<string, number> = {};
  for (const result of progress.results) {
    for (const action of result.actions) {
      // Extract the rule action text (strip [rN] prefix)
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

  // Per-item results table
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

  lines.push("");
  lines.push("Action execution is ready. Review the plan above and confirm to proceed.");

  return lines.join("\n");
}
