/**
 * Sleep Cycle
 * 
 * Runs every 30 minutes on the local agent. Consolidates raw conversations
 * into structured, permanent knowledge — like how the brain processes
 * memories during sleep.
 * 
 * Flow:
 * 1. Scan threads for new activity since last cycle
 * 2. For each active thread:
 *    a. Pre-fetch relevant models based on thread entities
 *    b. Send thread + models to server as "condense_request"
 *    c. Server LLM returns structured instructions (NOT rewritten models)
 *    d. Apply instructions programmatically via instruction-applier
 * 3. Scan all models for open loops with tool hints
 *    a. Send each loop to server as "resolve_loop_request"
 *    b. Server attempts resolution (web search, email, etc.)
 *    c. Apply results — close loops, notify user, or mark blocked
 * 4. Prune index — keep 25-50 hot models, demote inactive ones
 * 5. Persist sleep cycle state
 */

import { nanoid } from "nanoid";
import * as store from "./store.js";
import { MODELS_DIR, DEEP_MEMORY_DIR } from "./store-core.js";
import { applyInstructions } from "./instruction-applier.js";
import { cleanupExpiredAgentWork } from "./store-agent-work.js";
import type { SleepCycleState } from "./types.js";
import path from "path";
import { homedir } from "os";
import { promises as fs } from "fs";

export const CYCLE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_THREADS_PER_CYCLE = 10;
const MAX_LOOPS_PER_CYCLE = 5;
const HOT_MODEL_LIMIT = 50;
const SLEEP_STATE_PATH = path.join(homedir(), ".bot", "memory", "sleep-state.json");

let sendToServer: ((message: any) => Promise<any>) | null = null;
let running = false;
let onLoopNotification: ((modelName: string, loopDescription: string, notification: string, newStatus: string) => void) | null = null;

// ============================================
// LIFECYCLE
// ============================================

/**
 * Initialize sleep cycle with a server sender.
 * Does NOT start a timer — the periodic manager handles scheduling.
 */
export function initSleepCycle(sender: (message: any) => Promise<any>): void {
  sendToServer = sender;
}

/**
 * Backward-compatible wrapper — calls initSleepCycle.
 * @deprecated Use initSleepCycle() + periodic manager instead.
 */
export function startSleepCycle(sender: (message: any) => Promise<any>): void {
  initSleepCycle(sender);
}

/**
 * Set callback for loop resolution notifications → #conversation.
 * Fired when the sleep cycle resolves a loop or finds actionable new information.
 */
export function setSleepCycleLoopCallback(cb: (modelName: string, loopDescription: string, notification: string, newStatus: string) => void): void {
  onLoopNotification = cb;
}

export function stopSleepCycle(): void {
  sendToServer = null;
  running = false;
  console.log("[SleepCycle] Stopped");
}

/**
 * @deprecated Use periodic manager's notifyActivity() instead.
 */
export function notifyActivity(): void {
  // No-op — idle tracking now lives in the periodic manager
}

/**
 * Returns true if the sleep cycle is currently running a consolidation pass.
 */
export function isSleepCycleRunning(): boolean {
  return running;
}

/**
 * Execute a single sleep cycle.
 * Called by the periodic manager — idle detection and overlap prevention
 * are handled by the manager, not here.
 */
export async function executeSleepCycle(): Promise<void> {
  await runCycle();
}

// ============================================
// MAIN CYCLE
// ============================================

