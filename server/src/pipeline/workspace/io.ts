/**
 * Workspace I/O — Low-Level File Operations
 *
 * Single source of truth for reading/writing files in agent workspaces.
 * All operations go through the local agent via sendExecutionCommand.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { sendExecutionCommand } from "#ws/device-bridge.js";

const log = createComponentLogger("workspace.io");

/**
 * Read a file from an agent's workspace via the local agent.
 * Returns the raw string content. Throws on failure.
 */
export async function readWorkspaceFile(
  deviceId: string,
  filePath: string,
  timeoutMs = 5_000,
): Promise<string> {
  return sendExecutionCommand(deviceId, {
    id: `ws_read_${nanoid(6)}`,
    type: "tool_execute",
    payload: {
      toolId: "filesystem.read_file",
      toolArgs: { path: filePath },
    },
    dryRun: false,
    timeout: timeoutMs,
    sandboxed: false,
    requiresApproval: false,
  });
}

/**
 * Write a file to an agent's workspace via the local agent.
 * Creates or overwrites the file. Throws on failure.
 */
export async function writeWorkspaceFile(
  deviceId: string,
  filePath: string,
  content: string,
  timeoutMs = 5_000,
): Promise<void> {
  await sendExecutionCommand(deviceId, {
    id: `ws_write_${nanoid(6)}`,
    type: "tool_execute",
    payload: {
      toolId: "filesystem.create_file",
      toolArgs: { path: filePath, content },
    },
    dryRun: false,
    timeout: timeoutMs,
    sandboxed: false,
    requiresApproval: false,
  });
}

/**
 * List entries in a directory via the local agent.
 * Returns parsed array of entry names. Throws on failure.
 */
export async function listWorkspaceDir(
  deviceId: string,
  dirPath: string,
  timeoutMs = 10_000,
): Promise<string[]> {
  const raw = await sendExecutionCommand(deviceId, {
    id: `ws_ls_${nanoid(6)}`,
    type: "tool_execute",
    payload: {
      toolId: "directory.list",
      toolArgs: { path: dirPath },
    },
    dryRun: false,
    timeout: timeoutMs,
    sandboxed: false,
    requiresApproval: false,
  });

  try {
    return JSON.parse(raw);
  } catch {
    return raw.split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 0);
  }
}
