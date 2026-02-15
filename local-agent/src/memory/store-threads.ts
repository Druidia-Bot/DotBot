/**
 * Thread Management
 * 
 * CRUD for conversation threads, L0 summaries, archival, and condensation.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { nanoid } from "nanoid";
import {
  THREADS_DIR,
  ARCHIVE_DIR,
  fileExists,
  readJson,
  writeJson,
  getMemoryIndex,
} from "./store-core.js";

// ============================================
// PER-THREAD WRITE LOCK
// ============================================

/**
 * Serialize concurrent writes to the same thread file.
 * Without this, two near-simultaneous saveToThread calls (e.g. user msg +
 * assistant response) race on read-modify-write and corrupt the JSON.
 */
const threadLocks = new Map<string, Promise<void>>();

async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const pending = threadLocks.get(threadId) || Promise.resolve();

  let release: () => void;
  const next = new Promise<void>(r => { release = r; });
  threadLocks.set(threadId, next);

  try {
    await pending; // wait for previous write on this thread to finish
    return await fn();
  } finally {
    release!();
    if (threadLocks.get(threadId) === next) {
      threadLocks.delete(threadId); // clean up when no more pending
    }
  }
}

// ============================================
// THREAD CRUD
// ============================================

export async function getThread(threadId: string): Promise<any | null> {
  try {
    await fs.mkdir(THREADS_DIR, { recursive: true });
    const threadPath = path.join(THREADS_DIR, `${threadId}.json`);
    if (await fileExists(threadPath)) {
      return await readJson(threadPath);
    }
    return null;
  } catch (error) {
    console.error(`[Memory] Failed to get thread ${threadId}:`, error);
    return null;
  }
}

/**
 * Get L0 summaries of all threads (id, topic, status, lastActive).
 * Does not load full thread content — just enough for the receptionist to route.
 */
export async function getAllThreadSummaries(): Promise<{
  id: string;
  topic: string;
  status: string;
  lastActiveAt: string;
  entities: string[];
  keywords: string[];
}[]> {
  try {
    await fs.mkdir(THREADS_DIR, { recursive: true });
    const files = await fs.readdir(THREADS_DIR);
    const summaries = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const thread = await readJson<any>(path.join(THREADS_DIR, file));
        summaries.push({
          id: thread.id || file.replace(".json", ""),
          topic: thread.topic || "Untitled",
          status: thread.status || "active",
          lastActiveAt: thread.lastActiveAt || thread.createdAt || "",
          entities: thread.entities || [],
          keywords: thread.keywords || [],
        });
      } catch { /* skip corrupt files */ }
    }
    summaries.sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));
    return summaries;
  } catch {
    return [];
  }
}

/**
 * Get a combined L0 memory index for the receptionist.
 * Includes both mental model summaries and thread summaries.
 */
export async function getL0MemoryIndex(): Promise<{
  models: { slug: string; name: string; category: string; description: string; keywords: string[]; lastUpdatedAt: string }[];
  threads: { id: string; topic: string; status: string; lastActiveAt: string; entities: string[]; keywords: string[] }[];
  sessionSummary: string | null;
}> {
  const memoryIndex = await getMemoryIndex();
  const threads = await getAllThreadSummaries();

  return {
    models: memoryIndex.models.map(m => ({
      slug: m.slug,
      name: m.name,
      category: m.category,
      description: m.description || "",
      keywords: m.keywords,
      lastUpdatedAt: m.lastUpdatedAt,
    })),
    threads,
    sessionSummary: null,
  };
}

/**
 * Update a thread with new data
 */
