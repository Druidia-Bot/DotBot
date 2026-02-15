/**
 * Workspace Creation
 *
 * Creates workspace directory structure for a new agent.
 * Called by the receptionist when dispatching a task.
 */

import { createComponentLogger } from "#logging.js";
import { assertSafeAgentId, WORKSPACE_BASE } from "./types.js";
import type { AgentWorkspace, WorkspaceCommand } from "./types.js";

const log = createComponentLogger("workspace.create");

/**
 * Create a workspace definition for an agent.
 * Returns the workspace paths and the tool commands needed to create
 * the directory structure on the client.
 */
export function createWorkspace(agentId: string): {
  workspace: AgentWorkspace;
  setupCommands: WorkspaceCommand[];
} {
  assertSafeAgentId(agentId);
  const basePath = `${WORKSPACE_BASE}/${agentId}`;
  const researchPath = `${basePath}/research`;
  const outputPath = `${basePath}/output`;
  const logsPath = `${basePath}/logs`;

  const workspace: AgentWorkspace = {
    agentId,
    basePath,
    researchPath,
    outputPath,
    logsPath,
    createdAt: new Date(),
  };

  const setupCommands: WorkspaceCommand[] = [
    { toolId: "directory.create", args: { path: basePath, recursive: true } },
    { toolId: "directory.create", args: { path: researchPath, recursive: true } },
    { toolId: "directory.create", args: { path: outputPath, recursive: true } },
    { toolId: "directory.create", args: { path: logsPath, recursive: true } },
  ];

  log.info("Workspace created", { agentId, basePath });
  return { workspace, setupCommands };
}
