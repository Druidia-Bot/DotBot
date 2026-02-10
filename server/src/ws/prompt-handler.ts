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
  sendError,
  getDeviceForUser,
} from "./devices.js";
import {
  sendMemoryRequest,
} from "./device-bridge.js";
import {
  hasActiveTask,
  routeInjection,
  injectMessageToTask,
  spawnTask,
  activeTaskCount,
  getActiveTasksForDevice,
  getBlockedTasksForDevice,
  getTaskById,
  cancelAllTasksForDevice,
  resumeBlockedTask,
} from "../agents/agent-tasks.js";
import { buildRequestContext } from "./context-builder.js";
import { createRunner, sendAgentWork, sendRunLog } from "./runner-factory.js";

const log = createComponentLogger("ws.prompt");

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

  // ── Check for active or blocked agent loops — route injection if any exist ──
  if (hasActiveTask(deviceId) || getBlockedTasksForDevice(deviceId).length > 0) {
    const route = await routeInjection(deviceId, prompt);

    // Status query — respond with task status from the server, don't inject
    if (route.method === "status_query") {
      const allTasks = getActiveTasksForDevice(deviceId);
      const blockedTasks = getBlockedTasksForDevice(deviceId);
      const fmtElapsed = (t: { startedAt: number }) => {
        const s = Math.round((Date.now() - t.startedAt) / 1000);
        return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
      };
      const taskSummaries = allTasks.map(task => {
        const recentActions = task.recentActivity.slice(-3);
        const activityStr = recentActions.length > 0
          ? `\n${recentActions.map(a => `  - ${a}`).join("\n")}`
          : "\n  _No tool activity yet_";
        return `**${task.name}** (${task.personaId}) — ${fmtElapsed(task)}${activityStr}`;
      });
      for (const task of blockedTasks) {
        const reason = task.waitReason || "waiting for your response";
        taskSummaries.push(`⏸️ **${task.name}** (${task.personaId}) — ${fmtElapsed(task)} — **Waiting:** ${reason}`);
      }

      log.info(`Status query`, { taskCount: allTasks.length, blockedCount: blockedTasks.length });

      sendMessage(device.ws, {
        type: "response",
        id: message.id,
        timestamp: Date.now(),
        payload: {
          success: true,
          response: taskSummaries.join("\n\n"),
          classification: "CONVERSATIONAL" as const,
          threadIds: [],
          keyPoints: [],
          isRoutingAck: true,
        }
      });
      return;
    }

    // Blocked task resume — the task was waiting for user input
    if (route.task && route.method === "blocked_resume") {
      const resumed = resumeBlockedTask(route.task.id, prompt);
      if (resumed) {
        log.info(`Resumed blocked task with user response`, {
          taskId: route.task.id,
          taskName: route.task.name,
          personaId: route.task.personaId,
        });

        sendMessage(device.ws, {
          type: "response",
          id: message.id,
          timestamp: Date.now(),
          payload: {
            success: true,
            response: `Got it — resuming **${route.task.name}** (${route.task.personaId}) with your response.`,
            classification: "CONVERSATIONAL" as const,
            threadIds: [],
            keyPoints: [],
            isRoutingAck: true,
          }
        });
        return;
      }
    }

    // Running task injection
    if (route.task && route.method !== "none" && route.method !== "blocked_resume") {
      const injected = injectMessageToTask(route.task.id, prompt);
      if (injected) {
        const taskCount = activeTaskCount(deviceId);
        const routeNote = route.method === "name_match" ? " (matched by name)" : "";

        log.info(`Injected user correction into agent loop`, {
          taskId: route.task.id,
          taskName: route.task.name,
          personaId: route.task.personaId,
          method: route.method,
          activeTasks: taskCount,
        });

        const taskLabel = `**${route.task.name}** (${route.task.personaId})`;
        const countNote = taskCount > 1 ? `\n\n_${taskCount} tasks running — mention a task name to target a specific one._` : "";

        sendMessage(device.ws, {
          type: "response",
          id: message.id,
          timestamp: Date.now(),
          payload: {
            success: true,
            response: `Got it — forwarded your update to ${taskLabel}${routeNote}. They'll pick it up on their next step.${countNote}`,
            classification: "CONVERSATIONAL" as const,
            threadIds: [],
            keyPoints: [],
            isRoutingAck: true,
          }
        });
        return;
      }
    }
    // If routing returned no task or injection failed, fall through to normal processing
  }

  // ── Build context (same as before) ──
  const { enhancedRequest, toolManifest, runtimeInfo, agentConnected } = await buildRequestContext(
    deviceId, userId, prompt
  );

  // Pass through local LLM hints (if present)
  if (message.payload.hints) {
    enhancedRequest.hints = message.payload.hints;
  }

  // Warn the user if the local agent is disconnected — they'll have no history, no tools, no memory
  if (!agentConnected) {
    log.warn("Processing prompt without local-agent — no history, tools, or memory available", { userId });
    sendMessage(device.ws, {
      type: "response",
      id: `${message.id}_warn`,
      timestamp: Date.now(),
      payload: {
        success: true,
        response: "⚠️ **Local agent is not connected.** I won't have conversation history, memory, or tool access for this request. Please check that your local agent is running.",
        classification: "CONVERSATIONAL" as const,
        threadIds: [],
        keyPoints: [],
      }
    });
  }

  // ── Create the runner ──
  const runner = createRunner(apiKey, userId, device, toolManifest, runtimeInfo, serverProvider);

  try {
    // ── Phase 1: Quick classification via receptionist (~1-2s) ──
    const decision = await runner.classify(enhancedRequest, userId);

    log.info("Orchestrator classification", {
      classification: decision.classification,
      persona: decision.personaId,
      directResponse: !!decision.directResponse,
    });

    // ── Phase 2: Decide — inline or background agent loop ──
    const isActionable = ["ACTION", "COMPOUND", "INFO_REQUEST", "CONTINUATION", "CORRECTION"].includes(decision.classification);

    // CANCELLATION — actually cancel running tasks, don't just talk about it
    if (decision.classification === "CANCELLATION") {
      const cancelled = cancelAllTasksForDevice(deviceId);
      log.info(`CANCELLATION: aborted ${cancelled} task(s)`, { deviceId });
      const response = cancelled > 0
        ? `Stopping all tasks now. Cancelled ${cancelled} running task${cancelled > 1 ? "s" : ""}.`
        : "No tasks are currently running.";
      sendMessage(device.ws, {
        type: "response",
        id: message.id,
        timestamp: Date.now(),
        payload: {
          success: true,
          response,
          classification: "CANCELLATION" as const,
          threadIds: [],
          keyPoints: [],
        }
      });
      return;
    }

    if (decision.directResponse || !isActionable) {
      // INLINE PATH — fast, no tool loop needed
      // Use runWithDecision so the receptionist isn't called twice
      const result = await runner.runWithDecision(enhancedRequest, userId, decision);

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
        }
      });

      sendRunLog(device, message.id, enhancedRequest, result);
      return;
    }

    // ── BACKGROUND PATH — spawn agent loop, respond immediately ──
    const personaId = decision.personaId || "senior-dev";

    // Derive a short task name from the formatted request or prompt
    const taskName = (decision.formattedRequest || prompt).substring(0, 60).replace(/\n/g, " ").trim();
    const taskDescription = (decision.formattedRequest || prompt).substring(0, 200);

    // Spawn the background agent loop
    const task = spawnTask(
      deviceId, userId, prompt, personaId,
      taskName, taskDescription,
      async (injectionQueue: string[], agentTaskId: string, abortSignal: AbortSignal) => {
        // Create a scoped runner that tags all progress with this agent's task ID
        const agentRunner = createRunner(apiKey, userId, device, toolManifest, runtimeInfo, serverProvider, agentTaskId);

        // Persist work thread start to local agent for crash recovery
        sendAgentWork(userId, agentTaskId, "started", {
          personaId, taskName, prompt: prompt.substring(0, 500),
          startedAt: Date.now(),
        });

        // Getter closure — returns the CURRENT signal from the task's (possibly replaced) AbortController.
        // The watchdog may replace the controller after a Phase 2 abort, so we look up the task each time.
        const getAbortSignal = () => {
          const t = getTaskById(agentTaskId);
          return t?.abortController.signal;
        };

        const result = await agentRunner.runWithDecision(enhancedRequest, userId, decision, injectionQueue, getAbortSignal);

        // Persist completion
        sendAgentWork(userId, agentTaskId, "completed", {
          success: result.success,
          classification: result.classification,
          responseLength: result.response?.length || 0,
          threadIds: result.threadIds,
        });

        return result;
      }
    );

    // Notify client that an agent loop was started
    sendMessage(device.ws, {
      type: "agent_started",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        taskId: task.id,
        taskName: task.name,
        personaId,
        prompt: prompt.substring(0, 200),
      }
    });

    // Send immediate acknowledgment so the user knows we're on it
    const taskCountMsg = activeTaskCount(deviceId) > 1
      ? ` You now have ${activeTaskCount(deviceId)} tasks running.`
      : "";
    sendMessage(device.ws, {
      type: "response",
      id: message.id,
      timestamp: Date.now(),
      payload: {
        success: true,
        response: `I've started **${personaId}** on "**${task.name}**". I'll stream progress as work happens — feel free to send corrections or ask me anything else while that runs.${taskCountMsg}`,
        classification: decision.classification,
        threadIds: [],
        keyPoints: [],
        agentTaskId: task.id,
      }
    });

    // When the background task completes, send the result
    // (but NOT if it was cancelled — user already received the cancellation ack)
    task.promise.then((result) => {
      const taskState = getTaskById(task.id);
      if (taskState?.status === "cancelled") {
        log.info(`Suppressed agent_complete for cancelled task`, { taskId: task.id, personaId });
        return;
      }

      log.info(`Background agent task completed`, { taskId: task.id, personaId });

      sendMessage(device.ws, {
        type: "agent_complete",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          taskId: task.id,
          success: result.success,
          response: `**[${personaId}]** ${result.response}`,
          classification: result.classification,
          threadIds: result.threadIds,
          keyPoints: result.keyPoints,
        }
      });

      sendRunLog(device, message.id, enhancedRequest, result);
    }).catch((error) => {
      const taskState = getTaskById(task.id);
      if (taskState?.status === "cancelled") {
        log.info(`Suppressed agent_complete error for cancelled task`, { taskId: task.id, personaId });
        return;
      }

      log.error(`Background agent task failed`, { taskId: task.id, error });

      sendMessage(device.ws, {
        type: "agent_complete",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          taskId: task.id,
          success: false,
          response: `The agent task encountered an error: ${error instanceof Error ? error.message : "Unknown error"}`,
          classification: decision.classification,
          threadIds: [],
          keyPoints: [],
        }
      });
    });

  } catch (error) {
    log.error("Orchestrator error", { error });
    sendError(device.ws, error instanceof Error ? error.message : "Unknown error");
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
