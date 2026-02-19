/**
 * Ruleset Types — Shared type definitions for the rules system.
 *
 * Used by: store, conflict, engine, handler, defs.
 */

/** A ruleset is a "processing manual" — rules applied to every item in a collection. */
export interface Ruleset {
  name: string;
  slug: string;
  description: string;
  rules: Rule[];
}

/** A single assessment rule. */
export interface Rule {
  /** Unique within ruleset (auto-generated: "r1", "r2"...) */
  id: string;
  /** The question the LLM answers about each item. Higher score = more of the thing. */
  assess: string;
  /** Score range: [0, 1] for binary, [1, 10] for graduated. */
  scale: [number, number];
  /** Score >= threshold triggers when_above. */
  threshold: number;
  /** Natural language action instruction when score >= threshold. */
  when_above: string | null;
  /** Optional action when score < threshold. */
  when_below: string | null;
}

/** Progress tracking for an evaluation run. */
export interface EvaluationProgress {
  rulesetSlug: string;
  collectionId?: string;
  totalItems: number;
  completedItems: number;
  status: "in_progress" | "complete" | "failed";
  startedAt: string;
  lastUpdatedAt: string;
  results: ItemResult[];
}

/** Evaluation result for a single item. */
export interface ItemResult {
  itemIndex: number;
  /** First ~200 chars for display. */
  itemSummary: string;
  /** Rule ID → score + reasoning. */
  scores: Record<string, { score: number; reasoning: string }>;
  /** Actions that fired (score >= threshold). */
  actions: string[];
}

/** Conflict detection result. */
export interface ConflictReport {
  conflict: boolean;
  conflicting_rule_ids: string[];
  new_rule_assess: string;
  description: string;
  suggested_resolutions: string[];
}
