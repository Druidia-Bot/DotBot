/**
 * Workspace I/O — Shared Helpers for Agent Workspace File Operations
 *
 * All agent workspace file reads/writes go through the local agent via
 * sendExecutionCommand. This module extracts the common boilerplate so
 * callers only specify path + content.
 *
 * Also provides higher-level persona mutation helpers (read-modify-write)
 * used by pipeline.ts, step-executor.ts, and agent-recovery.ts.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../logging.js";
import { sendExecutionCommand } from "../ws/device-bridge.js";

const log = createComponentLogger("workspace-io");

// ============================================
// LOW-LEVEL FILE I/O
// ============================================

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

// ============================================
// PERSONA READ-MODIFY-WRITE
// ============================================

/**
 * Read agent_persona.json from a workspace. Returns null on failure.
 */
export async function readPersonaJson(
  deviceId: string,
  workspacePath: string,
): Promise<Record<string, any> | null> {
  try {
    const raw = await readWorkspaceFile(deviceId, `${workspacePath}/agent_persona.json`);
    return JSON.parse(raw);
  } catch (err) {
    log.warn("Failed to read agent_persona.json", { workspacePath, error: err });
    return null;
  }
}

/**
 * Write agent_persona.json to a workspace. Throws on failure.
 */
export async function writePersonaJson(
  deviceId: string,
  workspacePath: string,
  persona: Record<string, any>,
): Promise<void> {
  await writeWorkspaceFile(
    deviceId,
    `${workspacePath}/agent_persona.json`,
    JSON.stringify(persona, null, 2),
  );
}

/**
 * Read-modify-write agent_persona.json. The mutator receives the parsed
 * persona and should modify it in place. Returns true if successful.
 */
export async function mutatePersonaJson(
  deviceId: string,
  workspacePath: string,
  mutator: (persona: Record<string, any>) => void,
): Promise<boolean> {
  const persona = await readPersonaJson(deviceId, workspacePath);
  if (!persona) return false;

  mutator(persona);

  try {
    await writePersonaJson(deviceId, workspacePath, persona);
    return true;
  } catch (err) {
    log.warn("Failed to write mutated agent_persona.json", { workspacePath, error: err });
    return false;
  }
}

// ============================================
// PLAN.JSON READER
// ============================================

export interface PlanProgress {
  approach?: string;
  steps: Array<{
    id: string;
    title: string;
    description: string;
    expectedOutput: string;
    toolHints: string[];
    requiresExternalData: boolean;
  }>;
  progress: {
    completedStepIds: string[];
    remainingStepIds: string[];
    currentStepId?: string;
    currentStepToolCalls?: Array<{
      toolId: string;
      timestamp: string;
      success: boolean;
      resultSnippet: string;
      outputPath?: string;
    }>;
    completedAt?: string;
    failedAt?: string;
    stoppedAt?: string;
  };
  isSimpleTask: boolean;
}

/**
 * Read plan.json from a workspace. Returns null on failure.
 */
export async function readPlanJson(
  deviceId: string,
  workspacePath: string,
): Promise<PlanProgress | null> {
  try {
    const raw = await readWorkspaceFile(deviceId, `${workspacePath}/plan.json`);
    return JSON.parse(raw) as PlanProgress;
  } catch (err) {
    log.warn("Failed to read plan.json", { workspacePath, error: err });
    return null;
  }
}

// ============================================
// PERSONA MUTATION HELPERS
// ============================================

/**
 * Persist a queue entry to agent_persona.json on disk.
 * Reads the file, appends to queue[], writes back.
 */
export async function persistQueueEntry(
  deviceId: string,
  workspacePath: string,
  entry: { id: string; request: string; addedAt: string },
): Promise<void> {
  await mutatePersonaJson(deviceId, workspacePath, (persona) => {
    if (!Array.isArray(persona.queue)) persona.queue = [];
    persona.queue.push(entry);
  });
}

/**
 * Append new requests to restatedRequests[] in agent_persona.json.
 * Called when MODIFY signals are drained from the signal queue.
 */
export async function appendToPersonaRequests(
  deviceId: string,
  workspacePath: string,
  newRequests: string[],
): Promise<void> {
  await mutatePersonaJson(deviceId, workspacePath, (persona) => {
    if (!Array.isArray(persona.restatedRequests)) {
      persona.restatedRequests = [];
    }
    persona.restatedRequests.push(...newRequests);
  });
}

export async function updatePersonaStatus(
  deviceId: string,
  workspacePath: string,
  status: string,
): Promise<void> {
  await mutatePersonaJson(deviceId, workspacePath, (persona) => {
    persona.status = status;
    if (status === "completed" || status === "stopped" || status === "failed") {
      persona.completedAt = new Date().toISOString();
    }
  });
}
