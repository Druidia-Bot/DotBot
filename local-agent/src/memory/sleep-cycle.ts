/**
 * Sleep Cycle — Orchestrator
 *
 * Runs every 30 minutes on the local agent. Coordinates the phases:
 * 1. Condense active threads → structured model instructions
 * 2. Resolve open loops via server
 * 2.25. Deduplicate open loops (local LLM)
 * 2.5.  Detect and merge duplicate models (local LLM)
 * 3. Prune index — demote inactive models to deep memory
 * 4. Clean up expired agent work
 *
 * Phase implementations live in:
 * - sleep-phases.ts  (condense, resolve, prune)
 * - sleep-dedup.ts   (loop dedup, model dedup)
 * - sleep-llm.ts     (shared LLM scoring utilities)
 */

import * as store from "./store.js";
import { cleanupExpiredAgentWork } from "./store-agent-work.js";
import { condenseThread, resolveLoop, pruneIndex } from "./sleep-phases.js";
import { deduplicateModelFields, detectAndMergeDuplicates } from "./sleep-dedup.js";
import type { ServerSender } from "./sleep-llm.js";
import type { LoopNotificationCallback } from "./sleep-phases.js";
import type { SleepCycleState } from "./types.js";
import type { PeriodicTaskDef } from "../periodic/index.js";
import path from "path";
import { homedir } from "os";
import { promises as fs } from "fs";

export const CYCLE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_THREADS_PER_CYCLE = 10;
const MAX_LOOPS_PER_CYCLE = 5;
const SLEEP_STATE_PATH = path.join(homedir(), ".bot", "memory", "sleep-state.json");

let sendToServer: ServerSender | null = null;
let running = false;
let onLoopNotification: LoopNotificationCallback | null = null;

// ============================================
// LIFECYCLE
// ============================================

/**
 * Initialize sleep cycle with a server sender.
 * Does NOT start a timer — the periodic manager handles scheduling.
 */
export function initSleepCycle(sender: ServerSender): void {
  sendToServer = sender;
}

/**
 * Backward-compatible wrapper — calls initSleepCycle.
 * @deprecated Use initSleepCycle() + periodic manager instead.
 */
export function startSleepCycle(sender: ServerSender): void {
  initSleepCycle(sender);
}

/**
 * Set callback for loop resolution notifications → #conversation.
 * Fired when the sleep cycle resolves a loop or finds actionable new information.
 */
export function setSleepCycleLoopCallback(cb: LoopNotificationCallback): void {
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

    const activeThreads = threads.filter(t => {
      if (!state.lastCycleAt) return true;
      return t.lastActiveAt > state.lastCycleAt;
    }).slice(0, MAX_THREADS_PER_CYCLE);

    console.log(`[SleepCycle] ${activeThreads.length} threads with new activity`);

    for (const threadSummary of activeThreads) {
      try {
        const result = await condenseThread(sendToServer, threadSummary, l0Index, state.lastCycleAt);
        threadsProcessed++;
        totalInstructionsApplied += result.applied;
        console.log(`[SleepCycle] Thread "${threadSummary.topic}": ${result.applied} instructions applied`);
      } catch (err) {
        console.error(`[SleepCycle] Failed to condense thread ${threadSummary.id}:`, err);
      }
    }

    // ── Phase 2: Try to resolve open loops ──
    const allModels = await store.getAllMentalModels();
    const eligible = collectEligibleLoops(allModels);

    const loopsToInvestigate = eligible.slice(0, MAX_LOOPS_PER_CYCLE);
    console.log(`[SleepCycle] ${eligible.length} open loops eligible (24h cooldown), investigating ${loopsToInvestigate.length}`);

    let notifiedThisCycle = false;
    for (const { model, loop } of loopsToInvestigate) {
      try {
        const result = await resolveLoop(sendToServer, onLoopNotification, model, loop, notifiedThisCycle);
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

    // ── Phase 2.25: Deduplicate fields within each model ──
    const fieldsDeduplicated = await deduplicateModelFields(allModels, sendToServer);
    if (fieldsDeduplicated > 0) {
      console.log(`[SleepCycle] Deduplicated ${fieldsDeduplicated} field item(s) across models`);
      totalInstructionsApplied += fieldsDeduplicated;
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
// HELPERS
// ============================================

/**
 * Collect open/investigating loops that haven't been attempted in the last 24h.
 * Sorted oldest-first (longest unresolved get attention first).
 */
function collectEligibleLoops(allModels: any[]): { model: any; loop: any }[] {
  const loops: { model: any; loop: any }[] = [];

  for (const model of allModels) {
    for (const loop of model.openLoops || []) {
      if (loop.status !== "open" && loop.status !== "investigating") continue;
      if (loop.lastAttemptedAt) {
        const hoursSince = (Date.now() - new Date(loop.lastAttemptedAt).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 24) continue;
      }
      loops.push({ model, loop });
    }
  }

  loops.sort((a, b) =>
    new Date(a.loop.identifiedAt).getTime() - new Date(b.loop.identifiedAt).getTime()
  );

  return loops;
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
          const condensed = await condenseThread(sendToServer, threadSummary, l0Index, state.lastCycleAt);
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

/**
 * Returns the periodic task definition for the sleep cycle.
 * Config is co-located here; post-auth-init just collects it.
 */
export function getPeriodicTaskDef(): PeriodicTaskDef {
  return {
    id: "sleep-cycle",
    name: "Memory Consolidation",
    intervalMs: CYCLE_INTERVAL_MS,
    initialDelayMs: 2 * 60 * 1000, // 2 minutes after startup
    enabled: true,
    run: () => executeSleepCycle(),
  };
}