export async function updateThread(threadId: string, updates: any): Promise<void> {
  return withThreadLock(threadId, async () => {
    try {
      await fs.mkdir(THREADS_DIR, { recursive: true });
      const threadPath = path.join(THREADS_DIR, `${threadId}.json`);
      
      let thread: any = {};
      if (await fileExists(threadPath)) {
        thread = await readJson(threadPath);
      }
      
      // Apply belief updates
      if (updates.beliefUpdates) {
        thread.beliefs = thread.beliefs || [];
        for (const update of updates.beliefUpdates) {
          if (update.action === "add" && update.belief) {
            thread.beliefs.push({
              id: `belief_${nanoid(12)}`,
              ...update.belief,
              createdAt: new Date().toISOString(),
              lastUpdated: new Date().toISOString()
            });
          } else if (update.action === "update" && update.beliefId) {
            const idx = thread.beliefs.findIndex((b: any) => b.id === update.beliefId);
            if (idx >= 0 && update.changes) {
              thread.beliefs[idx] = { ...thread.beliefs[idx], ...update.changes, lastUpdated: new Date().toISOString() };
            }
          } else if (update.action === "remove" && update.beliefId) {
            thread.beliefs = thread.beliefs.filter((b: any) => b.id !== update.beliefId);
          }
        }
      }
      
      // Apply constraint updates
      if (updates.constraintUpdates) {
        thread.hardConstraints = thread.hardConstraints || [];
        thread.softConstraints = thread.softConstraints || [];
        for (const update of updates.constraintUpdates) {
          const target = update.type === "hard" ? thread.hardConstraints : thread.softConstraints;
          if (update.action === "add" && update.constraint) {
            target.push({
              id: `constraint_${nanoid(12)}`,
              ...update.constraint,
              createdAt: new Date().toISOString()
            });
          } else if (update.action === "remove" && update.constraintId) {
            const idx = target.findIndex((c: any) => c.id === update.constraintId);
            if (idx >= 0) target.splice(idx, 1);
          }
        }
      }
      
      // Apply loop updates
      if (updates.loopUpdates) {
        thread.openLoops = thread.openLoops || [];
        thread.resolvedIssues = thread.resolvedIssues || [];
        for (const update of updates.loopUpdates) {
          if (update.action === "open" && update.loop) {
            thread.openLoops.push({
              id: `loop_${nanoid(12)}`,
              ...update.loop,
              createdAt: new Date().toISOString()
            });
          } else if (update.action === "close" && update.loopId) {
            const idx = thread.openLoops.findIndex((l: any) => l.id === update.loopId);
            if (idx >= 0) {
              const loop = thread.openLoops.splice(idx, 1)[0];
              thread.resolvedIssues = thread.resolvedIssues || [];
              thread.resolvedIssues.push({
                summary: loop.description,
                resolution: update.resolution,
                resolvedAt: new Date().toISOString()
              });
            }
          }
        }
      }
      
      // Apply schema updates
      if (updates.schemaUpdates) {
        thread.schema = thread.schema || {};
        for (const update of updates.schemaUpdates) {
          if (update.action === "addProperty" && update.property) {
            thread.schema[update.propertyName] = update.property;
          } else if (update.action === "removeProperty") {
            delete thread.schema[update.propertyName];
          } else if (update.action === "updateProperty" && update.property) {
            thread.schema[update.propertyName] = { ...thread.schema[update.propertyName], ...update.property };
          }
        }
      }
      
      thread.lastActiveAt = new Date().toISOString();
      await writeJson(threadPath, thread);
    } catch (error) {
      console.error(`[Memory] Failed to update thread ${threadId}:`, error);
      throw error;
    }
  });
}

/**
 * Save an entry to a thread's history
 */
