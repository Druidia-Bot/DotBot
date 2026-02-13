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
import { getMessageTracker } from "../agents/message-tracker.js";

const log = createComponentLogger("ws.prompt");

// ============================================
// MESSAGE TRACKER SETUP
// ============================================

/** Global message tracker with timeout alerts sent to users. */
const tracker = getMessageTracker({
  onTimeout: (alert) => {
    log.error("Message timeout detected", {
      messageId: alert.messageId,
      userId: alert.userId,
      stage: alert.stage,
      elapsedMs: alert.elapsedMs,
    });

    // Send alert to user via WebSocket
    const userDevice = Array.from(devices.values()).find(d => d.session.userId === alert.userId);
    if (userDevice) {
      sendMessage(userDevice.ws, {
        type: "response",
        id: alert.messageId,
        timestamp: Date.now(),
        payload: {
          success: false,
          response: `⚠️ **Message Timeout**\n\n${alert.message}\n\nYour message: "${alert.prompt.slice(0, 100)}${alert.prompt.length > 100 ? "..." : ""}"\n\nPlease try rephrasing or breaking your request into smaller parts.`,
          classification: "CONVERSATIONAL" as const,
          threadIds: [],
          keyPoints: [],
          error: "Message processing timeout",
        }
      });
    }
  }
});

/** Per-user V2 orchestrator results for session continuity (injection + follow-up routing). */
const v2OrchestratorResults = new Map<string, import("../agents/orchestrator.js").OrchestratorResult>();


/**
 * Clean up V2 orchestrator state for a disconnected user.
 * Called from server.ts when a user's last device disconnects.
 * Prevents memory leak from unbounded Map growth.
 */
export function cleanupUserSession(userId: string): void {
  const deleted = v2OrchestratorResults.delete(userId);
  if (deleted) {
    log.info("Cleaned up V2 orchestrator state for disconnected user", { userId });
  }
}

// ============================================
// PROMPT HANDLER — ORCHESTRATOR
// ============================================