async function runCycle(): Promise<void> {
  if (!sendToServer) {
    console.log("[SleepCycle] No server connection — skipping cycle");
    return;
  }

  running = true;
  const startTime = Date.now();
  console.log("[SleepCycle] Starting memory consolidation...");

  const state = await loadSleepState();
  let threadsProcessed = 0;
  let loopsInvestigated = 0;
  let totalInstructionsApplied = 0;

  try {
    // ── Phase 1: Condense active threads ──
    const threads = await store.getAllThreadSummaries();
    const l0Index = await store.getL0MemoryIndex();

    // Filter to threads with activity since last cycle
    const activeThreads = threads.filter(t => {
      if (!state.lastCycleAt) return true; // First cycle — process all
      return t.lastActiveAt > state.lastCycleAt;
    }).slice(0, MAX_THREADS_PER_CYCLE);

    console.log(`[SleepCycle] ${activeThreads.length} threads with new activity`);

    for (const threadSummary of activeThreads) {
      try {
        const result = await condenseThread(threadSummary, l0Index, state.lastCycleAt);
        threadsProcessed++;
        totalInstructionsApplied += result.applied;
        console.log(`[SleepCycle] Thread "${threadSummary.topic}": ${result.applied} instructions applied`);
      } catch (err) {
        console.error(`[SleepCycle] Failed to condense thread ${threadSummary.id}:`, err);
      }
    }

    // ── Phase 2: Try to resolve open loops ──
    const allModels = await store.getAllMentalModels();
    const openLoops: { model: any; loop: any }[] = [];

    for (const model of allModels) {
      for (const loop of model.openLoops || []) {
        if (loop.status === "open" || loop.status === "investigating") {
          // Skip loops attempted in the last 24 hours (cooldown to prevent spam)
          if (loop.lastAttemptedAt) {
            const hoursSinceAttempt = (Date.now() - new Date(loop.lastAttemptedAt).getTime()) / (1000 * 60 * 60);
            if (hoursSinceAttempt < 24) continue;
          }
          openLoops.push({ model, loop });
        }
      }
    }

    // Prioritize: oldest loops first (longest unresolved get attention first)
    openLoops.sort((a, b) => {
      return new Date(a.loop.identifiedAt).getTime() - new Date(b.loop.identifiedAt).getTime();
    });

    const loopsToInvestigate = openLoops.slice(0, MAX_LOOPS_PER_CYCLE);
    console.log(`[SleepCycle] ${openLoops.length} open loops eligible (24h cooldown), investigating ${loopsToInvestigate.length}`);

    let notifiedThisCycle = false;
    for (const { model, loop } of loopsToInvestigate) {
      try {
        const result = await resolveLoop(model, loop, notifiedThisCycle);
        loopsInvestigated++;
        if (result.notified) notifiedThisCycle = true;
        if (result.applied > 0) {
          totalInstructionsApplied += result.applied;
          console.log(`[SleepCycle] Loop "${loop.description}" on ${model.name}: ${result.newStatus}`);
        }
      } catch (err) {
        console.error(`[SleepCycle] Failed to resolve loop ${loop.id}:`, err);
      }
    }

    // ── Phase 2.5: Detect and merge duplicate models ──
    const mergeResult = await detectAndMergeDuplicates(allModels, state);
    if (mergeResult.merged > 0) {
      console.log(`[SleepCycle] Merged ${mergeResult.merged} duplicate model pair(s)`);
      totalInstructionsApplied += mergeResult.merged;
    }
    if (mergeResult.newReviewedPairs.length > 0) {
      state.reviewedPairs = [
        ...(state.reviewedPairs || []),
        ...mergeResult.newReviewedPairs,
      ];
    }

    // ── Phase 3: Prune the index ──
    // Re-fetch models if merges happened (allModels is stale)
    const modelsForPrune = mergeResult.merged > 0 ? await store.getAllMentalModels() : allModels;
    await pruneIndex(modelsForPrune);

    // ── Phase 4: Clean up expired agent work threads ──
    const agentWorkCleaned = await cleanupExpiredAgentWork();
    if (agentWorkCleaned > 0) {
      console.log(`[SleepCycle] Cleaned ${agentWorkCleaned} expired agent work threads`);
    }

  } catch (err) {
    console.error("[SleepCycle] Cycle error:", err);
  } finally {
    // Save cycle state
    const duration = Date.now() - startTime;
    try {
      await saveSleepState({
        lastCycleAt: new Date().toISOString(),
        lastCycleDurationMs: duration,
        threadsProcessed,
        loopsInvestigated,
        instructionsApplied: totalInstructionsApplied,
        reviewedPairs: state.reviewedPairs,
      });
    } catch (saveErr) {
      console.error("[SleepCycle] Failed to save sleep state:", saveErr);
    }

    running = false;
    console.log(`[SleepCycle] Complete — ${threadsProcessed} threads, ${loopsInvestigated} loops, ${totalInstructionsApplied} instructions in ${(duration / 1000).toFixed(1)}s`);
  }
}

