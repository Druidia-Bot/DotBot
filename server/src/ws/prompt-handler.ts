/**
 * Prompt Handler — WebSocket Layer
 *
 * Handles WebSocket message routing for user prompts:
 * - System commands (flush memory, clear threads)
 * - Delegates to the pipeline for all other messages
 * - Sends acks, responses, and error messages over WebSocket
 *
 * Business logic lives in pipeline/pipeline.ts.
 */

import { nanoid } from "nanoid";
import type { WSPromptMessage } from "../types.js";
import { createComponentLogger } from "#logging.js";
import {
  devices,
  sendMessage,
  getDeviceForUser,
} from "./devices.js";
import { sendMemoryRequest, sendRunLog, sendSaveToThread } from "./device-bridge.js";
import { runDot } from "../dot/dot.js";

const log = createComponentLogger("ws.prompt");

export function cleanupUserSession(_userId: string): void {
  // no-op — reserved for future session cleanup
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

  // ── System commands ──
  const normalizedPrompt = prompt.toLowerCase().trim();
  if (normalizedPrompt === "flush session memory" || normalizedPrompt === "flush memory" || normalizedPrompt === "clear session memory") {
    await handleFlushMemory(device, message, userId);
    return;
  }
  if (normalizedPrompt === "clear conversation history" || normalizedPrompt === "clear threads" || normalizedPrompt === "clear thread memory" || normalizedPrompt === "flush threads" || normalizedPrompt === "flush thread memory") {
    await handleClearThreads(device, message, userId);
    return;
  }

  // ── Dot (root-level conversational assistant) ──
  const source = message.payload?.source || "unknown";

  // Save user message to thread before processing
  sendSaveToThread(userId, "conversation", {
    role: "user",
    content: prompt,
    source,
    messageId: message.id,
  }, "Conversation");

  try {
    const { createClientForSelection } = await import("#llm/factory.js");
    const { selectModel } = await import("#llm/selection/model-selector.js");
    const modelConfig = selectModel({ explicitRole: "assistant" });
    const llm = createClientForSelection(modelConfig, deviceId);

    const dotResult = await runDot({
      llm,
      userId,
      deviceId,
      prompt,
      messageId: message.id,
      source,
    });

    const threadId = dotResult.threadId;

    // Save Dot's response to thread
    sendSaveToThread(userId, threadId, {
      role: "assistant",
      content: dotResult.response,
      source: "dot",
      messageId: message.id,
      dispatched: dotResult.dispatched,
    });

    sendMessage(responseWs, {
      type: "response",
      id: message.id,
      timestamp: Date.now(),
      payload: {
        success: dotResult.dispatch?.success ?? true,
        response: dotResult.response,
        classification: "CONVERSATIONAL",
        threadIds: [threadId],
        keyPoints: [],
      }
    });

    return;
  } catch (error) {
    log.error("Dot error", { error });

    // Persist error to client run-logs so we can diagnose without server console
    sendRunLog(userId, {
      stage: "error",
      messageId: message.id,
      prompt: prompt.slice(0, 500),
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      timestamp: new Date().toISOString(),
    });

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
// SYSTEM COMMAND: FLUSH SESSION MEMORY
// ============================================

async function handleFlushMemory(
  device: { ws: import("ws").WebSocket; session: { userId: string } },
  message: WSPromptMessage,
  userId: string,
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
  userId: string,
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
