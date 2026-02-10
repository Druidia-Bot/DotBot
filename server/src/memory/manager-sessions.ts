/**
 * Memory Manager — Session Operations
 * 
 * Working memory: session CRUD, context tracking, and context window builder.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../logging.js";
import type {
  Thread,
  MentalModel,
  SessionMemory,
  SessionEntry,
} from "../types.js";
import { store } from "./manager-store.js";
import { getActiveThreads, getThread, searchThreads } from "./manager-threads.js";
import { getUserMentalModels } from "./manager-models.js";

const log = createComponentLogger("memory");

// ============================================
// SESSION CRUD
// ============================================

/**
 * Get or create a session for a user. Sessions are bounded working memory.
 */
export function getOrCreateSession(userId: string): SessionMemory {
  const existingId = store.userSessions.get(userId);
  if (existingId) {
    const session = store.sessions.get(existingId);
    if (session) {
      session.lastActiveAt = new Date();
      return session;
    }
  }
  
  const session: SessionMemory = {
    id: `session_${nanoid()}`,
    userId,
    startedAt: new Date(),
    lastActiveAt: new Date(),
    entries: [],
    activeContext: {
      entityIds: [],
      recentTopics: [],
    },
  };
  
  store.sessions.set(session.id, session);
  store.userSessions.set(userId, session.id);
  
  log.info(`New session created for user ${userId}`, { sessionId: session.id });
  return session;
}

/**
 * Add an entry to the user's current session.
 */
export function addSessionEntry(
  userId: string,
  type: SessionEntry["type"],
  content: string,
  metadata?: Record<string, any>,
  mentalModelId?: string
): SessionEntry {
  const session = getOrCreateSession(userId);
  
  const entry: SessionEntry = {
    id: `se_${nanoid(8)}`,
    timestamp: new Date(),
    type,
    content,
    metadata,
    mentalModelId,
  };
  
  session.entries.push(entry);
  session.lastActiveAt = new Date();
  
  if (session.entries.length > 100) {
    session.entries = session.entries.slice(-100);
  }
  
  return entry;
}

/**
 * Update the active context for the user's session.
 */
export function updateSessionContext(
  userId: string,
  updates: Partial<SessionMemory["activeContext"]>
): void {
  const session = getOrCreateSession(userId);
  
  if (updates.entityIds) {
    const combined = new Set([...session.activeContext.entityIds, ...updates.entityIds]);
    session.activeContext.entityIds = Array.from(combined);
  }
  if (updates.recentTopics) {
    session.activeContext.recentTopics = updates.recentTopics;
  }
  if (updates.lastAction !== undefined) {
    session.activeContext.lastAction = updates.lastAction;
  }
}

/**
 * Restore a session from a persisted snapshot (loaded from local agent).
 * Only restores if the user doesn't already have an active session.
 * Returns true if a session was restored, false if skipped.
 */
export function restoreSession(userId: string, snapshot: Record<string, any>): boolean {
  const existingId = store.userSessions.get(userId);
  if (existingId && store.sessions.get(existingId)) {
    return false;
  }

  const session: SessionMemory = {
    id: snapshot.id || `session_${nanoid()}`,
    userId,
    startedAt: new Date(snapshot.startedAt || Date.now()),
    lastActiveAt: new Date(snapshot.lastActiveAt || Date.now()),
    entries: (snapshot.entries || []).map((e: any) => ({
      ...e,
      timestamp: new Date(e.timestamp || Date.now()),
    })),
    activeContext: snapshot.activeContext || {
      entityIds: [],
      recentTopics: [],
    },
  };

  store.sessions.set(session.id, session);
  store.userSessions.set(userId, session.id);

  log.info(`Session restored from disk for user ${userId}`, {
    sessionId: session.id,
    entryCount: session.entries.length,
  });
  return true;
}

/**
 * Check if a user already has an active session in memory.
 */
export function hasActiveSession(userId: string): boolean {
  const existingId = store.userSessions.get(userId);
  return !!(existingId && store.sessions.get(existingId));
}

/**
 * Get recent session entries for context injection.
 */
export function getRecentSessionEntries(
  userId: string,
  limit: number = 10
): SessionEntry[] {
  const session = getOrCreateSession(userId);
  return session.entries.slice(-limit);
}

// ============================================
// CONTEXT WINDOW BUILDER
// ============================================

export interface MemoryContext {
  recentThreads: Thread[];
  relevantModels: MentalModel[];
  session: SessionMemory;
  summary: string;
}

export function buildMemoryContext(
  userId: string,
  currentPrompt: string,
  recentPrompts: string[] = []
): MemoryContext {
  const session = getOrCreateSession(userId);
  
  const recentThreads = getActiveThreads(userId, 5);
  
  const searchResults = searchThreads(userId, currentPrompt);
  const relevantThreadIds = new Set([
    ...recentThreads.map(t => t.id),
    ...searchResults.map(r => r.thread.id)
  ]);
  
  const threads = Array.from(relevantThreadIds)
    .map(id => getThread(id))
    .filter((t): t is Thread => t !== undefined)
    .slice(0, 5);

  const models = getUserMentalModels(userId);
  const relevantModels = models.filter(m => {
    const entityLower = m.entity.toLowerCase();
    const promptLower = currentPrompt.toLowerCase();
    return promptLower.includes(entityLower) ||
           recentPrompts.some(p => p.toLowerCase().includes(entityLower));
  });

  const threadSummary = threads.length > 0
    ? `Active threads: ${threads.map(t => t.topic).join(", ")}`
    : "No active threads";
  
  const modelSummary = relevantModels.length > 0
    ? `Known entities: ${relevantModels.map(m => `${m.entity} (${m.type}${m.subtype ? '/' + m.subtype : ''})`).join(", ")}`
    : "";
  
  const sessionSummary = session.activeContext.lastAction
    ? `Last action: ${session.activeContext.lastAction}`
    : "";

  return {
    recentThreads: threads,
    relevantModels,
    session,
    summary: [threadSummary, modelSummary, sessionSummary].filter(Boolean).join(". ")
  };
}
