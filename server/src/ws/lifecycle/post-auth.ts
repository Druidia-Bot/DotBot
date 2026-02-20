/**
 * Post-Authentication Tasks
 *
 * Background tasks that run after a device successfully authenticates:
 * - Scan for incomplete agent workspaces from previous sessions
 * - Notify user about recurring tasks that ran while offline
 */

import { nanoid } from "nanoid";
import { broadcastToUser } from "../devices.js";
import { sendExecutionCommand } from "../bridge/commands.js";
import {
  listWorkspaceFolders,
  readTaskJson,
  categorizeIncompleteTasks,
  cleanupWorkspace,
  type TaskJson,
} from "#pipeline/workspace/index.js";
import { getOfflineResults } from "../../services/scheduler/index.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("ws.post-auth");

// ============================================
// WORKSPACE SCANNER
// ============================================

/**
 * Scan client's agent-workspaces/ for incomplete task.json files.
 * Runs after auth — notifies the user of any resumable/failed tasks.
 * Silently does nothing if workspace folder doesn't exist.
 */
export async function checkIncompleteWorkspaces(deviceId: string, userId: string): Promise<void> {
  try {
    const listCmd = listWorkspaceFolders();
    const listResult = await sendExecutionCommand(deviceId, {
      id: `resume_list_${nanoid(8)}`,
      type: "tool_execute",
      payload: { toolId: listCmd.toolId, toolArgs: listCmd.args },
      dryRun: false, timeout: 5000, sandboxed: false, requiresApproval: false,
    });

    let folders: string[];
    try {
      folders = JSON.parse(listResult);
      if (!Array.isArray(folders)) return;
    } catch {
      // directory.list returns lines like "[DIR]  agent_xxx" — extract just the name
      folders = listResult.split("\n")
        .map(s => s.trim())
        .filter(s => s.startsWith("[DIR]"))
        .map(s => s.replace(/^\[DIR]\s+/, ""));
    }
    if (folders.length === 0) return;

    // Read task.json from each workspace folder
    const tasks: TaskJson[] = [];
    for (const folder of folders) {
      try {
        const readCmd = readTaskJson(folder);
        const readResult = await sendExecutionCommand(deviceId, {
          id: `resume_read_${nanoid(8)}`,
          type: "tool_execute",
          payload: { toolId: readCmd.toolId, toolArgs: readCmd.args },
          dryRun: false, timeout: 5000, sandboxed: false, requiresApproval: false,
        });
        const taskData = JSON.parse(readResult) as TaskJson;
        tasks.push(taskData);
      } catch {
        // No task.json = completed task, clean up old workspace folder
        const cleanCmd = cleanupWorkspace(folder);
        sendExecutionCommand(deviceId, {
          id: `resume_clean_${nanoid(8)}`,
          type: "tool_execute",
          payload: { toolId: cleanCmd.toolId, toolArgs: cleanCmd.args },
          dryRun: false, timeout: 5000, sandboxed: false, requiresApproval: false,
        }).catch(() => {});
      }
    }

    if (tasks.length === 0) return;

    const { resumable, failed, blocked } = categorizeIncompleteTasks(tasks);

    const parts: string[] = [];
    if (resumable.length > 0) {
      parts.push(`**${resumable.length} paused task${resumable.length > 1 ? "s" : ""}:** ${resumable.map(t => t.topic).join(", ")}`);
    }
    if (blocked.length > 0) {
      parts.push(`**${blocked.length} blocked task${blocked.length > 1 ? "s" : ""}:** ${blocked.map(t => t.topic).join(", ")}`);
    }
    if (failed.length > 0) {
      parts.push(`**${failed.length} failed task${failed.length > 1 ? "s" : ""}:** ${failed.map(t => `${t.topic} (${t.failureReason?.substring(0, 80) || "unknown error"})`).join(", ")}`);
    }

    if (parts.length > 0) {
      broadcastToUser(userId, {
        type: "response",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          success: true,
          response: `I found incomplete agent tasks from a previous session:\n\n${parts.join("\n")}\n\nYou can ask me to resume or discard them.`,
          classification: "CONVERSATIONAL",
          threadIds: [],
          keyPoints: [],
        }
      });
    }

    log.info("Incomplete workspace scan complete", {
      resumable: resumable.length,
      failed: failed.length,
      blocked: blocked.length,
    });
  } catch (error) {
    log.debug("Workspace scan skipped (no workspaces or local-agent not ready)", { error });
  }
}

// ============================================
// OFFLINE RECURRING RESULTS
// ============================================

/**
 * Notify user about recurring tasks that ran while their device was offline.
 */
export async function notifyOfflineRecurringResults(userId: string, connectedAt: Date): Promise<void> {
  try {
    const offlineResults = getOfflineResults(userId, connectedAt);
    if (offlineResults.length === 0) return;

    const summary = offlineResults.map(t => {
      const status = t.lastError ? `failed: ${t.lastError.substring(0, 100)}` : "completed";
      const result = t.lastResult ? t.lastResult.substring(0, 200) : "";
      return `- **${t.name}** (${status})${result ? `: ${result}...` : ""}`;
    }).join("\n");

    broadcastToUser(userId, {
      type: "response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        success: true,
        response: `While you were away, ${offlineResults.length} scheduled task${offlineResults.length > 1 ? "s" : ""} ran:\n\n${summary}\n\nUse \`schedule.list\` to see full details.`,
        classification: "CONVERSATIONAL",
        threadIds: [],
        keyPoints: [],
      },
    });

    log.info("Notified user of offline recurring results", { userId, count: offlineResults.length });
  } catch (error) {
    log.debug("Offline recurring results check skipped", { error });
  }
}
