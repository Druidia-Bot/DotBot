/**
 * Sleep Cycle — Deduplication
 *
 * Generic dedup engine that works across all model field types:
 * - Open loops, beliefs, constraints, questions
 *
 * Uses scoreSemantic() from sleep-llm.ts:
 * word overlap >= 80% → auto-merge, < 80% → LLM scores it.
 *
 * Also contains Phase 2.5: whole-model duplicate detection.
 */

import * as store from "./store.js";
import { queryLLMForScore, scoreSemantic, isLocalLLMReady } from "./sleep-llm.js";
import type { ServerSender } from "./sleep-llm.js";
import type { SleepCycleState } from "./types.js";

// ============================================
// GENERIC DEDUP ENGINE
// ============================================

const SIMILARITY_THRESHOLD = 0.8;
const LOOP_SIMILARITY_THRESHOLD = 0.7;
const LLM_TIMEOUT_MS = 10_000;
const MAX_PAIRS_PER_MODEL = 15;

/**
 * Configuration for deduplicating a specific field type.
 */
export interface DedupItemConfig<T> {
  /** Extract the text to compare for similarity */
  getText: (item: T) => string;
  /** Get the unique ID */
  getId: (item: T) => string;
  /** Filter to only active/eligible items (skip resolved, inactive, etc.) */
  isEligible: (item: T) => boolean;
  /** Merge two duplicates — returns the merged item */
  merge: (a: T, b: T) => T;
  /** What kind of items (for LLM prompt, e.g., "open loop", "belief") */
  itemLabel: string;
  /** LLM question (e.g., "Are these about the SAME unresolved issue?") */
  similarityQuestion: string;
  /** Override the default similarity threshold (default: 0.8) */
  similarityThreshold?: number;
}

/**
 * Run dedup on an array of items using the given config.
 * Returns the deduped array and count of items removed.
 */
async function deduplicateItems<T>(
  items: T[],
  config: DedupItemConfig<T>,
  sendToServer: ServerSender | null,
  pairBudget: { remaining: number },
): Promise<{ result: T[]; removed: number }> {
  const eligible = items.filter(config.isEligible);
  const ineligible = items.filter(i => !config.isEligible(i));

  if (eligible.length < 2) return { result: items, removed: 0 };

  // Track by array index (not ID) — IDs may not be unique across items
  const toRemoveIndices = new Set<number>();
  const mergedAt = new Map<number, T>(); // index → merged version

  for (let i = 0; i < eligible.length && pairBudget.remaining > 0; i++) {
    if (toRemoveIndices.has(i)) continue;

    for (let j = i + 1; j < eligible.length && pairBudget.remaining > 0; j++) {
      if (toRemoveIndices.has(j)) continue;

      const textA = config.getText(mergedAt.get(i) || eligible[i]);
      const textB = config.getText(mergedAt.get(j) || eligible[j]);

      const similarity = await scoreSemantic(
        textA, textB,
        config.itemLabel, config.similarityQuestion,
        sendToServer, LLM_TIMEOUT_MS,
      );
      pairBudget.remaining--;

      const threshold = config.similarityThreshold ?? SIMILARITY_THRESHOLD;
      if (similarity >= threshold) {
        const itemA = mergedAt.get(i) || eligible[i];
        const itemB = mergedAt.get(j) || eligible[j];
        const mergedItem = config.merge(itemA, itemB);

        // Keep merged result at index i, mark j for removal
        mergedAt.set(i, mergedItem);
        toRemoveIndices.add(j);
      }
    }
  }

  if (toRemoveIndices.size === 0) return { result: items, removed: 0 };

  // Rebuild: ineligible items + kept eligible items (with merges applied, removals dropped)
  const kept: T[] = [];
  for (let i = 0; i < eligible.length; i++) {
    if (toRemoveIndices.has(i)) continue;
    kept.push(mergedAt.get(i) || eligible[i]);
  }

  return { result: [...ineligible, ...kept], removed: toRemoveIndices.size };
}

// ============================================
// FIELD-SPECIFIC CONFIGS
// ============================================

