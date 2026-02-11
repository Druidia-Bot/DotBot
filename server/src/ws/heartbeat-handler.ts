/**
 * Heartbeat Request Handler
 * 
 * Handles heartbeat_request messages from the local agent.
 * The user's ~/.bot/HEARTBEAT.md is a prompt — its contents are injected
 * verbatim into the LLM call. The personal-assistant persona executes
 * those instructions with tool access (search, http, shell, filesystem).
 * 
 * If the persona determines nothing is urgent, it replies HEARTBEAT_OK.
 * Otherwise it returns a concise notification for the user.
 */

import { nanoid } from "nanoid";
import type { WSMessage, HeartbeatResult } from "../types.js";
import { createComponentLogger } from "../logging.js";
import { devices, sendMessage } from "./devices.js";
import { sendExecutionCommand, requestTools } from "./device-bridge.js";
import { getUserTasks, getDueTasks } from "../scheduler/index.js";

const log = createComponentLogger("ws.heartbeat");

const FALLBACK_ASSISTANT_PROMPT = `You are a personal assistant running a periodic heartbeat check.
Check for due reminders and urgent items. If nothing needs the user's attention, reply with exactly HEARTBEAT_OK.
If something is urgent, write a concise 2-3 sentence notification.`;

export async function handleHeartbeatRequest(
  deviceId: string,
  message: WSMessage,
  apiKey: string,
  serverProvider: string
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  const startTime = Date.now();

  try {
    const { selectModel, createClientForSelection } = await import("../llm/providers.js");
    const { getPersona } = await import("../personas/loader.js");
    const { runToolLoop } = await import("../agents/tool-loop.js");

    // Use personal-assistant persona with workhorse model (fast + cheap)
    const persona = getPersona("personal-assistant");
    const systemPrompt = persona?.systemPrompt || FALLBACK_ASSISTANT_PROMPT;

    const modelConfig = selectModel({ personaModelTier: "fast" });
    const llm = createClientForSelection(modelConfig);

    // Build context-enriched prompt (#6: context injection)
    const idleInfo = message.payload.idleDurationMs
      ? `\nSystem idle for: ${Math.round(message.payload.idleDurationMs / 60000)} minutes`
      : "";
    const failureInfo = message.payload.consecutiveFailures > 0
      ? `\nNote: ${message.payload.consecutiveFailures} previous heartbeat(s) failed — this is a recovery check.`
      : "";

    // #5: Scheduler integration — inject due/upcoming scheduled tasks
    const userId = device.session.userId;
    const { dueTasks, scheduledTasks } = fetchSchedulerData(userId);
    const scheduledTaskInfo = buildScheduledTaskSummary(dueTasks, scheduledTasks);

    const userMessage = `## Heartbeat Check — ${message.payload.currentTime}
Timezone: ${message.payload.timezone}${idleInfo}${failureInfo}
${scheduledTaskInfo}
${message.payload.checklist}

Run the checklist above. Reply HEARTBEAT_OK if nothing needs the user's attention right now.`;

    // Try to get tools for the persona (email, calendar, search access)
    let toolManifest: any[] = [];
    try {
      const toolResult = await requestTools(deviceId);
      if (toolResult?.tools?.length) {
        // Filter to tool categories the persona declares
        const allowedCategories = persona?.tools || ["search", "http", "shell", "filesystem"];
        toolManifest = toolResult.tools.filter(
          (t: any) => allowedCategories.includes("all") || allowedCategories.includes(t.category)
        );
      }
    } catch {
      log.debug("Could not fetch tools for heartbeat, falling back to LLM-only");
    }

    let responseContent: string;

    if (toolManifest.length > 0) {
      // Run with tool loop so the LLM can actually check email, calendar, etc.
      const result = await runToolLoop(
        llm,
        systemPrompt,
        userMessage,
        "personal-assistant",
        {
          model: modelConfig.model,
          maxTokens: 1024,
          temperature: 0.2,
        },
        {
          maxIterations: 3,
          executeCommand: (cmd) => sendExecutionCommand(deviceId, cmd),
          toolManifest,
        }
      );
      responseContent = result.response;
    } else {
      // Fallback: LLM-only (no tools available)
      const response = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          model: modelConfig.model,
          maxTokens: 1024,
          temperature: 0.2,
        }
      );
      responseContent = response.content;
    }

    // Build structured result (#11: structured response format)
    const isOk = responseContent.includes("HEARTBEAT_OK");
    const taskCounts = getScheduledTaskCounts(dueTasks, scheduledTasks);
    const result: HeartbeatResult = {
      status: isOk ? "ok" : "alert",
      content: isOk
        ? responseContent.replace("HEARTBEAT_OK", "").trim() || "nothing to report"
        : responseContent,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      model: modelConfig.model,
      toolsAvailable: toolManifest.length > 0,
      scheduledTasks: taskCounts.total > 0 ? taskCounts : undefined,
    };

    sendMessage(device.ws, {
      type: "heartbeat_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        result,
      },
    });

    log.debug("Heartbeat response sent", {
      status: result.status,
      durationMs: result.durationMs,
      model: result.model,
    });
  } catch (error) {
    log.error("Heartbeat request failed", { error });

    const errorResult: HeartbeatResult = {
      status: "error",
      content: error instanceof Error ? error.message : "Unknown error",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      model: "none",
      toolsAvailable: false,
    };

    sendMessage(device.ws, {
      type: "heartbeat_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        result: errorResult,
      },
    });
  }
}

