/**
 * Sleep Cycle — Core Phases
 *
 * Phase 1: Condense active threads into structured model instructions
 * Phase 2: Try to resolve open loops via server
 * Phase 3: Prune the hot model index (demote inactive to deep memory)
 */

import { nanoid } from "nanoid";
import * as store from "./store.js";
import { MODELS_DIR, DEEP_MEMORY_DIR } from "./store-core.js";
import { applyInstructions } from "./instruction-applier.js";
import { loadIdentity, buildIdentitySkeleton } from "./store-identity.js";
import { promises as fs } from "fs";
import path from "path";
import type { ServerSender } from "./sleep-llm.js";

const HOT_MODEL_LIMIT = 50;

async function getIdentitySkeleton(): Promise<string> {
  try {
    const identity = await loadIdentity();
    if (!identity) return "Name: Dot\nRole: AI Assistant";
    return buildIdentitySkeleton(identity);
  } catch {
    return "Name: Dot\nRole: AI Assistant";
  }
}

// ============================================
// PHASE 1: CONDENSE THREAD
// ============================================

export async function condenseThread(
  sendToServer: ServerSender,
  threadSummary: { id: string; topic: string; entities: string[]; keywords: string[] },
  l0Index: Awaited<ReturnType<typeof store.getL0MemoryIndex>>,
  lastCycleAt: string | null,
): Promise<{ applied: number }> {
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
    if (relevantModels.some(m => m.slug === indexEntry.slug)) continue;
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
      identity: await getIdentitySkeleton(),
    },
  });

  if (!response?.instructions?.length) return { applied: 0 };

  const result = await applyInstructions(response.instructions);

  if (result.errors.length > 0) {
    console.warn(`[SleepCycle] Condense errors for thread ${threadSummary.id}:`, result.errors);
  }

  return { applied: result.applied };
}

// ============================================
// PHASE 2: RESOLVE OPEN LOOPS
// ============================================

export type LoopNotificationCallback = (
  modelName: string,
  loopDescription: string,
  notification: string,
  newStatus: string,
) => void;

export async function resolveLoop(
  sendToServer: ServerSender,
  onLoopNotification: LoopNotificationCallback | null,
  model: any,
  loop: any,
  suppressNotification = false,
): Promise<{ applied: number; newStatus: string; notified: boolean }> {
  // Build context beliefs for the resolver
  const contextBeliefs = (model.beliefs || []).map((b: any) => ({
    attribute: b.attribute,
    value: b.value,
  }));

  const availableTools = ["web_search"];

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
      identity: await getIdentitySkeleton(),
    },
  });

  // Stamp attempt tracking
  loop.lastAttemptedAt = new Date().toISOString();
  loop.attemptCount = (loop.attemptCount || 0) + 1;

  if (!response) {
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

export async function pruneIndex(allModels: any[]): Promise<void> {
  if (allModels.length <= HOT_MODEL_LIMIT) return;

  const scored = allModels.map(model => {
    let score = 0;
    const daysSinceUpdate = (Date.now() - new Date(model.lastUpdatedAt).getTime()) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 100 - daysSinceUpdate * 2);
    score += Math.min(50, (model.beliefs?.length || 0) * 5);
    score += (model.openLoops?.filter((l: any) => l.status === "open").length || 0) * 20;
    score += Math.min(30, (model.accessCount || 0) * 2);
    score += Math.min(20, (model.relationships?.length || 0) * 5);
    return { slug: model.slug, score };
  });

  scored.sort((a, b) => b.score - a.score);

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

  await store.rebuildMemoryIndex();
}
