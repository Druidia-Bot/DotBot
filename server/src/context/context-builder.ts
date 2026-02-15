/**
 * Context Builder — Orchestrator
 *
 * First step in the pipeline: gathers all state needed before
 * routing a user prompt. No LLM calls — pure data fetching.
 *
 * Delegates to focused modules:
 *   memory.ts — L0 index, history, tasks, identity
 *   tools.ts  — tool manifest + premium/imagegen augmentation
 *
 * Persona/council fetching is NOT done here — the recruiter
 * handles that (fetch → register → select → write prompt).
 */

import { getDeviceForUser, getPlatformForUser } from "../ws/devices.js";
import { fetchMemoryState } from "./memory.js";
import { fetchToolManifest } from "./tools.js";
import type { EnhancedPromptRequest } from "../types/agent.js";

export async function buildRequestContext(
  deviceId: string,
  userId: string,
  prompt: string
): Promise<{
  enhancedRequest: EnhancedPromptRequest;
  toolManifest: any[];
  runtimeInfo: any[];
  agentConnected: boolean;
  /** Client platform from device session (V2). */
  platform?: "windows" | "linux" | "macos" | "web";
}> {
  const agentDeviceId = getDeviceForUser(userId);

  if (!agentDeviceId) {
    return {
      enhancedRequest: {
        type: "prompt",
        prompt,
        recentHistory: [],
        activeThreadId: null,
        threadIndex: { threads: [] },
        memoryIndex: [],
        activeTasks: [],
        agentIdentity: undefined,
      },
      toolManifest: [],
      runtimeInfo: [],
      agentConnected: false,
    };
  }

  // Memory + tools in parallel — no dependencies between them
  const [memoryState, { toolManifest, runtimeInfo }] =
    await Promise.all([
      fetchMemoryState(agentDeviceId),
      fetchToolManifest(agentDeviceId),
    ]);

  const { l0Index, priorHistory, activeThreadId, activeTasks, agentIdentity } = memoryState;

  const enhancedRequest: EnhancedPromptRequest = {
    type: "prompt",
    prompt,
    recentHistory: priorHistory,
    activeThreadId,
    threadIndex: {
      threads: l0Index.threads.map((t: any) => ({
        id: t.id,
        topic: t.topic,
        lastActive: t.lastActiveAt || "",
        status: t.status || "active",
        entities: t.entities || [],
        keywords: t.keywords || [],
      }))
    },
    memoryIndex: l0Index.models,
    activeTasks,
    agentIdentity,
  };

  const devicePlatform = getPlatformForUser(userId);
  return { enhancedRequest, toolManifest, runtimeInfo, agentConnected: true, platform: devicePlatform };
}
