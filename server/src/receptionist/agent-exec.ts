/**
 * Receptionist — Agent Execution Helpers
 *
 * Thin wrappers for executing tools and writing files/assignments
 * on the local agent via WebSocket commands.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../logging.js";
import { sendExecutionCommand, sendMemoryRequest } from "../ws/device-bridge.js";
import type { AgentStatus } from "../recruiter/output.js";

const log = createComponentLogger("receptionist.exec");

/**
 * Execute a tool on the local agent.
 */
export async function execToolOnAgent(
  deviceId: string,
  agentId: string,
  toolId: string,
  toolArgs: Record<string, any>,
  timeout = 10_000,
): Promise<string> {
  return sendExecutionCommand(deviceId, {
    id: `ws_${agentId}_${toolId.split(".").pop()}_${nanoid(6)}`,
    type: "tool_execute",
    payload: { toolId, toolArgs },
    dryRun: false,
    timeout,
    sandboxed: false,
    requiresApproval: false,
  });
}

/**
 * Write a file to the agent workspace via the local agent.
 */
export async function writeWorkspaceFile(
  deviceId: string,
  agentId: string,
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await execToolOnAgent(deviceId, agentId, "filesystem.create_file", { path: filePath, content });
    log.info("Workspace file saved", { path: filePath, length: content.length });
  } catch (err) {
    log.error("Failed to save workspace file", { path: filePath, error: err });
    throw err;
  }
}

/**
 * Write agent assignment to every model that was saved to or created.
 */
export async function writeAgentAssignments(
  deviceId: string,
  agentId: string,
  workspacePath: string,
  prompt: string,
  savedToModels: string[],
  newModelsCreated: string[],
): Promise<void> {
  const now = new Date().toISOString();
  const allSlugs = [...new Set([...savedToModels, ...newModelsCreated])];

  for (const slug of allSlugs) {
    try {
      await sendMemoryRequest(deviceId, {
        action: "save_model",
        modelSlug: slug,
        data: {
          slug,
          agents: [{
            agentId,
            workspacePath,
            status: "queued",
            prompt: prompt.slice(0, 500),
            createdAt: now,
            updatedAt: now,
          }],
        },
      } as any);
    } catch (err) {
      log.warn("Failed to write agent assignment", { slug, agentId, error: err });
    }
  }

  if (allSlugs.length > 0) {
    log.info("Agent assignments written", { agentId, models: allSlugs });
  }
}

/**
 * Update agent assignment status on memory models.
 * Called at lifecycle transitions: queued → running → completed/stopped/failed.
 */
export async function updateAgentAssignmentStatus(
  deviceId: string,
  agentId: string,
  modelSlugs: string[],
  status: AgentStatus,
): Promise<void> {
  const now = new Date().toISOString();

  for (const slug of modelSlugs) {
    try {
      await sendMemoryRequest(deviceId, {
        action: "save_model",
        modelSlug: slug,
        data: {
          slug,
          agents: [{ agentId, status, updatedAt: now }],
        },
      } as any);
    } catch (err) {
      log.warn("Failed to update agent assignment status", { slug, agentId, status, error: err });
    }
  }

  if (modelSlugs.length > 0) {
    log.info("Agent assignment status updated", { agentId, status, models: modelSlugs });
  }
}
