/**
 * Heartbeat — Prompt Builder
 *
 * Assembles the LLM user message from checklist, idle/failure context,
 * and scheduled task summaries. Uses heartbeat.md template with |* Field *| placeholders.
 */

import { loadPrompt } from "../../prompt-template.js";
import {
  fetchSchedulerData,
  buildScheduledTaskSummary,
} from "./scheduler.js";

export interface PromptContext {
  checklist: string;
  currentTime: string;
  timezone: string;
  idleDurationMs?: number;
  consecutiveFailures?: number;
  userId: string;
}

export interface BuiltPrompt {
  userMessage: string;
  dueTasks: any[];
  scheduledTasks: any[];
}

/**
 * Build the heartbeat user message and return scheduler data alongside it.
 */
export async function buildHeartbeatPrompt(ctx: PromptContext): Promise<BuiltPrompt> {
  const idleInfo = ctx.idleDurationMs
    ? `\nSystem idle for: ${Math.round(ctx.idleDurationMs / 60000)} minutes`
    : "";
  const failureInfo =
    ctx.consecutiveFailures && ctx.consecutiveFailures > 0
      ? `\nNote: ${ctx.consecutiveFailures} previous heartbeat(s) failed — this is a recovery check.`
      : "";

  const { dueTasks, scheduledTasks, recurringProblems } = fetchSchedulerData(ctx.userId);
  const scheduledTaskInfo = buildScheduledTaskSummary(dueTasks, scheduledTasks, recurringProblems);

  const userMessage = await loadPrompt("services/heartbeat/heartbeat.md", {
    CurrentTime: ctx.currentTime,
    Timezone: ctx.timezone,
    IdleInfo: idleInfo,
    FailureInfo: failureInfo,
    ScheduledTasks: scheduledTaskInfo,
    Checklist: ctx.checklist,
  });

  return { userMessage, dueTasks, scheduledTasks };
}