export async function handlePrompt(
  deviceId: string,
  message: WSPromptMessage,
  apiKey: string,
  serverProvider: string,
  senderWs?: import("ws").WebSocket
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  // Response target: use sender's WebSocket if provided (browser), otherwise device's own WS
  const responseWs = senderWs || device.ws;

  if (!message.payload || typeof message.payload.prompt !== "string" || !message.payload.prompt.trim()) {
    log.warn("Invalid prompt message — missing or empty payload.prompt", { deviceId });
    return;
  }
  const { prompt } = message.payload;
  const userId = device.session.userId;

  log.info(`Prompt from ${device.session.deviceName}`, { prompt });

  // Track message for response monitoring
  tracker.trackMessage(message.id, userId, prompt);

  // ── System commands ──
  const normalizedPrompt = prompt.toLowerCase().trim();
  if (normalizedPrompt === "flush session memory" || normalizedPrompt === "flush memory" || normalizedPrompt === "clear session memory") {
    v2OrchestratorResults.delete(userId); // Clear V2 agent routing state on session reset
    await handleFlushMemory(device, message, userId, tracker);
    return;
  }
  if (normalizedPrompt === "clear conversation history" || normalizedPrompt === "clear threads" || normalizedPrompt === "clear thread memory" || normalizedPrompt === "flush threads" || normalizedPrompt === "flush thread memory") {
    await handleClearThreads(device, message, userId, tracker);
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

    // Reuse existing orchestrator result for injection + follow-up routing to active agents
    const previousResult = v2OrchestratorResults.get(userId);
    const existingRouter = previousResult?.router;

    // ── Pre-classify for time estimation ──
    // Run receptionist upfront so we can send acknowledgment for long-running tasks
    tracker.updateStage(message.id, "receptionist");
    const { runReceptionist } = await import("../agents/intake.js");
    const classification = await runReceptionist(llm, v2Runner.options, enhancedRequest, userId);

    // Send acknowledgment for actionable tasks
    // Always notify for tasks that need execution so the user knows we're working on it.
    // The ack goes to WebSocket (for the client UI) and as a task_acknowledged event
    // (for Discord and other channels).
    if (needsExecution(classification.classification)) {
      const estimatedMs = classification.estimatedDurationMs || 30_000;
      const estimatedLabel = formatDuration(estimatedMs);
      const ackMessage = classification.acknowledgmentMessage
        || `Working on it — estimated time: ~${estimatedLabel}`;

      // WebSocket ack for client UI
      sendMessage(responseWs, {
        type: "response",
        id: `${message.id}_ack`,
        timestamp: Date.now(),
        payload: {
          success: true,
          response: ackMessage,
          classification: "CONVERSATIONAL" as const,
          threadIds: [],
          keyPoints: [],
        }
      });

      // Dedicated event for Discord/other channels — always fires for actionable tasks
      sendMessage(responseWs, {
        type: "task_acknowledged",
        id: `${message.id}_task_ack`,
        timestamp: Date.now(),
        payload: {
          prompt: prompt.substring(0, 200),
          classification: classification.classification,
          estimatedDurationMs: estimatedMs,
          estimatedLabel,
          acknowledgment: ackMessage,
        }
      });

      // Extend the message timeout — the ack proves the pipeline is alive.
      // Supervisor handles stuck agents after this point (1-3 min thresholds).
      tracker.extendTimeout(message.id, 600_000); // 10 minutes for agent tasks
    }

    // Execute V2 pipeline with precomputed classification to avoid calling receptionist twice
    tracker.updateStage(message.id, "agent_spawned");
    const result = await executeV2Pipeline(
      llm,
      v2Runner.options, // AgentRunnerOptions with all callbacks wired
      enhancedRequest,
      userId,
      `session_v2_${nanoid()}`,
      existingRouter,
      classification, // Pass precomputed decision to skip redundant receptionist call
      previousResult, // Pass previous orchestrator result for injection access
      // Eager registration: store the orchestrator result as soon as agents spawn,
      // so concurrent messages can find running agents and inject into them
      // instead of waiting for the pipeline to complete.
      (orchestratorResult) => {
        v2OrchestratorResults.set(userId, orchestratorResult);
        log.info("Orchestrator result registered eagerly", { userId, agents: orchestratorResult.router.getAgents().length });
      },
    );

    // Final store — updates the reference with completed response/success values
    if (result.orchestratorResult) {
      v2OrchestratorResults.set(userId, result.orchestratorResult);
    }

    // Check if multi-agent response (more than 1 completed agent)
    const completedAgents = result.agentResults?.filter(r => r.status === "completed") || [];
    const isMultiAgent = completedAgents.length > 1;

    sendMessage(responseWs, {
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

    // Mark response as delivered
    tracker.markResponseSent(message.id);
    return;
  } catch (error) {
    log.error("V2 pipeline error", { error });

    // Mark message as failed
    tracker.markFailed(message.id, error instanceof Error ? error.message : "Unknown error");

    sendMessage(responseWs, {
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
// HELPERS
// ============================================

/** Check if classification type requires agent execution */
function needsExecution(classification: string): boolean {
  return ["ACTION", "INFO_REQUEST", "CONTINUATION", "CORRECTION", "COMPOUND"].includes(classification);
}

/** Format milliseconds as a human-readable duration string */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

// ============================================
// SYSTEM COMMAND: FLUSH SESSION MEMORY
// ============================================

async function handleFlushMemory(
  device: { ws: import("ws").WebSocket; session: { userId: string } },
  message: WSPromptMessage,
  userId: string,
  tracker: ReturnType<typeof getMessageTracker>
): Promise<void> {
  log.info("Flush session memory triggered", { userId });
  const agentDeviceId = getDeviceForUser(userId);
  if (!agentDeviceId) {
    sendMessage(device.ws, {
      type: "response", id: message.id, timestamp: Date.now(),
      payload: { success: false, response: "No local agent connected — cannot flush memory.", classification: "CONVERSATIONAL" as const, threadIds: [], keyPoints: [] }
    });
    tracker.markResponseSent(message.id);
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
    tracker.markResponseSent(message.id);
  } catch (err) {
    tracker.markFailed(message.id, err instanceof Error ? err.message : String(err));
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
  userId: string,
  tracker: ReturnType<typeof getMessageTracker>
): Promise<void> {
  log.info("Clear conversation threads triggered", { userId });
  const agentDeviceId = getDeviceForUser(userId);
  if (!agentDeviceId) {
    sendMessage(device.ws, {
      type: "response", id: message.id, timestamp: Date.now(),
      payload: { success: false, response: "No local agent connected — cannot clear threads.", classification: "CONVERSATIONAL" as const, threadIds: [], keyPoints: [] }
    });
    tracker.markResponseSent(message.id);
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
    tracker.markResponseSent(message.id);
  } catch (err) {
    tracker.markFailed(message.id, err instanceof Error ? err.message : String(err));
    sendMessage(device.ws, {
      type: "response", id: message.id, timestamp: Date.now(),
      payload: { success: false, response: `Failed to clear threads: ${err instanceof Error ? err.message : err}`, classification: "CONVERSATIONAL" as const, threadIds: [], keyPoints: [] }
    });
  }
}
