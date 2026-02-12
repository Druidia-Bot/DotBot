/**
 * Prompt Handler — Orchestrator
 * 
 * Main prompt handler that acts as an orchestrator:
 * 1. System commands (flush memory) are handled directly
 * 2. If a background agent loop is running → inject the message as a correction
 * 3. Otherwise, classify the request via receptionist (fast, ~1-2s)
 * 4. If actionable → spawn a background agent loop, respond immediately
 * 5. If simple (CONVERSATIONAL) → handle inline
 * 
 * Extracted from server.ts to keep concerns separated.
 */

import { nanoid } from "nanoid";
import type { WSPromptMessage } from "../types.js";
import { createComponentLogger } from "../logging.js";
import {
  devices,
  sendMessage,
  getDeviceForUser,
} from "./devices.js";
import {
  sendMemoryRequest,
} from "./device-bridge.js";
import { buildRequestContext } from "./context-builder.js";
import { createRunner } from "./runner-factory.js";
import { executeV2Pipeline, MessageRouter } from "../agents/pipeline.js";
import { filterManifest, mergeWithCoreRegistry } from "../tools/platform-filters.js";

const log = createComponentLogger("ws.prompt");

/** Per-user V2 message routers for session continuity (follow-up routing to existing agents). */
const v2Routers = new Map<string, MessageRouter>();

// ============================================
// PROMPT HANDLER — ORCHESTRATOR
// ============================================

export async function handlePrompt(
  deviceId: string,
  message: WSPromptMessage,
  apiKey: string,
  serverProvider: string
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  if (!message.payload || typeof message.payload.prompt !== "string" || !message.payload.prompt.trim()) {
    log.warn("Invalid prompt message — missing or empty payload.prompt", { deviceId });
    return;
  }
  const { prompt } = message.payload;
  const userId = device.session.userId;
  
  log.info(`Prompt from ${device.session.deviceName}`, { prompt });

  // ── System commands ──
  const normalizedPrompt = prompt.toLowerCase().trim();
  if (normalizedPrompt === "flush session memory" || normalizedPrompt === "flush memory" || normalizedPrompt === "clear session memory") {
    v2Routers.delete(userId); // Clear V2 agent routing state on session reset
    await handleFlushMemory(device, message, userId);
    return;
  }
  if (normalizedPrompt === "clear conversation history" || normalizedPrompt === "clear threads" || normalizedPrompt === "clear thread memory" || normalizedPrompt === "flush threads" || normalizedPrompt === "flush thread memory") {
    await handleClearThreads(device, message, userId);
    return;
  }

  // ── V2 Pipeline (V1 removed) ──
  try {
    // Build enhanced request with context
    const { enhancedRequest, toolManifest, platform, runtimeInfo } = await buildRequestContext(
      deviceId,
      userId,
      prompt
    );

    // Create LLM client
    const { createLLMClient } = await import("../llm/providers.js");
    const llm = createLLMClient({
      provider: serverProvider as any,
      apiKey,
    });

    // Filter tool manifest by platform
    const availableRuntimes = (runtimeInfo || [])
      .filter((r: any) => r.available)
      .map((r: any) => r.name as string);
    const v2Manifest = platform
      ? mergeWithCoreRegistry(filterManifest(toolManifest, platform, availableRuntimes))
      : mergeWithCoreRegistry(toolManifest);

    // Build runner options from the factory's callback shape (reuse the same runner factory for callbacks)
    const v2Runner = createRunner(apiKey, userId, v2Manifest, runtimeInfo, serverProvider);

    // Reuse existing router for follow-up message routing to active agents
    const existingRouter = v2Routers.get(userId);

    // ── Pre-classify for time estimation ──
    // Run receptionist upfront so we can send acknowledgment for long-running tasks
    const { runReceptionist } = await import("../agents/intake.js");
    const classification = await runReceptionist(llm, v2Runner.options, enhancedRequest, userId);

    // Send acknowledgment for long-running tasks (> 10s)
    if (classification.estimatedDurationMs && classification.estimatedDurationMs > 10000 && classification.acknowledgmentMessage) {
      sendMessage(device.ws, {
        type: "response",
        id: `${message.id}_ack`,
        timestamp: Date.now(),
        payload: {
          success: true,
          response: classification.acknowledgmentMessage,
          classification: "CONVERSATIONAL" as const,
          threadIds: [],
          keyPoints: [],
        }
      });
    }

    // Execute V2 pipeline with precomputed classification to avoid calling receptionist twice
    const result = await executeV2Pipeline(
      llm,
      v2Runner.options, // AgentRunnerOptions with all callbacks wired
      enhancedRequest,
      userId,
      `session_v2_${nanoid()}`,
      existingRouter,
      classification, // Pass precomputed decision to skip redundant receptionist call
    );

    // Store the router for session continuity (follow-up routing)
    if (result.router) {
      v2Routers.set(userId, result.router);
    }

    // Check if multi-agent response (more than 1 completed agent)
    const completedAgents = result.agentResults?.filter(r => r.status === "completed") || [];
    const isMultiAgent = completedAgents.length > 1;

    sendMessage(device.ws, {
      type: "response",
      id: message.id,
      timestamp: Date.now(),
      payload: {
        success: result.success,
        response: result.response,
        classification: result.classification,
        threadIds: result.threadIds,
        keyPoints: result.keyPoints,
        ...(result.error && { error: result.error }),
        // V2: Include agent details for multi-agent responses
        ...(isMultiAgent && {
          multiAgent: true,
          agents: completedAgents.map(a => ({
            topic: a.topic,
            response: a.response,
          })),
        }),
      }
    });
    return;
  } catch (error) {
    log.error("V2 pipeline error", { error });
    sendMessage(device.ws, {
      type: "response",
      id: message.id,
      timestamp: Date.now(),
      payload: {
        success: false,
        response: `I encountered an error processing your request: ${error instanceof Error ? error.message : "Unknown error"}`,
        classification: "CONVERSATIONAL" as const,
        threadIds: [],
        keyPoints: [],
        error: error instanceof Error ? error.message : "Unknown error",
      }
    });
    return;
  }
}


