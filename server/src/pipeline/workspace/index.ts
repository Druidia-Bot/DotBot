/**
 * Workspace — Barrel Exports
 *
 * Agent workspace management for the pipeline.
 *
 * Structure:
 *   types.ts     — WorkspaceCommand, AgentWorkspace, TaskJson, constants
 *   create.ts    — createWorkspace() (used by receptionist)
 *   io.ts        — readWorkspaceFile, writeWorkspaceFile, listWorkspaceDir
 *   persona.ts   — persona JSON helpers (used by planner/step-executor)
 *   recovery.ts  — task recovery on device reconnect
 *   cleanup.ts   — workspace cleanup scheduler
 */

// Types
export type { WorkspaceCommand, AgentWorkspace, TaskJson } from "./types.js";
export { WORKSPACE_BASE, assertSafeAgentId } from "./types.js";

// Creation
export { createWorkspace } from "./create.js";

// File I/O
export { readWorkspaceFile, writeWorkspaceFile, listWorkspaceDir } from "./io.js";

// Persona helpers
export {
  readPersonaJson,
  writePersonaJson,
  mutatePersonaJson,
  persistQueueEntry,
  appendToPersonaRequests,
  updatePersonaStatus,
  readPlanJson,
} from "./persona.js";
export type { PlanProgress } from "./persona.js";

// Recovery
export { listWorkspaceFolders, readTaskJson, categorizeIncompleteTasks } from "./recovery.js";

// Cleanup
export { cleanupWorkspace, stopWorkspaceCleanup, scheduleWorkspaceCleanup, setCleanupExecutor } from "./cleanup.js";