const LOOP_CONFIG: DedupItemConfig<any> = {
  getText: (l) => l.resolutionCriteria
    ? `${l.description} | ${l.resolutionCriteria}`
    : l.description,
  getId: (l) => l.id,
  isEligible: (l) => l.status !== "resolved",
  merge: (a, b) => {
    // Keep the loop with richer data
    let scoreA = 0, scoreB = 0;
    if (a.resolutionCriteria?.length > (b.resolutionCriteria?.length || 0)) scoreA++;
    else if (b.resolutionCriteria?.length > (a.resolutionCriteria?.length || 0)) scoreB++;
    if ((a.attemptCount || 0) > (b.attemptCount || 0)) scoreA++;
    else if ((b.attemptCount || 0) > (a.attemptCount || 0)) scoreB++;
    if (a.lastAttemptedAt && !b.lastAttemptedAt) scoreA++;
    else if (b.lastAttemptedAt && !a.lastAttemptedAt) scoreB++;
    if (scoreA === scoreB) {
      return (a.identifiedAt || "") <= (b.identifiedAt || "") ? a : b;
    }
    return scoreA >= scoreB ? a : b;
  },
  itemLabel: "open loop",
  similarityQuestion: "Are these two open loops about the SAME unresolved issue?",
  similarityThreshold: LOOP_SIMILARITY_THRESHOLD,
};

const BELIEF_CONFIG: DedupItemConfig<any> = {
  getText: (b) => `${b.attribute}: ${b.value}`,
  getId: (b) => b.id,
  isEligible: (b) => !b.contradicted,
  merge: (a, b) => {
    // Combine evidence, take higher confidence, keep older formedAt
    const evidenceSet = new Set<string>();
    const combinedEvidence: any[] = [];
    for (const e of [...(a.evidence || []), ...(b.evidence || [])]) {
      const key = `${e.type}:${e.content}`;
      if (!evidenceSet.has(key)) {
        evidenceSet.add(key);
        combinedEvidence.push(e);
      }
    }
    return {
      ...a,
      confidence: Math.max(a.confidence, b.confidence),
      evidence: combinedEvidence,
      formedAt: (a.formedAt || "") <= (b.formedAt || "") ? a.formedAt : b.formedAt,
      lastConfirmedAt: (a.lastConfirmedAt || "") >= (b.lastConfirmedAt || "") ? a.lastConfirmedAt : b.lastConfirmedAt,
    };
  },
  itemLabel: "belief",
  similarityQuestion: "Are these two beliefs about the SAME fact or attribute of the same entity?",
};

const CONSTRAINT_CONFIG: DedupItemConfig<any> = {
  getText: (c) => c.description,
  getId: (c) => c.id,
  isEligible: (c) => c.active !== false,
  merge: (a, b) => {
    // Keep the harder constraint, older identifiedAt
    const keep = a.type === "hard" ? a : b.type === "hard" ? b : a;
    const other = keep === a ? b : a;
    return {
      ...keep,
      identifiedAt: (a.identifiedAt || "") <= (b.identifiedAt || "") ? a.identifiedAt : b.identifiedAt,
      source: keep.source !== other.source ? `${keep.source}; ${other.source}` : keep.source,
    };
  },
  itemLabel: "constraint",
  similarityQuestion: "Are these two constraints about the SAME restriction or rule?",
};

const QUESTION_CONFIG: DedupItemConfig<any> = {
  getText: (q) => q.question,
  getId: (q) => q.id,
  isEligible: (q) => !q.asked,
  merge: (a, b) => {
    // Keep higher priority, combine informs arrays
    const priorityRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
    const keep = (priorityRank[a.priority] || 0) >= (priorityRank[b.priority] || 0) ? a : b;
    const other = keep === a ? b : a;
    const informsSet = new Set([...(keep.informs || []), ...(other.informs || [])]);
    return {
      ...keep,
      informs: [...informsSet],
      generatedAt: (a.generatedAt || "") <= (b.generatedAt || "") ? a.generatedAt : b.generatedAt,
    };
  },
  itemLabel: "question",
  similarityQuestion: "Are these two questions asking about the SAME thing?",
};

// ============================================
// PHASE 2.25: DEDUPLICATE MODEL FIELDS
// ============================================

interface FieldDedupResult {
  field: string;
  removed: number;
}

/**
 * Deduplicate all eligible fields across all models.
 * Runs the generic dedup engine on: openLoops, beliefs, constraints, questions.
 * Returns total items removed.
 */
