/**
 * Workspace Persona Helpers
 *
 * Read-modify-write operations for agent_persona.json in workspaces.
 * Used by the planner/step-executor for persona mutations during execution.
 */

import { createComponentLogger } from "#logging.js";
import { readWorkspaceFile, writeWorkspaceFile } from "./io.js";

const log = createComponentLogger("workspace.persona");

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

export interface PlanProgress {
  approach?: string;
  steps: Array<{
    id: string;
    title: string;
    description: string;
    expectedOutput: string;
    toolIds: string[];
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