export async function saveToThread(
  threadId: string, 
  entry: any, 
  options?: { createIfMissing?: boolean; topic?: string }
): Promise<void> {
  return withThreadLock(threadId, async () => {
    try {
      await fs.mkdir(THREADS_DIR, { recursive: true });
      const threadPath = path.join(THREADS_DIR, `${threadId}.json`);
      
      let thread: any;
      if (await fileExists(threadPath)) {
        thread = await readJson(threadPath);
      } else if (options?.createIfMissing) {
        thread = {
          id: threadId,
          topic: options.topic || "New Thread",
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          messages: [],
          beliefs: [],
          openLoops: [],
          resolvedIssues: [],
          hardConstraints: [],
          softConstraints: [],
          schema: {},
          priorities: []
        };
      } else {
        throw new Error(`Thread ${threadId} not found`);
      }
      
      thread.messages = thread.messages || [];
      thread.messages.push({
        id: `entry_${nanoid(12)}`,
        timestamp: new Date().toISOString(),
        ...entry
      });
      
      thread.lastActiveAt = new Date().toISOString();
      await writeJson(threadPath, thread);
    } catch (error) {
      console.error(`[Memory] Failed to save to thread ${threadId}:`, error);
      throw error;
    }
  });
}

// ============================================
// THREAD CLEARING
// ============================================

/**
 * Clear all active threads — deletes thread JSON files from the threads directory.
 * Does NOT touch: archive, mental models, knowledge, skills, or any other memory.
 * Returns the count of threads deleted.
 */
export async function clearAllThreads(): Promise<{ deleted: number; errors: number }> {
  let deleted = 0;
  let errors = 0;
  try {
    await fs.mkdir(THREADS_DIR, { recursive: true });
    const files = await fs.readdir(THREADS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      // Skip the archive subdirectory
      const fullPath = path.join(THREADS_DIR, file);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) continue;
        await fs.unlink(fullPath);
        deleted++;
      } catch (err) {
        console.error(`[Memory] Failed to delete thread ${file}:`, err);
        errors++;
      }
    }
    console.log(`[Memory] Cleared ${deleted} thread(s)${errors > 0 ? `, ${errors} error(s)` : ""}`);
  } catch (error) {
    console.error("[Memory] Failed to clear threads:", error);
  }
  return { deleted, errors };
}

// ============================================
// THREAD ARCHIVAL & CONDENSATION
// ============================================

/**
 * Archive a thread — move it from active threads to archive directory.
 * The thread file is preserved but no longer appears in L0 index.
 */
export async function archiveThread(threadId: string): Promise<boolean> {
  try {
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
    const threadPath = path.join(THREADS_DIR, `${threadId}.json`);
    if (!await fileExists(threadPath)) return false;

    const archivePath = path.join(ARCHIVE_DIR, `${threadId}.json`);
    const thread = await readJson<any>(threadPath);
    thread.archivedAt = new Date().toISOString();
    thread.status = "archived";
    await writeJson(archivePath, thread);
    await fs.unlink(threadPath);
    return true;
  } catch (error) {
    console.error(`[Memory] Failed to archive thread ${threadId}:`, error);
    return false;
  }
}

/**
 * Condense a thread — replace verbose message history with a summary.
 * Optionally preserves the last N messages for context continuity.
 */
export async function condenseThread(
  threadId: string,
  summary: string,
  keyPoints: string[],
  preserveLastN: number = 3
): Promise<boolean> {
  return withThreadLock(threadId, async () => {
    try {
      const threadPath = path.join(THREADS_DIR, `${threadId}.json`);
      if (!await fileExists(threadPath)) return false;

      const thread = await readJson<any>(threadPath);
      const allMessages = thread.messages || [];

      const preserved = allMessages.slice(-preserveLastN);

      thread.messages = [
        {
          id: `condensed_${nanoid(8)}`,
          role: "system",
          content: `[CONDENSED] ${summary}`,
          timestamp: new Date().toISOString(),
          condensed: true,
          keyPoints,
          originalMessageCount: allMessages.length,
        },
        ...preserved,
      ];

      thread.condensedAt = new Date().toISOString();
      thread.lastActiveAt = new Date().toISOString();
      await writeJson(threadPath, thread);
      return true;
    } catch (error) {
      console.error(`[Memory] Failed to condense thread ${threadId}:`, error);
      return false;
    }
  });
}