export async function deduplicateModelFields(
  allModels: any[],
  sendToServer: ServerSender | null,
): Promise<number> {
  let totalRemoved = 0;

  for (const model of allModels) {
    const pairBudget = { remaining: MAX_PAIRS_PER_MODEL };
    const fieldResults: FieldDedupResult[] = [];

    // Open loops
    if ((model.openLoops || []).length >= 2) {
      const { result, removed } = await deduplicateItems(
        model.openLoops, LOOP_CONFIG, sendToServer, pairBudget,
      );
      if (removed > 0) {
        model.openLoops = result;
        fieldResults.push({ field: "openLoops", removed });
      }
    }

    // Beliefs
    if ((model.beliefs || []).length >= 2 && pairBudget.remaining > 0) {
      const { result, removed } = await deduplicateItems(
        model.beliefs, BELIEF_CONFIG, sendToServer, pairBudget,
      );
      if (removed > 0) {
        model.beliefs = result;
        fieldResults.push({ field: "beliefs", removed });
      }
    }

    // Constraints
    if ((model.constraints || []).length >= 2 && pairBudget.remaining > 0) {
      const { result, removed } = await deduplicateItems(
        model.constraints, CONSTRAINT_CONFIG, sendToServer, pairBudget,
      );
      if (removed > 0) {
        model.constraints = result;
        fieldResults.push({ field: "constraints", removed });
      }
    }

    // Questions
    if ((model.questions || []).length >= 2 && pairBudget.remaining > 0) {
      const { result, removed } = await deduplicateItems(
        model.questions, QUESTION_CONFIG, sendToServer, pairBudget,
      );
      if (removed > 0) {
        model.questions = result;
        fieldResults.push({ field: "questions", removed });
      }
    }

    // Persist if anything changed
    const modelRemoved = fieldResults.reduce((sum, r) => sum + r.removed, 0);
    if (modelRemoved > 0) {
      model.lastUpdatedAt = new Date().toISOString();
      await store.saveMentalModel(model);
      const details = fieldResults.map(r => `${r.field}: ${r.removed}`).join(", ");
      console.log(`[SleepCycle] Dedup on ${model.name}: ${details}`);
      totalRemoved += modelRemoved;
    }
  }

  return totalRemoved;
}

// ============================================
// PHASE 2.5: DUPLICATE MODEL DETECTION
// ============================================

const MAX_MERGE_CANDIDATES_PER_CYCLE = 5;
const AUTO_MERGE_THRESHOLD = 0.85;
const MAX_REVIEWED_PAIRS = 500;
const MODEL_LLM_TIMEOUT_MS = 15_000;

export interface DuplicateDetectionResult {
  merged: number;
  newReviewedPairs: string[];
}

/**
 * Detect and merge duplicate mental models using the local LLM.
 *
 * 1. Generate candidate pairs (same category, not already reviewed)
 * 2. Score each pair using the local LLM (cheap, runs on-device)
 * 3. Auto-merge if score >= 0.85
 * 4. Track reviewed pairs so we don't re-check every cycle
 */