// ============================================
// PHASE 1: CONDENSE THREAD
// ============================================

async function condenseThread(
  threadSummary: { id: string; topic: string; entities: string[]; keywords: string[] },
  l0Index: Awaited<ReturnType<typeof store.getL0MemoryIndex>>,
  lastCycleAt: string | null
): Promise<{ applied: number }> {
  if (!sendToServer) return { applied: 0 };

  // Load the full thread
  const thread = await store.getThread(threadSummary.id);
  if (!thread) return { applied: 0 };

  // Pre-fetch models that might be relevant based on thread entities
  const relevantModels = [];
  for (const entity of threadSummary.entities || []) {
    const slug = entity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const model = await store.getMentalModel(slug);
    if (model) relevantModels.push(model);
  }

  // Also check keyword matches against model index
  for (const indexEntry of l0Index.models) {
    if (relevantModels.some(m => m.slug === indexEntry.slug)) continue; // Already loaded
    const overlap = indexEntry.keywords.some(k => 
      threadSummary.keywords.includes(k) || threadSummary.topic.toLowerCase().includes(k)
    );
    if (overlap) {
      const model = await store.getMentalModel(indexEntry.slug);
      if (model) relevantModels.push(model);
    }
  }

  // Send condense request to server
  const response = await sendToServer({
    type: "condense_request",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      thread,
      modelIndex: l0Index.models,
      relevantModels,
      lastCycleAt,
    },
  });

  if (!response?.instructions?.length) return { applied: 0 };

  // Apply the instructions programmatically
  const result = await applyInstructions(response.instructions);

  if (result.errors.length > 0) {
    console.warn(`[SleepCycle] Condense errors for thread ${threadSummary.id}:`, result.errors);
  }

  return { applied: result.applied };
}

// ============================================
// PHASE 2: RESOLVE OPEN LOOPS
// ============================================

async function resolveLoop(
  model: any,
  loop: any,
  suppressNotification = false
): Promise<{ applied: number; newStatus: string; notified: boolean }> {
  if (!sendToServer) return { applied: 0, newStatus: loop.status, notified: false };

  // Build context beliefs for the resolver
  const contextBeliefs = (model.beliefs || []).map((b: any) => ({
    attribute: b.attribute,
    value: b.value,
  }));

  // Determine available tools based on what the agent can do
  const availableTools = ["web_search"]; // Base tools always available
  // TODO: Detect additional tools based on installed skills/integrations
  // e.g., "email_lookup", "calendar_check", "hubspot_query"

  const response = await sendToServer({
    type: "resolve_loop_request",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      loop,
      modelSlug: model.slug,
      modelName: model.name,
      contextBeliefs,
      availableTools,
    },
  });

  // Stamp attempt tracking on the loop (persisted via the status update below)
  loop.lastAttemptedAt = new Date().toISOString();
  loop.attemptCount = (loop.attemptCount || 0) + 1;

  if (!response) {
    // Still save the attempt timestamp even on failure
    await store.saveMentalModel(model);
    return { applied: 0, newStatus: loop.status, notified: false };
  }

  let applied = 0;

  // Apply the loop status update
  const statusInstruction = {
    action: response.newStatus === "resolved" ? "close_loop" : "update_loop_status",
    modelSlug: model.slug,
    loopId: loop.id,
    ...(response.newStatus === "resolved"
      ? { resolution: response.resolution || "Resolved during sleep cycle" }
      : { status: response.newStatus, reason: response.blockedReason || "Could not resolve automatically" }),
  };
  const statusResult = await applyInstructions([statusInstruction as any]);
  applied += statusResult.applied;

  // Apply any side effects (new beliefs discovered during research)
  if (response.sideEffects?.length) {
    const sideResult = await applyInstructions(response.sideEffects);
    applied += sideResult.applied;
  }

  // Notify the user if the resolver found something worth sharing
  // Rules: max 1 notification per cycle, and don't re-notify loops the user already saw
  let notified = false;
  if (response.notifyUser && response.notification && onLoopNotification && !suppressNotification) {
    if (!loop.lastNotifiedAt) {
      loop.lastNotifiedAt = new Date().toISOString();
      await store.saveMentalModel(model);
      onLoopNotification(model.name, loop.description, response.notification, response.newStatus);
      notified = true;
    } else {
      console.log(`[SleepCycle] Skipping re-notification for loop "${loop.description}" (already notified at ${loop.lastNotifiedAt})`);
    }
  }

  return { applied, newStatus: response.newStatus, notified };
}

