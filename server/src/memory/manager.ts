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
