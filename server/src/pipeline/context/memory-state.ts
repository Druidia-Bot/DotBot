/**
 * Context — Core State Fetchers
 *
 * Fetches L0 memory index, recent conversation history,
 * active tasks, and the combined memory state.
 */

import { createComponentLogger } from "#logging.js";
import { sendMemoryRequest } from "#ws/device-bridge.js";
import { fetchAgentIdentity, fetchBackstory } from "./memory-identity.js";
import type { MemoryRequest } from "#ws/devices.js";
import type { L0Index, MemoryState } from "./memory-types.js";

const log = createComponentLogger("context.memory");

export async function fetchL0Index(deviceId: string): Promise<L0Index> {
  try {
    const fetched = await sendMemoryRequest(deviceId, {
      action: "get_l0_index",
    } as MemoryRequest);
    if (fetched) {
      log.info("L0 memory index fetched", {
        modelCount: fetched.models?.length ?? 0,
        threadCount: fetched.threads?.length ?? 0,
      });
      return fetched;
    }
  } catch (err) {
    log.warn("Failed to fetch L0 memory index from local agent", { error: err });
  }
  return { models: [], threads: [], sessionSummary: null };
}

export async function fetchRecentHistory(deviceId: string, preferredThreadId?: string, limit = 10): Promise<{
  history: { role: "user" | "assistant"; content: string }[];
  threadId: string | null;
}> {
  try {
    const result = await sendMemoryRequest(deviceId, {
      action: "get_recent_history",
      data: { limit, threadId: preferredThreadId || "conversation" },
    } as MemoryRequest);
    const history = result?.messages || [];
    const resolvedThreadId = result?.threadId || null;
    if (resolvedThreadId) {
      log.info("Active thread from local agent", { activeThreadId: resolvedThreadId });
    } else {
      log.warn("get_recent_history returned no threadId", {
        historyResult: JSON.stringify(result)?.substring(0, 200),
      });
    }
    return { history, threadId: resolvedThreadId };
  } catch (err) {
    log.warn("Failed to fetch recent history from local agent", { error: err });
    return { history: [], threadId: null };
  }
}

export async function fetchActiveTasks(deviceId: string): Promise<any[]> {
  try {
    const result = await sendMemoryRequest(deviceId, {
      action: "get_tasks",
      data: { status: ["in_progress", "failed", "blocked", "pending"], limit: 10 },
    } as MemoryRequest);
    if (Array.isArray(result)) {
      return result.map((t: any) => ({
        id: t.id,
        description: t.description,
        status: t.status,
        priority: t.priority,
        personaId: t.personaId,
        threadId: t.threadId,
        originPrompt: t.originPrompt,
        lastError: t.lastError,
        blockedReason: t.blockedReason,
        updatedAt: t.updatedAt,
        retryCount: t.retryCount || 0,
      }));
    }
  } catch (err) {
    log.warn("Failed to fetch active tasks from local agent", { error: err });
  }
  return [];
}

/**
 * Fetch all memory state in one call. Runs fetches in parallel.
 */
export async function fetchMemoryState(deviceId: string): Promise<MemoryState> {
  const [l0Index, { history: priorHistory, threadId: activeThreadId }, activeTasks, identityResult] =
    await Promise.all([
      fetchL0Index(deviceId),
      fetchRecentHistory(deviceId, undefined, 30),
      fetchActiveTasks(deviceId),
      fetchAgentIdentity(deviceId),
    ]);

  // Only fetch backstory if the identity flag is set (avoids unnecessary WS round-trip)
  let backstory: string | undefined;
  if (identityResult.useBackstory) {
    backstory = await fetchBackstory(deviceId);
  }

  return { l0Index, priorHistory, activeThreadId, activeTasks, agentIdentity: identityResult.skeleton, backstory };
}
