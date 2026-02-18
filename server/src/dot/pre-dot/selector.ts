/**
 * Principle Selector — Rule-Based
 *
 * Selects which principles apply to the current request based on:
 *   - Complexity score (from tailor)
 *   - Keyword matching against the user's prompt
 *   - Contextual conditions (cache exists, history length, etc.)
 *
 * Rules (type: "rule") are always included — they're not evaluated here.
 * Only principles (type: "principle") go through selection.
 */

import { createComponentLogger } from "#logging.js";
import type { PrincipleFile, TailorResult } from "./types.js";

const log = createComponentLogger("dot.selector");

export interface SelectionContext {
  /** The user's raw or restated prompt */
  prompt: string;
  /** Tailor result with complexity, relevantCache, etc. */
  tailorResult: TailorResult;
  /** Number of conversation history turns */
  historyLength: number;
  /** Whether research cache entries exist */
  hasCacheEntries: boolean;
}

export interface SelectionResult {
  /** Always-on rules (type: "rule") */
  rules: PrincipleFile[];
  /** Task-selected principles (type: "principle") that matched */
  selectedPrinciples: PrincipleFile[];
  /** IDs of principles that were evaluated but not selected */
  skippedIds: string[];
}

/**
 * Select which principles apply to this request.
 * Rules are always included. Principles are matched by triggers.
 */
export function selectPrinciples(
  allPrinciples: PrincipleFile[],
  ctx: SelectionContext,
): SelectionResult {
  const rules: PrincipleFile[] = [];
  const candidates: PrincipleFile[] = [];

  for (const p of allPrinciples) {
    if (p.type === "rule") {
      rules.push(p);
    } else {
      candidates.push(p);
    }
  }

  const selected: PrincipleFile[] = [];
  const skippedIds: string[] = [];
  const promptLower = ctx.prompt.toLowerCase();
  const complexity = ctx.tailorResult.complexity ?? 0;

  for (const p of candidates) {
    if (matchesTriggers(p.triggers, promptLower, complexity, ctx)) {
      selected.push(p);
    } else {
      skippedIds.push(p.id);
    }
  }

  log.info("Principle selection complete", {
    ruleCount: rules.length,
    selectedCount: selected.length,
    skippedCount: skippedIds.length,
    selectedIds: selected.map(p => p.id),
    skippedIds,
  });

  return { rules, selectedPrinciples: selected, skippedIds };
}

/**
 * Check if any of a principle's triggers match the current context.
 * A single matching trigger is enough to include the principle.
 *
 * Trigger formats:
 *   - "complexity>=N" — matches if complexity score >= N
 *   - "historyLength>=N" — matches if conversation history length >= N
 *   - "hasCache" — matches if research cache entries exist
 *   - anything else — case-insensitive substring match against the prompt
 */
function matchesTriggers(
  triggers: string[],
  promptLower: string,
  complexity: number,
  ctx: SelectionContext,
): boolean {
  for (const trigger of triggers) {
    // Complexity threshold: "complexity>=5"
    const complexityMatch = trigger.match(/^complexity>=(\d+)$/);
    if (complexityMatch) {
      if (complexity >= parseInt(complexityMatch[1], 10)) return true;
      continue;
    }

    // History length threshold: "historyLength>=10"
    const historyMatch = trigger.match(/^historyLength>=(\d+)$/);
    if (historyMatch) {
      if (ctx.historyLength >= parseInt(historyMatch[1], 10)) return true;
      continue;
    }

    // Cache existence: "hasCache"
    if (trigger === "hasCache") {
      if (ctx.hasCacheEntries) return true;
      continue;
    }

    // Default: case-insensitive substring match against prompt
    if (promptLower.includes(trigger.toLowerCase())) return true;
  }

  return false;
}
