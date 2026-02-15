/**
 * Workspace Recovery
 *
 * Finds and categorizes incomplete agent workspaces on device reconnect.
 * Used by ws/server.ts to offer task resumption.
 */

import { assertSafeAgentId, WORKSPACE_BASE } from "./types.js";
import type { WorkspaceCommand, TaskJson } from "./types.js";

/**
 * Generate the command to list workspace directories on the client.
 * The local agent executes this and returns the folder list.
 * The caller then checks each folder for task.json to find incomplete tasks.
 */
export function listWorkspaceFolders(): WorkspaceCommand {
  return {
    toolId: "directory.list",
    args: { path: WORKSPACE_BASE },
  };
}

/**
 * Generate the command to read a task.json from a specific agent workspace.
 */
export function readTaskJson(agentId: string): WorkspaceCommand {
  assertSafeAgentId(agentId);
  return {
    toolId: "filesystem.read_file",
    args: { path: `${WORKSPACE_BASE}/${agentId}/task.json` },
  };
}

/**
 * Given a list of TaskJson objects from incomplete workspaces,
 * categorize them for the resumption prompt.
 */
export function categorizeIncompleteTasks(tasks: TaskJson[]): {
  resumable: TaskJson[];
  failed: TaskJson[];
  blocked: TaskJson[];
} {
  const resumable: TaskJson[] = [];
  const failed: TaskJson[] = [];
  const blocked: TaskJson[] = [];

  for (const task of tasks) {
    if (task.status === "failed") {
      failed.push(task);
    } else if (task.status === "blocked") {
      blocked.push(task);
    } else {
      // running, paused, researching → all resumable
      resumable.push(task);
    }
  }

  return { resumable, failed, blocked };
}
