/**
 * Heartbeat — Result Parser
 *
 * Parses the raw LLM response into a structured HeartbeatResult.
 * Detects HEARTBEAT_OK, strips it from content, and sets status.
 */

import type { HeartbeatResult } from "../../types.js";
import { getScheduledTaskCounts } from "./scheduler.js";

/**
 * Parse the LLM response content into a HeartbeatResult.
 */
export function buildHeartbeatResult(
  responseContent: string,
  dueTasks: any[],
  scheduledTasks: any[],
  startTime: number,
  model: string,
  toolsAvailable: boolean,
): HeartbeatResult {
  const isOk = responseContent.includes("HEARTBEAT_OK");
  const taskCounts = getScheduledTaskCounts(dueTasks, scheduledTasks);

  return {
    status: isOk ? "ok" : "alert",
    content: isOk
      ? responseContent.replace("HEARTBEAT_OK", "").trim() || "nothing to report"
      : responseContent,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    model,
    toolsAvailable,
    scheduledTasks: taskCounts.total > 0 ? taskCounts : undefined,
  };
}
