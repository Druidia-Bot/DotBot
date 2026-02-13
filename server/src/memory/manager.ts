/**
 * Memory Manager
 *
 * Barrel re-export for all manager sub-modules, plus debug/export helpers.
 *
 * Sub-modules:
 * - manager-store.ts    — shared in-memory singleton
 * - manager-threads.ts  — thread CRUD + search
 * - manager-models.ts   — mental model CRUD + delta application
 * - manager-sessions.ts — session CRUD + context builder
 *
 * ARCHITECTURE NOTE:
 * The server caches memory (threads, mental models) in RAM for performance.
 * The local agent is the source of truth (disk-backed at ~/.bot/memory/).
 * After server restart, the cache rebuilds when agents reconnect.
 *
 * This works well for single-server deployments, but will not scale horizontally
 * (multiple servers will have different cache states). Multi-server SaaS will
 * require Redis or similar shared state layer.
 *
 * See: docs/upcoming-features/SHARED_MEMORY_CACHE.md
 */

import { store } from "./manager-store.js";
import { getUserThreads } from "./manager-threads.js";
import { getUserMentalModels } from "./manager-models.js";

// Re-export everything
export {
  createThread, getThread, getUserThreads, getActiveThreads,
  addMessageToThread, updateThreadSummary, archiveThread, saveThreads,
  searchThreads, type ThreadSearchResult,
} from "./manager-threads.js";
export {
  createMentalModel, getMentalModel, getUserMentalModels,
  findMentalModelByEntity, linkModelToThread,
  applyMemoryDelta, applyMemoryDeltas,
} from "./manager-models.js";
export {
  getOrCreateSession, addSessionEntry, updateSessionContext,
  restoreSession, hasActiveSession, getRecentSessionEntries,
  buildMemoryContext, type MemoryContext,
} from "./manager-sessions.js";


// ============================================
// DEBUG / EXPORT
// ============================================

export function exportUserMemory(userId: string) {
  const sessionId = store.userSessions.get(userId);
  return {
    threads: getUserThreads(userId),
    mentalModels: getUserMentalModels(userId),
    session: sessionId ? store.sessions.get(sessionId) : null,
  };
}

export function clearUserMemory(userId: string): void {
  const threadIds = store.userThreads.get(userId) || [];
  for (const id of threadIds) {
    store.threads.delete(id);
  }
  store.userThreads.delete(userId);

  const modelIds = store.userModels.get(userId) || [];
  for (const id of modelIds) {
    store.mentalModels.delete(id);
  }
  store.userModels.delete(userId);

  const sessionId = store.userSessions.get(userId);
  if (sessionId) {
    store.sessions.delete(sessionId);
    store.userSessions.delete(userId);
  }
}

// ============================================
// CACHE EVICTION (TTL CLEANUP)
// ============================================

const INACTIVE_USER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Clean up inactive users (no activity for > 7 days).
 * Runs periodically to prevent memory leaks.
 * Note: LRU eviction (per-user thread limit) is handled in manager-threads.ts
 */
export function cleanupInactiveUsers(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const userId of store.userThreads.keys()) {
    const threadIds = store.userThreads.get(userId) || [];

    // Find most recent activity across all threads
    let lastActivity = 0;
    for (const threadId of threadIds) {
      const thread = store.threads.get(threadId);
      if (thread) {
        lastActivity = Math.max(lastActivity, thread.lastActiveAt.getTime());
      }
    }

    // Clear user if inactive for > TTL
    if (lastActivity > 0 && now - lastActivity > INACTIVE_USER_TTL_MS) {
      clearUserMemory(userId);
      cleaned++;
    }
  }

  return cleaned;
}

// Start periodic cleanup (every 6 hours)
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startMemoryCleanup(): void {
  if (cleanupTimer) return; // Already started

  cleanupTimer = setInterval(() => {
    const cleaned = cleanupInactiveUsers();
    if (cleaned > 0) {
      console.log(`[Memory] Cleaned up ${cleaned} inactive users`);
    }
  }, 6 * 60 * 60 * 1000); // Every 6 hours

  if (cleanupTimer.unref) cleanupTimer.unref(); // Don't keep process alive
}

export function stopMemoryCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
