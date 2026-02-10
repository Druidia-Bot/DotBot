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
          openLoops.push({ model, loop });
        }
      }
    }

    // Prioritize: high importance first, then those with tool hints
    openLoops.sort((a, b) => {
      const importanceOrder = { high: 0, medium: 1, low: 2 };
      const aScore = (importanceOrder[a.loop.importance as keyof typeof importanceOrder] ?? 1) + (a.loop.toolHint ? 0 : 10);
      const bScore = (importanceOrder[b.loop.importance as keyof typeof importanceOrder] ?? 1) + (b.loop.toolHint ? 0 : 10);
      return aScore - bScore;
    });

    const loopsToInvestigate = openLoops.slice(0, MAX_LOOPS_PER_CYCLE);
    console.log(`[SleepCycle] ${openLoops.length} open loops total, investigating ${loopsToInvestigate.length}`);

    for (const { model, loop } of loopsToInvestigate) {
      try {
        const result = await resolveLoop(model, loop);
        loopsInvestigated++;
        if (result.applied > 0) {
          totalInstructionsApplied += result.applied;
          console.log(`[SleepCycle] Loop "${loop.description}" on ${model.name}: ${result.newStatus}`);
        }
      } catch (err) {
        console.error(`[SleepCycle] Failed to resolve loop ${loop.id}:`, err);
      }
    }

    // ── Phase 3: Prune the index ──
    await pruneIndex(allModels);

    // ── Phase 4: Clean up expired agent work threads ──
    const agentWorkCleaned = await cleanupExpiredAgentWork();
    if (agentWorkCleaned > 0) {
      console.log(`[SleepCycle] Cleaned ${agentWorkCleaned} expired agent work threads`);
    }

  } catch (err) {
    console.error("[SleepCycle] Cycle error:", err);
  }

  // Save cycle state
  const duration = Date.now() - startTime;
  await saveSleepState({
    lastCycleAt: new Date().toISOString(),
    lastCycleDurationMs: duration,
    threadsProcessed,
    loopsInvestigated,
    instructionsApplied: totalInstructionsApplied,
  });

  running = false;
  console.log(`[SleepCycle] Complete — ${threadsProcessed} threads, ${loopsInvestigated} loops, ${totalInstructionsApplied} instructions in ${(duration / 1000).toFixed(1)}s`);
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
  loop: any
): Promise<{ applied: number; newStatus: string }> {
  if (!sendToServer) return { applied: 0, newStatus: loop.status };

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

  if (!response) return { applied: 0, newStatus: loop.status };

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

  return { applied, newStatus: response.newStatus };
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