// ============================================
// PHASE 3: PRUNE INDEX
// ============================================

async function pruneIndex(allModels: any[]): Promise<void> {
  if (allModels.length <= HOT_MODEL_LIMIT) return;

  // Score models by relevance
  const scored = allModels.map(model => {
    let score = 0;
    // Recency: more recent = higher score
    const daysSinceUpdate = (Date.now() - new Date(model.lastUpdatedAt).getTime()) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 100 - daysSinceUpdate * 2);
    // Activity: more beliefs = more important
    score += Math.min(50, (model.beliefs?.length || 0) * 5);
    // Open loops: models with unresolved items are more relevant
    score += (model.openLoops?.filter((l: any) => l.status === "open").length || 0) * 20;
    // Access count
    score += Math.min(30, (model.accessCount || 0) * 2);
    // Relationships: well-connected models are more important
    score += Math.min(20, (model.relationships?.length || 0) * 5);

    return { slug: model.slug, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // The top HOT_MODEL_LIMIT models stay hot.
  // Demoted models are moved from models/ to deep/ — still on disk, just out of the hot path.
  const demoted = scored.slice(HOT_MODEL_LIMIT);
  if (demoted.length > 0) {
    await fs.mkdir(DEEP_MEMORY_DIR, { recursive: true });
    console.log(`[SleepCycle] Demoting ${demoted.length} models to deep memory:`, 
      demoted.map(d => d.slug).join(", "));

    for (const { slug } of demoted) {
      const src = path.join(MODELS_DIR, `${slug}.json`);
      const dest = path.join(DEEP_MEMORY_DIR, `${slug}.json`);
      try {
        await fs.rename(src, dest);
      } catch {
        // File may already be in deep, or doesn't exist — that's fine
      }
    }
  }

  // Rebuild the index from whatever remains in models/
  await store.rebuildMemoryIndex();
}

// ============================================
// PHASE 2.5: DUPLICATE MODEL DETECTION
// ============================================

const MAX_MERGE_CANDIDATES_PER_CYCLE = 5;
const AUTO_MERGE_THRESHOLD = 0.85;
const MAX_REVIEWED_PAIRS = 500;
const LOCAL_LLM_TIMEOUT_MS = 15_000;

interface DuplicateDetectionResult {
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
async function detectAndMergeDuplicates(
  allModels: any[],
  state: SleepCycleState
): Promise<DuplicateDetectionResult> {
  const result: DuplicateDetectionResult = { merged: 0, newReviewedPairs: [] };

  if (allModels.length < 2) return result;

  // Check if local LLM is available
  let isLocalReady = false;
  try {
    const { isLocalModelReady } = await import("../llm/local-llm.js");
    isLocalReady = isLocalModelReady();
  } catch {
    // local LLM module not available
  }
  if (!isLocalReady) {
    console.log("[SleepCycle] Local LLM not ready — skipping duplicate detection");
    return result;
  }

  const reviewedSet = new Set(state.reviewedPairs || []);

  // Generate candidate pairs: same category, not already reviewed
  const candidates: { a: any; b: any; pairKey: string }[] = [];
  for (let i = 0; i < allModels.length; i++) {
    for (let j = i + 1; j < allModels.length; j++) {
      const a = allModels[i];
      const b = allModels[j];

      // Same category is a prerequisite (person ≠ project)
      if (a.category !== b.category) continue;

      // Canonical pair key (sorted so A:B === B:A)
      const pairKey = [a.slug, b.slug].sort().join(":");
      if (reviewedSet.has(pairKey)) continue;

      candidates.push({ a, b, pairKey });
    }
  }

  if (candidates.length === 0) return result;

  // Pre-filter: quick name/keyword heuristics to rank candidates
  const scored = candidates.map(c => {
    let score = 0;
    // Name substring containment (e.g., "Jesse" ⊂ "Jesse Wallace")
    const aLow = c.a.name.toLowerCase();
    const bLow = c.b.name.toLowerCase();
    if (aLow.includes(bLow) || bLow.includes(aLow)) score += 3;
    // Shared keywords
    const aKw = new Set(extractModelKeywords(c.a));
    const bKw = extractModelKeywords(c.b);
    const overlap = bKw.filter(k => aKw.has(k)).length;
    if (overlap >= 2) score += 2;
    if (overlap >= 4) score += 1;
    // Shared belief attributes
    const aAttrs = new Set((c.a.beliefs || []).map((b: any) => b.attribute));
    const sharedAttrs = (c.b.beliefs || []).filter((b: any) => aAttrs.has(b.attribute)).length;
    if (sharedAttrs >= 1) score += 2;
    if (sharedAttrs >= 3) score += 1;
    return { ...c, heuristicScore: score };
  });

  // Only send top candidates to the LLM (sorted by heuristic score, min score 2)
  scored.sort((a, b) => b.heuristicScore - a.heuristicScore);
  const toEvaluate = scored
    .filter(s => s.heuristicScore >= 2)
    .slice(0, MAX_MERGE_CANDIDATES_PER_CYCLE);

  if (toEvaluate.length === 0) return result;

  console.log(`[SleepCycle] Evaluating ${toEvaluate.length} candidate pair(s) for duplicate models`);

  const mergedSlugs = new Set<string>();

  for (const candidate of toEvaluate) {
    // Skip candidates that reference a model we already merged this cycle
    if (mergedSlugs.has(candidate.a.slug) || mergedSlugs.has(candidate.b.slug)) continue;

    try {
      const similarity = await scorePairWithLocalLLM(candidate.a, candidate.b);
      console.log(`[SleepCycle] Similarity: ${candidate.a.name} ↔ ${candidate.b.name} = ${similarity.toFixed(2)}`);

      if (similarity >= AUTO_MERGE_THRESHOLD) {
        // Auto-merge: keep the model with more beliefs (richer data)
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
        // Not similar enough — mark as reviewed so we skip next cycle
        result.newReviewedPairs.push(candidate.pairKey);
      }
    } catch (err) {
      console.error(`[SleepCycle] Failed to evaluate pair ${candidate.pairKey}:`, err);
      // Don't mark as reviewed on error — retry next cycle
    }
  }

  // Cap reviewed pairs to prevent unbounded growth
  if (result.newReviewedPairs.length > 0) {
    const allReviewed = [...(state.reviewedPairs || []), ...result.newReviewedPairs];
    if (allReviewed.length > MAX_REVIEWED_PAIRS) {
      // Keep the most recent pairs, drop the oldest
      state.reviewedPairs = allReviewed.slice(-MAX_REVIEWED_PAIRS);
      result.newReviewedPairs = [];
    }
  }

  return result;
}

/**
 * Use the local LLM to score similarity between two mental models.
 * Returns a float 0.0 - 1.0 where 1.0 = definitely the same entity.
 */
async function scorePairWithLocalLLM(modelA: any, modelB: any): Promise<number> {
  const { queryLocalLLM } = await import("../llm/local-llm.js");
  const { buildModelSkeleton } = await import("./store-models.js");

  const skelA = buildModelSkeleton(modelA);
  const skelB = buildModelSkeleton(modelB);

  const prompt = `Model A:
${skelA}

Model B:
${skelB}

Are these two models about the SAME entity (same person, place, thing, etc.)?
Reply with ONLY a number from 0.0 to 1.0:
- 1.0 = definitely the same entity
- 0.5 = possibly the same, not sure
- 0.0 = definitely different entities`;

  const systemPrompt = "You compare two entity profiles and return a single similarity score. Reply with ONLY a decimal number between 0.0 and 1.0. No explanation.";

  // Race with timeout to prevent hanging.
  // Suppress the dangling promise's rejection to avoid crashing on unhandled rejection.
  const llmCall = queryLocalLLM(prompt, systemPrompt, 16);
  llmCall.catch(() => {}); // Prevent unhandled rejection if timeout wins the race
  const response = await Promise.race([
    llmCall,
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("Local LLM timed out")), LOCAL_LLM_TIMEOUT_MS)
    ),
  ]);

  // Parse the numeric response
  const match = response.match(/([01]\.?\d*)/);
  if (match) {
    const score = parseFloat(match[1]);
    if (!isNaN(score) && score >= 0 && score <= 1) return score;
  }

  // If the LLM returned garbage, return 0 (don't merge)
  console.warn(`[SleepCycle] Local LLM returned unparseable similarity score: "${response.trim()}"`);
  return 0;
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

// ============================================
// STATE PERSISTENCE
// ============================================

async function loadSleepState(): Promise<SleepCycleState> {
  try {
    const raw = await fs.readFile(SLEEP_STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      lastCycleAt: "",
      lastCycleDurationMs: 0,
      threadsProcessed: 0,
      loopsInvestigated: 0,
      instructionsApplied: 0,
    };
  }
}

async function saveSleepState(state: SleepCycleState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SLEEP_STATE_PATH), { recursive: true });
    await fs.writeFile(SLEEP_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[SleepCycle] Failed to save state:", err);
  }
}

