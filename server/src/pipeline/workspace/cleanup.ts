/**
 * Workspace Cleanup
 *
 * Manages workspace lifecycle after task completion:
 * - Generates cleanup commands to remove workspace directories
 * - Scheduler for delayed cleanup (24h after completion)
 * - Server shutdown cleanup
 */

import { createComponentLogger } from "#logging.js";
import { assertSafeAgentId, WORKSPACE_BASE } from "./types.js";
import type { WorkspaceCommand } from "./types.js";

const log = createComponentLogger("workspace.cleanup");

/** Track completed workspaces for cleanup */
const completedWorkspaces = new Map<string, { agentId: string; completedAt: Date }>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Cleanup interval: check every 10 minutes */
const CLEANUP_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** Delete workspace 24 hours after task completion */
const CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Generate cleanup command for a workspace.
 * Removes the entire workspace directory.
 */
export function cleanupWorkspace(agentId: string): WorkspaceCommand {
  assertSafeAgentId(agentId);
  return {
    toolId: "directory.delete",
    args: {
      path: `${WORKSPACE_BASE}/${agentId}`,
      recursive: true,
    },
  };
}

/** Optional callback to execute cleanup commands */
let executeCleanupCallback: ((cmd: WorkspaceCommand) => Promise<void>) | null = null;

/**
 * Set the callback for executing cleanup commands.
 * Should be called on server startup.
 */
export function setCleanupExecutor(executor: (cmd: WorkspaceCommand) => Promise<void>): void {
  executeCleanupCallback = executor;
}

/**
 * Schedule a workspace for cleanup after 24 hours.
 * Called when an agent completes and task.json is deleted.
 */
export function scheduleWorkspaceCleanup(agentId: string): void {
  assertSafeAgentId(agentId);
  completedWorkspaces.set(agentId, {
    agentId,
    completedAt: new Date(),
  });

  // Start cleanup timer if not running
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      const commands = runCleanupCycle();
      if (executeCleanupCallback && commands.length > 0) {
        for (const cmd of commands) {
          executeCleanupCallback(cmd).catch((err) => {
            log.error("Failed to execute cleanup command", { error: err, agentId: cmd.args?.path });
          });
        }
      }
    }, CLEANUP_CHECK_INTERVAL_MS);
    if (cleanupTimer.unref) cleanupTimer.unref();
    log.info("Workspace cleanup scheduler started");
  }

  log.info("Workspace scheduled for cleanup", { agentId });
}

/**
 * Run a cleanup cycle: delete workspaces older than 24 hours.
 * Returns cleanup commands for the client to execute.
 */
function runCleanupCycle(): WorkspaceCommand[] {
  const now = Date.now();
  const commands: WorkspaceCommand[] = [];

  for (const [agentId, { completedAt }] of completedWorkspaces) {
    const age = now - completedAt.getTime();
    if (age >= CLEANUP_DELAY_MS) {
      commands.push(cleanupWorkspace(agentId));
      completedWorkspaces.delete(agentId);
      log.info("Workspace cleanup command generated", { agentId, ageMinutes: Math.round(age / 60_000) });
    }
  }

  if (completedWorkspaces.size === 0 && cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    log.info("Workspace cleanup scheduler stopped (no workspaces)");
  }

  return commands;
}

/**
 * Stop the workspace cleanup scheduler.
 * Called on server shutdown.
 */
export function stopWorkspaceCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    log.info("Workspace cleanup scheduler stopped");
  }
  completedWorkspaces.clear();
}
