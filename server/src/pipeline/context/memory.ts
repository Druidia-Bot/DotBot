/**
 * Context — Memory & State Fetching
 *
 * Fetches L0 memory index, recent conversation history,
 * active tasks, and agent identity from the local agent.
 */

import { createComponentLogger } from "#logging.js";
import { sendMemoryRequest } from "#ws/device-bridge.js";
import { formatModelSpine } from "#tool-loop/handlers/memory-get-model-spine.js";
export { formatModelSpine } from "#tool-loop/handlers/memory-get-model-spine.js";
import type { MemoryRequest } from "#ws/devices.js";

const log = createComponentLogger("context.memory");

// ── Types ───────────────────────────────────────────────────────────

export interface L0Index {
  models: any[];
  threads: any[];
  sessionSummary: string | null;
}

export interface MemoryState {
  l0Index: L0Index;
  priorHistory: { role: "user" | "assistant"; content: string }[];
  activeThreadId: string | null;
  activeTasks: any[];
  agentIdentity: string | undefined;
}

// ── Fetchers ────────────────────────────────────────────────────────

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

export async function fetchRecentHistory(deviceId: string): Promise<{
  history: { role: "user" | "assistant"; content: string }[];
  threadId: string | null;
}> {
  try {
    const result = await sendMemoryRequest(deviceId, {
      action: "get_recent_history",
      data: { limit: 10 },
    } as MemoryRequest);
    const history = result?.messages || [];
    const threadId = result?.threadId || null;
    if (threadId) {
      log.info("Active thread from local agent", { activeThreadId: threadId });
    } else {
      log.warn("get_recent_history returned no threadId", {
        historyResult: JSON.stringify(result)?.substring(0, 200),
      });
    }
    return { history, threadId };
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

export async function fetchAgentIdentity(deviceId: string): Promise<string | undefined> {
  try {
    const identityResult = await sendMemoryRequest(deviceId, {
      action: "get_identity",
    } as MemoryRequest);
    if (!identityResult) return undefined;

    const lines: string[] = [
      `Name: ${identityResult.name}`,
      `Role: ${identityResult.role}`,
      `Traits: ${(identityResult.traits || []).join("; ")}`,
      `Ethics: ${(identityResult.ethics || []).join("; ")}`,
      `Code of Conduct: ${(identityResult.codeOfConduct || []).join("; ")}`,
      `Communication Style: ${(identityResult.communicationStyle || []).join(", ")}`,
    ];
    if (identityResult.humanInstructions?.length > 0) {
      lines.push(`Human Instructions: ${identityResult.humanInstructions.join("; ")}`);
    }
    const propKeys = Object.keys(identityResult.properties || {});
    if (propKeys.length > 0) {
      lines.push(`Properties: ${propKeys.map((k: string) => `${k}: ${identityResult.properties[k]}`).join("; ")}`);
    }
    const pathKeys = Object.keys(identityResult.importiantPaths || {});
    if (pathKeys.length > 0) {
      lines.push("Important Paths:");
      for (const k of pathKeys) {
        const raw = identityResult.importiantPaths[k];
        const [p, desc] = raw.includes(" | ") ? raw.split(" | ", 2) : [raw, ""];
        lines.push(`  ${k}: ${p}${desc ? ` — ${desc}` : ""}`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    log.warn("Failed to fetch agent identity from local agent", { error: err });
    return undefined;
  }
}

// ── Model Fetchers ─────────────────────────────────────────────────
//
// Canonical API for fetching memory models. All consumers (Dot,
// receptionist, etc.) should import from here — no direct WS calls.
//
//   fetchAllModels(deviceId)        → full model objects[]
//   fetchAllModelSpines(deviceId)   → rendered markdown spines[]
//   fetchModel(deviceId, slug)      → single full model | null
//   fetchModelSpine(deviceId, slug) → single rendered spine | null
// ────────────────────────────────────────────────────────────────────

/**
 * Fetch all hot mental models from the local agent in one WS round-trip.
 * Returns full model objects. Empty array on failure.
 */
export async function fetchAllModels(deviceId: string): Promise<any[]> {
  try {
    const result = await sendMemoryRequest(deviceId, {
      action: "get_all_models",
    } as MemoryRequest);
    if (Array.isArray(result)) {
      log.info("Fetched all mental models", { count: result.length });
      return result;
    }
  } catch (err) {
    log.warn("Failed to fetch all mental models from local agent", { error: err });
  }
  return [];
}

/**
 * Fetch all hot models and render each as a structured markdown spine.
 * Returns { model, spine }[] so callers can filter/sort on model fields
 * while using the pre-rendered spine for prompt injection.
 */
export async function fetchAllModelSpines(deviceId: string): Promise<{ model: any; spine: string }[]> {
  const models = await fetchAllModels(deviceId);
  return models.map(m => ({ model: m, spine: formatModelSpine(m) }));
}

/**
 * Fetch a single mental model by slug. Returns null if not found.
 */
export async function fetchModel(deviceId: string, slug: string): Promise<any | null> {
  try {
    const result = await sendMemoryRequest(deviceId, {
      action: "get_model_detail",
      modelSlug: slug,
    } as MemoryRequest);
    return result ?? null;
  } catch (err) {
    log.warn("Failed to fetch mental model", { slug, error: err });
    return null;
  }
}

/**
 * Fetch a single mental model by slug and render it as a markdown spine.
 * Optional confidence score is included in the spine header.
 */
export async function fetchModelSpine(
  deviceId: string,
  slug: string,
  confidence?: number,
): Promise<string | null> {
  const model = await fetchModel(deviceId, slug);
  if (!model) return null;
  return formatModelSpine(model, confidence);
}

/**
 * Fetch all memory state in one call. Runs fetches in parallel.
 */
export async function fetchMemoryState(deviceId: string): Promise<MemoryState> {
  const [l0Index, { history: priorHistory, threadId: activeThreadId }, activeTasks, agentIdentity] =
    await Promise.all([
      fetchL0Index(deviceId),
      fetchRecentHistory(deviceId),
      fetchActiveTasks(deviceId),
      fetchAgentIdentity(deviceId),
    ]);

  return { l0Index, priorHistory, activeThreadId, activeTasks, agentIdentity };
}