// ============================================
// FLUSH SESSION MEMORY
// ============================================

export interface FlushResult {
  threadsCondensed: number;
  threadsArchived: number;
  instructionsApplied: number;
  errors: string[];
}

/**
 * Flush session memory: condense all active threads (extracting knowledge
 * into mental models via the sleep cycle), then archive them.
 * This resets the conversation history while preserving learned knowledge.
 */
export async function flushSession(): Promise<FlushResult> {
  const result: FlushResult = {
    threadsCondensed: 0,
    threadsArchived: 0,
    instructionsApplied: 0,
    errors: [],
  };

  if (!sendToServer) {
    result.errors.push("No server connection — cannot condense threads");
    // Still archive threads even without server (just won't extract knowledge)
  }

  try {
    const threads = await store.getAllThreadSummaries();
    const activeThreads = threads.filter(t => t.status !== "archived");

    if (activeThreads.length === 0) {
      return result;
    }

    console.log(`[Flush] Condensing ${activeThreads.length} active thread(s)...`);

    // Phase 1: Condense threads into mental models (if server connected)
    if (sendToServer) {
      const l0Index = await store.getL0MemoryIndex();
      const state = await loadSleepState();

      for (const threadSummary of activeThreads) {
        try {
          const condensed = await condenseThread(threadSummary, l0Index, state.lastCycleAt);
          result.threadsCondensed++;
          result.instructionsApplied += condensed.applied;
          console.log(`[Flush] Thread "${threadSummary.topic}": ${condensed.applied} instructions applied`);
        } catch (err) {
          const msg = `Failed to condense thread ${threadSummary.id}: ${err instanceof Error ? err.message : err}`;
          result.errors.push(msg);
          console.error(`[Flush] ${msg}`);
        }
      }
    }

    // Phase 2: Archive all active threads
    for (const threadSummary of activeThreads) {
      try {
        const archived = await store.archiveThread(threadSummary.id);
        if (archived) {
          result.threadsArchived++;
        }
      } catch (err) {
        const msg = `Failed to archive thread ${threadSummary.id}: ${err instanceof Error ? err.message : err}`;
        result.errors.push(msg);
      }
    }

    // Update sleep state
    await saveSleepState({
      lastCycleAt: new Date().toISOString(),
      lastCycleDurationMs: 0,
      threadsProcessed: result.threadsCondensed,
      loopsInvestigated: 0,
      instructionsApplied: result.instructionsApplied,
    });

    console.log(`[Flush] Complete — ${result.threadsCondensed} condensed, ${result.threadsArchived} archived, ${result.instructionsApplied} instructions`);
  } catch (err) {
    const msg = `Flush cycle error: ${err instanceof Error ? err.message : err}`;
    result.errors.push(msg);
    console.error(`[Flush] ${msg}`);
  }

  return result;
}
