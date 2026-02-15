/**
 * Memory Manager — Thread Operations
 * 
 * CRUD, search, and matching for conversation threads.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import type {
  Thread,
  ThreadMessage,
} from "../types.js";
import { store } from "./manager-store.js";

const log = createComponentLogger("memory");

// LRU cache configuration
const MAX_THREADS_PER_USER = 100;

/**
 * Enforce LRU eviction: keep only the most recent N threads per user.
 */
function enforceThreadLRU(userId: string): void {
  const threadIds = store.userThreads.get(userId) || [];
  if (threadIds.length <= MAX_THREADS_PER_USER) return;

  // Sort threads by lastActiveAt (oldest first)
  const threads = threadIds
    .map(id => ({ id, thread: store.threads.get(id) }))
    .filter(t => t.thread)
    .sort((a, b) => a.thread!.lastActiveAt.getTime() - b.thread!.lastActiveAt.getTime());

  // Evict oldest threads beyond the limit
  const toEvict = threads.length - MAX_THREADS_PER_USER;
  for (let i = 0; i < toEvict; i++) {
    const { id } = threads[i];
    store.threads.delete(id);
    const index = threadIds.indexOf(id);
    if (index !== -1) threadIds.splice(index, 1);
  }

  store.userThreads.set(userId, threadIds);
  log.info(`Evicted ${toEvict} old threads for user ${userId} (LRU limit: ${MAX_THREADS_PER_USER})`);
}

// ============================================
// THREAD CRUD
// ============================================

export function createThread(
  userId: string,
  topic: string,
  entities: string[] = [],
  keywords: string[] = []
): Thread {
  const thread: Thread = {
    id: `thread_${nanoid()}`,
    topic,
    summary: "",
    entities,
    keywords,
    messages: [],
    createdAt: new Date(),
    lastActiveAt: new Date(),
    status: "active"
  };

  store.threads.set(thread.id, thread);

  const userThreads = store.userThreads.get(userId) || [];
  userThreads.push(thread.id);
  store.userThreads.set(userId, userThreads);

  // Enforce LRU: evict oldest threads if user exceeds limit
  enforceThreadLRU(userId);

  return thread;
}

export function getThread(threadId: string): Thread | undefined {
  return store.threads.get(threadId);
}

export function getUserThreads(userId: string): Thread[] {
  const threadIds = store.userThreads.get(userId) || [];
  return threadIds
    .map(id => store.threads.get(id))
    .filter((t): t is Thread => t !== undefined)
    .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
}

export function getActiveThreads(userId: string, limit: number = 10): Thread[] {
  return getUserThreads(userId)
    .filter(t => t.status === "active")
    .slice(0, limit);
}

export function addMessageToThread(
  threadId: string,
  message: Omit<ThreadMessage, "id" | "timestamp">
): ThreadMessage | undefined {
  const thread = store.threads.get(threadId);
  if (!thread) return undefined;

  const fullMessage: ThreadMessage = {
    ...message,
    id: `msg_${nanoid()}`,
    timestamp: new Date()
  };

  thread.messages.push(fullMessage);
  thread.lastActiveAt = new Date();
  
  return fullMessage;
}

export function updateThreadSummary(threadId: string, summary: string): void {
  const thread = store.threads.get(threadId);
  if (thread) {
    thread.summary = summary;
  }
}

export function archiveThread(threadId: string): void {
  const thread = store.threads.get(threadId);
  if (thread) {
    thread.status = "archived";
  }
}

export function saveThreads(threads: Thread[]): void {
  for (const thread of threads) {
    store.threads.set(thread.id, thread);
  }
}

// ============================================
// THREAD SEARCH & MATCHING
// ============================================

export interface ThreadSearchResult {
  thread: Thread;
  relevance: number;
  matchedKeywords: string[];
  matchedEntities: string[];
}

export function searchThreads(
  userId: string,
  query: string,
  limit: number = 5
): ThreadSearchResult[] {
  const threads = getActiveThreads(userId, 50);
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  const results: ThreadSearchResult[] = [];
  
  for (const thread of threads) {
    const matchedKeywords = thread.keywords.filter(k => 
      queryWords.some(w => k.toLowerCase().includes(w))
    );
    
    const matchedEntities = thread.entities.filter(e => 
      queryWords.some(w => e.toLowerCase().includes(w))
    );
    
    const topicMatch = queryWords.some(w => 
      thread.topic.toLowerCase().includes(w)
    );
    
    let relevance = 0;
    relevance += matchedKeywords.length * 0.3;
    relevance += matchedEntities.length * 0.4;
    relevance += topicMatch ? 0.3 : 0;
    
    const hoursSinceActive = (Date.now() - thread.lastActiveAt.getTime()) / (1000 * 60 * 60);
    const recencyBoost = Math.max(0, 0.2 - (hoursSinceActive / 240));
    relevance += recencyBoost;

    if (relevance > 0.1) {
      results.push({
        thread,
        relevance: Math.min(1, relevance),
        matchedKeywords,
        matchedEntities
      });
    }
  }

  return results
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}
