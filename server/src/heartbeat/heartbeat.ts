/**
 * Heartbeat — Core Business Logic
 *
 * Runs the heartbeat check: loads persona, builds context-enriched prompt,
 * calls LLM (with or without tools), and returns a structured HeartbeatResult.
 *
 * No WS transport concerns — called by the thin handler in ws/heartbeat-handler.ts.
 * Same pattern as pipeline/pipeline.ts (business logic) vs ws/prompt-handler.ts (transport).
 */

import { createComponentLogger } from "../logging.js";
import { requestTools } from "../ws/device-bridge.js";
import {
  fetchSchedulerData,
  buildScheduledTaskSummary,
  getScheduledTaskCounts,
} from "./scheduler.js";
import type { HeartbeatResult } from "../types.js";

const log = createComponentLogger("heartbeat");

// ============================================
// TYPES
// ============================================

export interface HeartbeatInput {
  deviceId: string;
  userId: string;
  checklist: string;
  currentTime: string;
  timezone: string;
  idleDurationMs?: number;
  consecutiveFailures?: number;
}

// ============================================
// CONSTANTS
// ============================================

const FALLBACK_ASSISTANT_PROMPT = `You are a personal assistant running a periodic heartbeat check.
Check for due reminders and urgent items. If nothing needs the user's attention, reply with exactly HEARTBEAT_OK.
If something is urgent, write a concise 2-3 sentence notification.`;

// ============================================
// MAIN ENTRY
// ============================================

/**
 * Run the heartbeat check. Returns a structured HeartbeatResult.
 * Handles both tool-enabled and LLM-only paths.
 */
export async function runHeartbeat(input: HeartbeatInput): Promise<HeartbeatResult> {
  const {
    deviceId, userId, checklist, currentTime, timezone,
    idleDurationMs, consecutiveFailures,
  } = input;

  const startTime = Date.now();

  const { selectModel, createClientForSelection } = await import(
    "../llm/providers.js"
  );
  const { getPersona } = await import("../personas/loader.js");
  const { runToolLoop, buildProxyHandlers } = await import("../tool-loop/index.js");
  const { manifestToNativeTools } = await import("../agents/tools.js");

  // Use personal-assistant persona with workhorse model (fast + cheap)
  const persona = getPersona("personal-assistant");
  const systemPrompt = persona?.systemPrompt || FALLBACK_ASSISTANT_PROMPT;

  const modelConfig = selectModel({ personaModelTier: "fast" });
  const llm = createClientForSelection(modelConfig);

  // Build context-enriched prompt
  const idleInfo = idleDurationMs
    ? `\nSystem idle for: ${Math.round(idleDurationMs / 60000)} minutes`
    : "";
  const failureInfo =
    consecutiveFailures && consecutiveFailures > 0
      ? `\nNote: ${consecutiveFailures} previous heartbeat(s) failed — this is a recovery check.`
      : "";

  // Scheduler integration — inject due/upcoming scheduled tasks
  const { dueTasks, scheduledTasks } = fetchSchedulerData(userId);
  const scheduledTaskInfo = buildScheduledTaskSummary(dueTasks, scheduledTasks);

  const userMessage = `## Heartbeat Check — ${currentTime}
Timezone: ${timezone}${idleInfo}${failureInfo}
${scheduledTaskInfo}
${checklist}

Run the checklist above. If nothing needs the user's attention, reply with exactly HEARTBEAT_OK.`;

  // Try to get tools for the persona (email, calendar, search access)
  let toolManifest: any[] = [];
  try {
    const toolResult = await requestTools(deviceId);
    if (toolResult?.tools?.length) {
      const allowedCategories = persona?.tools || [
        "search",
        "http",
        "shell",
        "filesystem",
      ];
      toolManifest = toolResult.tools.filter(
        (t: any) =>
          allowedCategories.includes("all") ||
          allowedCategories.includes(t.category),
      );
    }
  } catch {
    log.debug("Could not fetch tools for heartbeat, falling back to LLM-only");
  }

  let responseContent: string;

  if (toolManifest.length > 0) {
    // Run with clean tool loop + proxy handlers
    const handlers = buildProxyHandlers(toolManifest);
    const nativeTools = manifestToNativeTools(toolManifest) || [];
    const result = await runToolLoop({
      client: llm,
      model: modelConfig.model,
      maxTokens: 1024,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      tools: nativeTools,
      handlers,
      maxIterations: 3,
      context: { deviceId, state: {} },
      personaId: "personal-assistant",
    });
    responseContent = result.finalContent;
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
      },
    );
    responseContent = response.content;
  }

  // Build structured result
  const isOk = responseContent.includes("HEARTBEAT_OK");
  const taskCounts = getScheduledTaskCounts(dueTasks, scheduledTasks);

  return {
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
}
