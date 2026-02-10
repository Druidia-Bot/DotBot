/**
 * Context Builder
 * 
 * Fetches all context needed before routing a user prompt:
 * L0 memory index, conversation history, active tasks, tool manifest,
 * user personas, and council paths.
 * 
 * Extracted from server.ts to keep concerns separated.
 */

import { registerUserPersona } from "../personas/loader.js";
import { createComponentLogger } from "../logging.js";
import type { EnhancedPromptRequest } from "../types/agent.js";
import {
  getDeviceForUser,
  type MemoryRequest,
} from "./devices.js";
import {
  sendMemoryRequest,
  requestPersonas,
  requestTools,
} from "./device-bridge.js";

const log = createComponentLogger("ws.context");

// ============================================
// CONTEXT BUILDING
// ============================================

export async function buildRequestContext(
  deviceId: string,
  userId: string,
  prompt: string
): Promise<{
  enhancedRequest: EnhancedPromptRequest;
  toolManifest: any[];
  runtimeInfo: any[];
  agentConnected: boolean;
}> {
  const agentDeviceId = getDeviceForUser(userId);

  // Fetch L0 memory index
  let l0Index: { models: any[]; threads: any[]; sessionSummary: string | null } = {
    models: [], threads: [], sessionSummary: null
  };
  if (agentDeviceId) {
    try {
      const fetched = await sendMemoryRequest(agentDeviceId, {
        action: "get_l0_index",
      } as MemoryRequest);
      if (fetched) l0Index = fetched;
    } catch (err) {
      log.warn("Failed to fetch L0 memory index from local agent", { error: err });
    }
  }

  // Fetch recent conversation history
  let priorHistory: { role: "user" | "assistant"; content: string }[] = [];
  let activeThreadId: string | null = null;
  if (agentDeviceId) {
    try {
      const historyResult = await sendMemoryRequest(agentDeviceId, {
        action: "get_recent_history",
        data: { limit: 10 },
      } as MemoryRequest);
      if (historyResult?.messages) {
        priorHistory = historyResult.messages;
      }
      if (historyResult?.threadId) {
        activeThreadId = historyResult.threadId;
        log.info("Active thread from local agent", { activeThreadId });
      } else {
        log.warn("get_recent_history returned no threadId", { historyResult: JSON.stringify(historyResult)?.substring(0, 200) });
      }
    } catch (err) {
      log.warn("Failed to fetch recent history from local agent", { error: err });
    }
  }
  
  // Fetch active/recent tasks
  let activeTasks: any[] = [];
  if (agentDeviceId) {
    try {
      const taskResult = await sendMemoryRequest(agentDeviceId, {
        action: "get_tasks",
        data: { status: ["in_progress", "failed", "blocked", "pending"], limit: 10 },
      } as MemoryRequest);
      if (Array.isArray(taskResult)) {
        activeTasks = taskResult.map((t: any) => ({
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
  }

  // Fetch agent identity (me.json skeleton)
  let agentIdentity: string | undefined;
  if (agentDeviceId) {
    try {
      const identityResult = await sendMemoryRequest(agentDeviceId, {
        action: "get_identity",
      } as MemoryRequest);
      if (identityResult) {
        // Build compact skeleton on the server side to avoid shipping the builder
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
        agentIdentity = lines.join("\n");
      }
    } catch (err) {
      log.warn("Failed to fetch agent identity from local agent", { error: err });
    }
  }

  // Fetch tool manifest and runtime info
  let toolManifest: any[] = [];
  let runtimeInfo: any[] = [];
  if (agentDeviceId) {
    try {
      const result = await requestTools(agentDeviceId);
      if (result && Array.isArray(result.tools)) {
        toolManifest = result.tools;
        runtimeInfo = result.runtimes || [];
        log.info(`Fetched tool manifest: ${toolManifest.length} tools, ${runtimeInfo.length} runtimes`);
      }
      const { PREMIUM_TOOLS } = await import("../credits/premium-manifest.js");
      const { IMAGEGEN_TOOLS } = await import("../imagegen/manifest.js");
      toolManifest = [...toolManifest, ...PREMIUM_TOOLS, ...IMAGEGEN_TOOLS];
      log.info(`Added ${PREMIUM_TOOLS.length} premium + ${IMAGEGEN_TOOLS.length} imagegen tools to manifest (total: ${toolManifest.length})`);
    } catch (err) {
      log.warn("Failed to fetch tool manifest from local agent", { error: err });
    }
  }

  // Fetch user-defined personas
  let userPersonas: { id: string; name: string; description: string }[] = [];
  if (agentDeviceId) {
    try {
      const personas = await requestPersonas(agentDeviceId);
      if (Array.isArray(personas)) {
        userPersonas = personas.map((p: any) => ({
          id: p.id || p.slug,
          name: p.name || p.id,
          description: p.description || "",
        }));
        for (const p of personas) {
          if (p.id && p.systemPrompt) {
            registerUserPersona({
              id: p.id,
              name: p.name || p.id,
              type: "internal",
              modelTier: p.modelTier || "smart",
              description: p.description || "",
              systemPrompt: p.systemPrompt,
              tools: Array.isArray(p.tools) ? p.tools : [],
              modelRole: p.modelRole || undefined,
              councilOnly: p.councilOnly || false,
            });
          }
        }
      }
    } catch (err) {
      log.warn("Failed to fetch user personas from local agent", { error: err });
    }
  }

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
    matchedCouncils: [],
    userPersonas,
    activeTasks,
    agentIdentity,
  };

  return { enhancedRequest, toolManifest, runtimeInfo, agentConnected: !!agentDeviceId };
}