export async function detectAndMergeDuplicates(
  allModels: any[],
  state: SleepCycleState,
): Promise<DuplicateDetectionResult> {
  const result: DuplicateDetectionResult = { merged: 0, newReviewedPairs: [] };

  if (allModels.length < 2) return result;

  // Requires local LLM — model dedup uses skeleton comparison
  if (!(await isLocalLLMReady())) {
    console.log("[SleepCycle] Local LLM not loaded into memory — skipping duplicate detection");
    return result;
  }

  const reviewedSet = new Set(state.reviewedPairs || []);

  // Generate candidate pairs: same category, not already reviewed
  const candidates: { a: any; b: any; pairKey: string }[] = [];
  for (let i = 0; i < allModels.length; i++) {
    for (let j = i + 1; j < allModels.length; j++) {
      const a = allModels[i];
      const b = allModels[j];
      if (a.category !== b.category) continue;
      const pairKey = [a.slug, b.slug].sort().join(":");
      if (reviewedSet.has(pairKey)) continue;
      candidates.push({ a, b, pairKey });
    }
  }

  if (candidates.length === 0) return result;

  // Pre-filter: quick name/keyword heuristics to rank candidates
  const scored = candidates.map(c => {
    let score = 0;
    const aLow = c.a.name.toLowerCase();
    const bLow = c.b.name.toLowerCase();
    if (aLow.includes(bLow) || bLow.includes(aLow)) score += 3;
    const aKw = new Set(extractModelKeywords(c.a));
    const bKw = extractModelKeywords(c.b);
    const overlap = bKw.filter(k => aKw.has(k)).length;
    if (overlap >= 2) score += 2;
    if (overlap >= 4) score += 1;
    const aAttrs = new Set((c.a.beliefs || []).map((b: any) => b.attribute));
    const sharedAttrs = (c.b.beliefs || []).filter((b: any) => aAttrs.has(b.attribute)).length;
    if (sharedAttrs >= 1) score += 2;
    if (sharedAttrs >= 3) score += 1;
    return { ...c, heuristicScore: score };
  });

  scored.sort((a, b) => b.heuristicScore - a.heuristicScore);
  const toEvaluate = scored
    .filter(s => s.heuristicScore >= 2)
    .slice(0, MAX_MERGE_CANDIDATES_PER_CYCLE);

  if (toEvaluate.length === 0) return result;

  console.log(`[SleepCycle] Evaluating ${toEvaluate.length} candidate pair(s) for duplicate models`);

  const mergedSlugs = new Set<string>();

  for (const candidate of toEvaluate) {
    if (mergedSlugs.has(candidate.a.slug) || mergedSlugs.has(candidate.b.slug)) continue;

    try {
      const similarity = await scoreModelPair(candidate.a, candidate.b);
      console.log(`[SleepCycle] Similarity: ${candidate.a.name} ↔ ${candidate.b.name} = ${similarity.toFixed(2)}`);

      if (similarity >= AUTO_MERGE_THRESHOLD) {
        const keepSlug = (candidate.a.beliefs?.length || 0) >= (candidate.b.beliefs?.length || 0)
          ? candidate.a.slug : candidate.b.slug;
        const absorbSlug = keepSlug === candidate.a.slug ? candidate.b.slug : candidate.a.slug;

        const mergeResult = await store.mergeMentalModels(keepSlug, absorbSlug);
        if (mergeResult) {
          result.merged++;
          mergedSlugs.add(absorbSlug);
          console.log(`[SleepCycle] Auto-merged "${absorbSlug}" into "${keepSlug}" (similarity: ${similarity.toFixed(2)}, repointed: ${mergeResult.repointed})`);
        }
      } else {
        result.newReviewedPairs.push(candidate.pairKey);
      }
    } catch (err) {
      console.error(`[SleepCycle] Failed to evaluate pair ${candidate.pairKey}:`, err);
    }
  }

  // Cap reviewed pairs to prevent unbounded growth
  if (result.newReviewedPairs.length > 0) {
    const allReviewed = [...(state.reviewedPairs || []), ...result.newReviewedPairs];
    if (allReviewed.length > MAX_REVIEWED_PAIRS) {
      state.reviewedPairs = allReviewed.slice(-MAX_REVIEWED_PAIRS);
      result.newReviewedPairs = [];
    }
  }

  return result;
}

/**
 * Score similarity between two mental models using the local LLM.
 * Uses model skeletons for a compact representation.
 */
async function scoreModelPair(modelA: any, modelB: any): Promise<number> {
  const { buildModelSkeleton } = await import("./store-models.js");

  const skelA = buildModelSkeleton(modelA);
  const skelB = buildModelSkeleton(modelB);

  const prompt = `Model A:\n${skelA}\n\nModel B:\n${skelB}\n\nAre these two models about the SAME entity (same person, place, thing, etc.)?\nReply with ONLY a number from 0.0 to 1.0:\n- 1.0 = definitely the same entity\n- 0.5 = possibly the same, not sure\n- 0.0 = definitely different entities`;
  const systemPrompt = "You compare two entity profiles and return a single similarity score. Reply with ONLY a decimal number between 0.0 and 1.0. No explanation.";

  // Model dedup uses local LLM only (no server fallback) — pass null
  return queryLLMForScore(prompt, systemPrompt, null, MODEL_LLM_TIMEOUT_MS);
}

/**
 * Extract keywords from a mental model for heuristic pre-filtering.
 */
function extractModelKeywords(model: any): string[] {
  const words: string[] = [];
  words.push(...model.name.toLowerCase().split(/\s+/));
  if (model.description) words.push(...model.description.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3));
  for (const b of model.beliefs || []) {
    words.push(b.attribute.toLowerCase());
  }
  return [...new Set(words)];
}
