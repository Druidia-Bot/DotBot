/**
 * Agent Work Thread Persistence
 * 
 * Each spawned agent task gets a work thread stored on disk.
 * Contains the internal conversation, tool calls, and results.
 * Used for:
 * - Crash recovery (pick up where left off)
 * - UI display (show what agents are doing)
 * - Debugging (inspect agent behavior)
 * 
 * Auto-cleaned after 24 hours by the sleep cycle.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { AGENT_WORK_DIR, fileExists, readJson, writeJson } from "./store-core.js";

// ============================================
// LOCKING (same pattern as store-threads.ts)
// ============================================

const workLocks = new Map<string, Promise<void>>();
const MAX_ENTRIES = 500;

async function withWorkLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const pending = workLocks.get(taskId) || Promise.resolve();

  let release: () => void;
  const next = new Promise<void>(r => { release = r; });
  workLocks.set(taskId, next);

  try {
    await pending;
    return await fn();
  } finally {
    release!();
    if (workLocks.get(taskId) === next) {
      workLocks.delete(taskId);
    }
  }
}

// ============================================
// TYPES
// ============================================

export interface AgentWorkEntry {
  type: "started" | "tool_call" | "tool_result" | "iteration" | "completed" | "failed";
  timestamp: number;
  [key: string]: any;
}

export interface AgentWorkThread {
  agentTaskId: string;
  createdAt: string;
  lastUpdatedAt: string;
  /** ISO timestamp after which this thread can be cleaned up */
  deleteAfter?: string;
  entries: AgentWorkEntry[];
}

// ============================================
// PERSISTENCE
// ============================================

/**
 * Append a work entry to an agent's work thread.
 * Creates the thread file if it doesn't exist.
 * Marks thread for deletion 24h after completion.
 */
export async function appendAgentWork(
  agentTaskId: string,
  entry: AgentWorkEntry
): Promise<void> {
  return withWorkLock(agentTaskId, async () => {
    try {
      await fs.mkdir(AGENT_WORK_DIR, { recursive: true });
      const filePath = path.join(AGENT_WORK_DIR, `${agentTaskId}.json`);

      let thread: AgentWorkThread;
      if (await fileExists(filePath)) {
        thread = await readJson<AgentWorkThread>(filePath);
      } else {
        thread = {
          agentTaskId,
          createdAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          entries: [],
        };
      }

      thread.entries.push(entry);
      thread.lastUpdatedAt = new Date().toISOString();

      // Cap entries to prevent unbounded growth
      if (thread.entries.length > MAX_ENTRIES) {
        thread.entries = thread.entries.slice(-MAX_ENTRIES);
      }

      // Mark for deletion 24h after completion/failure
      if (entry.type === "completed" || entry.type === "failed") {
        const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        thread.deleteAfter = deleteAt.toISOString();
      }

      await writeJson(filePath, thread);
    } catch (error) {
      console.error(`[AgentWork] Failed to persist entry for ${agentTaskId}:`, error);
    }
  });
}

/**
 * Get an agent work thread by ID.
 */
export async function getAgentWork(agentTaskId: string): Promise<AgentWorkThread | null> {
  try {
    const filePath = path.join(AGENT_WORK_DIR, `${agentTaskId}.json`);
    if (await fileExists(filePath)) {
      return await readJson<AgentWorkThread>(filePath);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get all incomplete (no deleteAfter) agent work threads.
 * Useful for crash recovery on startup.
 */
export async function getIncompleteAgentWork(): Promise<AgentWorkThread[]> {
  try {
    await fs.mkdir(AGENT_WORK_DIR, { recursive: true });
    const files = await fs.readdir(AGENT_WORK_DIR);
    const incomplete: AgentWorkThread[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const thread = await readJson<AgentWorkThread>(path.join(AGENT_WORK_DIR, file));
        if (!thread.deleteAfter) {
          incomplete.push(thread);
        }
      } catch { /* skip corrupt files */ }
    }

    return incomplete;
  } catch {
    return [];
  }
}

/**
 * Clean up expired agent work threads (deleteAfter < now).
 * Called by the sleep cycle.
 * Returns number of files cleaned up.
 */
export async function cleanupExpiredAgentWork(): Promise<number> {
  try {
    await fs.mkdir(AGENT_WORK_DIR, { recursive: true });
    const files = await fs.readdir(AGENT_WORK_DIR);
    const now = new Date().toISOString();
    let cleaned = 0;

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const filePath = path.join(AGENT_WORK_DIR, file);
        const thread = await readJson<AgentWorkThread>(filePath);
        if (thread.deleteAfter && thread.deleteAfter < now) {
          await fs.unlink(filePath);
          cleaned++;
        }
      } catch { /* skip corrupt files */ }
    }

    return cleaned;
  } catch {
    return 0;
  }
}