// ============================================
// SCHEDULER INTEGRATION (#5)
// ============================================

export interface ScheduledTaskCounts {
  due: number;
  upcoming: number;
  total: number;
}

/**
 * Fetch scheduler data once per heartbeat (avoids duplicate DB queries).
 */
function fetchSchedulerData(userId: string): { dueTasks: any[]; scheduledTasks: any[] } {
  try {
    const dueTasks = getDueTasks().filter(t => t.userId === userId);
    const scheduledTasks = getUserTasks(userId, "scheduled");
    return { dueTasks, scheduledTasks };
  } catch (error) {
    log.debug("Could not fetch scheduled tasks for heartbeat", { error });
    return { dueTasks: [], scheduledTasks: [] };
  }
}

/**
 * Build a text summary of the user's scheduled tasks for injection into the LLM prompt.
 * Returns an empty string if no tasks exist (keeps prompt clean).
 */
function buildScheduledTaskSummary(dueTasks: any[], scheduledTasks: any[]): string {
  // Nothing to report
  if (dueTasks.length === 0 && scheduledTasks.length === 0) return "";

  const lines: string[] = ["\n## Scheduled Tasks"];

  if (dueTasks.length > 0) {
    lines.push(`**${dueTasks.length} task(s) are NOW DUE:**`);
    for (const task of dueTasks.slice(0, 5)) {
      const age = Math.round((Date.now() - task.scheduledFor.getTime()) / 60000);
      lines.push(`- [${task.priority}] "${task.originalPrompt.substring(0, 80)}" — due ${age > 0 ? `${age}m ago` : "now"} (by ${task.deferredBy})`);
    }
    if (dueTasks.length > 5) {
      lines.push(`  ...and ${dueTasks.length - 5} more`);
    }
  }

  // Show upcoming tasks within the next hour (not yet due)
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
  const upcoming = scheduledTasks.filter(
    t => t.scheduledFor > new Date() && t.scheduledFor <= oneHourFromNow
  );
  if (upcoming.length > 0) {
    lines.push(`\n**${upcoming.length} task(s) coming up in the next hour:**`);
    for (const task of upcoming.slice(0, 3)) {
      const minsUntil = Math.round((task.scheduledFor.getTime() - Date.now()) / 60000);
      lines.push(`- [${task.priority}] "${task.originalPrompt.substring(0, 80)}" — in ${minsUntil}m`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Get task counts for the HeartbeatResult payload.
 */
function getScheduledTaskCounts(dueTasks: any[], scheduledTasks: any[]): ScheduledTaskCounts {
  return {
    due: dueTasks.length,
    upcoming: scheduledTasks.length - dueTasks.length,
    total: scheduledTasks.length,
  };
}