// ============================================
// SYSTEM COMMAND: FLUSH SESSION MEMORY
// ============================================

async function handleFlushMemory(
  device: { ws: import("ws").WebSocket; session: { userId: string } },
  message: WSPromptMessage,
  userId: string
): Promise<void> {
  log.info("Flush session memory triggered", { userId });
  const agentDeviceId = getDeviceForUser(userId);
  if (!agentDeviceId) {
    sendMessage(device.ws, {
      type: "response", id: message.id, timestamp: Date.now(),
      payload: { success: false, response: "No local agent connected — cannot flush memory.", classification: "CONVERSATIONAL" as const, threadIds: [], keyPoints: [] }
    });
    return;
  }
  try {
    sendMessage(device.ws, {
      type: "response", id: `${message.id}_ack`, timestamp: Date.now(),
      payload: { success: true, response: "🧠 Flushing session memory — condensing conversations into mental models, then archiving threads...", classification: "CONVERSATIONAL" as const, threadIds: [], keyPoints: [] }
    });
    const result = await sendMemoryRequest(agentDeviceId, { action: "flush_session", requestId: nanoid() } as any, 180_000);
    const r = result || { threadsCondensed: 0, threadsArchived: 0, instructionsApplied: 0, errors: [] };
    const summary = r.threadsArchived > 0
      ? `Session memory flushed.\n- **${r.threadsCondensed}** thread(s) condensed into mental models\n- **${r.threadsArchived}** thread(s) archived\n- **${r.instructionsApplied}** knowledge instruction(s) applied${r.errors?.length ? `\n- ⚠️ ${r.errors.length} error(s)` : ""}\n\nConversation history is cleared. Everything I learned has been saved to long-term memory.`
      : "No active threads to flush — session memory is already clean.";
    sendMessage(device.ws, {
      type: "response", id: message.id, timestamp: Date.now(),
      payload: { success: true, response: summary, classification: "CONVERSATIONAL" as const, threadIds: [], keyPoints: [] }
    });
  } catch (err) {
    sendMessage(device.ws, {
      type: "response", id: message.id, timestamp: Date.now(),
      payload: { success: false, response: `Failed to flush session memory: ${err instanceof Error ? err.message : err}`, classification: "CONVERSATIONAL" as const, threadIds: [], keyPoints: [] }
    });
  }
}

// ============================================
// SYSTEM COMMAND: CLEAR CONVERSATION THREADS
// ============================================

async function handleClearThreads(
  device: { ws: import("ws").WebSocket; session: { userId: string } },
  message: WSPromptMessage,
  userId: string
): Promise<void> {
  log.info("Clear conversation threads triggered", { userId });
  const agentDeviceId = getDeviceForUser(userId);
  if (!agentDeviceId) {
    sendMessage(device.ws, {
      type: "response", id: message.id, timestamp: Date.now(),
      payload: { success: false, response: "No local agent connected — cannot clear threads.", classification: "CONVERSATIONAL" as const, threadIds: [], keyPoints: [] }
    });
    return;
  }
  try {
    const result = await sendMemoryRequest(agentDeviceId, { action: "clear_threads", requestId: nanoid() } as any);
    const r = result || { deleted: 0, errors: 0 };
    const summary = r.deleted > 0
      ? `Conversation history cleared.\n- **${r.deleted}** thread(s) deleted${r.errors > 0 ? `\n- ⚠️ ${r.errors} error(s)` : ""}\n\nKnowledge, mental models, and skills are untouched.`
      : "No active threads to clear — conversation history is already clean.";
    sendMessage(device.ws, {
      type: "response", id: message.id, timestamp: Date.now(),
      payload: { success: true, response: summary, classification: "CONVERSATIONAL" as const, threadIds: [], keyPoints: [] }
    });
  } catch (err) {
    sendMessage(device.ws, {
      type: "response", id: message.id, timestamp: Date.now(),
      payload: { success: false, response: `Failed to clear threads: ${err instanceof Error ? err.message : err}`, classification: "CONVERSATIONAL" as const, threadIds: [], keyPoints: [] }
    });
  }
}
