/**
 * Memory Manager Tests
 * 
 * Validates that the barrel re-exports work correctly and all
 * thread, model, delta, and session operations function after refactor.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { store } from "./manager-store.js";
import type { MemoryDelta, DialogSummary } from "../types.js";
import {
  // Thread operations
  createThread,
  getThread,
  getUserThreads,
  getActiveThreads,
  addMessageToThread,
  updateThreadSummary,
  archiveThread,
  saveThreads,
  searchThreads,
  // Model operations
  createMentalModel,
  getMentalModel,
  getUserMentalModels,
  findMentalModelByEntity,
  linkModelToThread,
  applyMemoryDelta,
  applyMemoryDeltas,
  // Session operations
  getOrCreateSession,
  addSessionEntry,
  updateSessionContext,
  restoreSession,
  hasActiveSession,
  getRecentSessionEntries,
  buildMemoryContext,
  // Debug
  exportUserMemory,
  clearUserMemory,
} from "./manager.js";

const TEST_USER = "test_user_1";

function resetStore() {
  store.threads.clear();
  store.mentalModels.clear();
  store.sessions.clear();
  store.userThreads.clear();
  store.userModels.clear();
  store.userSessions.clear();
}

/** Build a minimal valid DialogSummary for tests */
function makeSummary(text: string): DialogSummary {
  return {
    id: `dialog_test`,
    timestamp: new Date(),
    userIntent: text,
    spirit: text,
    keyPoints: [],
    decisions: [],
    openLoops: [],
  };
}

/** Build a minimal valid MemoryDelta for tests */
function makeDelta(overrides: Partial<MemoryDelta> & Pick<MemoryDelta, "entity">): MemoryDelta {
  return {
    additions: {},
    deductions: {},
    summary: makeSummary("test"),
    reasoning: "test",
    ...overrides,
  };
}

// ============================================
// THREAD TESTS
// ============================================

describe("Thread Management", () => {
  beforeEach(resetStore);

  it("creates a thread and retrieves it by ID", () => {
    const thread = createThread(TEST_USER, "Test Topic", ["entity1"], ["keyword1"]);
    
    expect(thread.id).toMatch(/^thread_/);
    expect(thread.topic).toBe("Test Topic");
    expect(thread.entities).toEqual(["entity1"]);
    expect(thread.keywords).toEqual(["keyword1"]);
    expect(thread.status).toBe("active");
    expect(thread.messages).toEqual([]);

    const retrieved = getThread(thread.id);
    expect(retrieved).toBe(thread);
  });

  it("returns undefined for non-existent thread", () => {
    expect(getThread("nonexistent")).toBeUndefined();
  });

  it("lists user threads sorted by lastActiveAt descending", () => {
    const t1 = createThread(TEST_USER, "Old thread");
    // Force t1 to be older
    t1.lastActiveAt = new Date(Date.now() - 10000);
    const t2 = createThread(TEST_USER, "New thread");
    
    const threads = getUserThreads(TEST_USER);
    expect(threads.length).toBe(2);
    expect(threads[0].id).toBe(t2.id);
  });

  it("getActiveThreads filters archived threads", () => {
    const t1 = createThread(TEST_USER, "Active");
    const t2 = createThread(TEST_USER, "Archived");
    archiveThread(t2.id);
    
    const active = getActiveThreads(TEST_USER);
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(t1.id);
  });

  it("adds messages to a thread", () => {
    const thread = createThread(TEST_USER, "Chat");
    const msg = addMessageToThread(thread.id, {
      role: "user",
      content: "Hello world",
    });
    
    expect(msg).toBeDefined();
    expect(msg!.id).toMatch(/^msg_/);
    expect(msg!.content).toBe("Hello world");
    expect(thread.messages.length).toBe(1);
  });

  it("returns undefined when adding message to non-existent thread", () => {
    const msg = addMessageToThread("fake_id", { role: "user", content: "test" });
    expect(msg).toBeUndefined();
  });

  it("updates thread summary", () => {
    const thread = createThread(TEST_USER, "Topic");
    updateThreadSummary(thread.id, "This is a summary");
    expect(thread.summary).toBe("This is a summary");
  });

  it("archives a thread", () => {
    const thread = createThread(TEST_USER, "To archive");
    archiveThread(thread.id);
    expect(thread.status).toBe("archived");
  });

  it("saves threads from external source", () => {
    const externalThread = {
      id: "thread_external_1",
      topic: "External",
      summary: "",
      entities: [],
      keywords: [],
      messages: [],
      createdAt: new Date(),
      lastActiveAt: new Date(),
      status: "active" as const,
    };
    saveThreads([externalThread]);
    expect(getThread("thread_external_1")).toBe(externalThread);
  });
});

describe("Thread Search", () => {
  beforeEach(resetStore);

  it("finds threads by keyword match", () => {
    const t1 = createThread(TEST_USER, "React Project", ["react"], ["frontend", "react"]);
    createThread(TEST_USER, "Backend API", ["express"], ["backend", "api"]);

    const results = searchThreads(TEST_USER, "react frontend");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].thread.id).toBe(t1.id);
    expect(results[0].matchedKeywords.length).toBeGreaterThan(0);
  });

  it("finds threads by entity match", () => {
    createThread(TEST_USER, "Billy's Schedule", ["billy"], ["schedule"]);
    
    const results = searchThreads(TEST_USER, "billy");
    expect(results.length).toBe(1);
    expect(results[0].matchedEntities).toContain("billy");
  });

  it("returns empty for unmatched query", () => {
    const t = createThread(TEST_USER, "Something", [], ["alpha"]);
    // Push thread into the past so recency boost doesn't trigger
    t.lastActiveAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const results = searchThreads(TEST_USER, "zzzznotfound");
    expect(results.length).toBe(0);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      createThread(TEST_USER, `Thread ${i}`, [], ["common"]);
    }
    const results = searchThreads(TEST_USER, "common", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ============================================
// MENTAL MODEL TESTS
// ============================================

describe("Mental Model Management", () => {
  beforeEach(resetStore);

  it("creates a mental model with all required fields", () => {
    const model = createMentalModel(TEST_USER, "Billy", "person", "child");
    
    expect(model.id).toMatch(/^mm_/);
    expect(model.entity).toBe("Billy");
    expect(model.type).toBe("person");
    expect(model.subtype).toBe("child");
    expect(model.beliefs).toEqual([]);
    expect(model.openLoops).toEqual([]);
    expect(model.constraints).toEqual([]);
    expect(model.confidence).toBe(0.7);
  });

  it("retrieves model by ID", () => {
    const model = createMentalModel(TEST_USER, "Project X", "concept");
    const retrieved = getMentalModel(model.id);
    expect(retrieved).toBe(model);
  });

  it("lists all models for a user", () => {
    createMentalModel(TEST_USER, "Alice", "person");
    createMentalModel(TEST_USER, "Bob", "person");
    createMentalModel("other_user", "Charlie", "person");
    
    const models = getUserMentalModels(TEST_USER);
    expect(models.length).toBe(2);
  });

  it("finds model by entity name (case-insensitive)", () => {
    createMentalModel(TEST_USER, "Billy", "person");
    
    expect(findMentalModelByEntity(TEST_USER, "billy")).toBeDefined();
    expect(findMentalModelByEntity(TEST_USER, "BILLY")).toBeDefined();
    expect(findMentalModelByEntity(TEST_USER, "nonexistent")).toBeUndefined();
  });

  it("links model to thread", () => {
    const model = createMentalModel(TEST_USER, "Entity", "concept");
    linkModelToThread(model.id, "thread_123");
    
    expect(model.sourceThreads).toContain("thread_123");
    
    // Duplicate link should not add
    linkModelToThread(model.id, "thread_123");
    expect(model.sourceThreads.length).toBe(1);
  });
});

// ============================================
// MEMORY DELTA TESTS
// ============================================

describe("Memory Delta Application", () => {
  beforeEach(resetStore);

  it("creates a new model when delta references unknown entity", () => {
    const model = applyMemoryDelta(TEST_USER, makeDelta({
      entity: "New Entity",
      type: "concept",
      additions: {
        attributes: { description: "A new thing" },
      },
    }));
    
    expect(model.entity).toBe("New Entity");
    expect(model.attributes.description).toBe("A new thing");
  });

  it("updates existing model by entity match", () => {
    const original = createMentalModel(TEST_USER, "Billy", "person");
    
    const updated = applyMemoryDelta(TEST_USER, makeDelta({
      entity: "Billy",
      additions: {
        attributes: { age: 7 },
        beliefs: [{ statement: "Likes soccer", conviction: 0.9, evidence: ["user said so"] }],
      },
    }));
    
    expect(updated.id).toBe(original.id);
    expect(updated.attributes.age).toBe(7);
    expect(updated.beliefs.length).toBe(1);
    expect(updated.beliefs[0].statement).toBe("Likes soccer");
    expect(updated.beliefs[0].id).toMatch(/^belief_/);
  });

  it("adds schema fields", () => {
    const model = createMentalModel(TEST_USER, "Person", "person");
    
    applyMemoryDelta(TEST_USER, makeDelta({
      entity: "Person",
      additions: {
        schema: [{ key: "age", type: "number", description: "Age", required: false }],
      },
    }));
    
    expect(model.schema.length).toBe(1);
    expect(model.schema[0].key).toBe("age");
    expect(model.schema[0].populated).toBe(false);
  });

  it("marks schema field as populated when attribute set", () => {
    const model = createMentalModel(TEST_USER, "Item", "concept");
    
    applyMemoryDelta(TEST_USER, makeDelta({
      entity: "Item",
      additions: {
        schema: [{ key: "color", type: "string", description: "Color", required: false }],
        attributes: { color: "blue" },
      },
    }));
    
    expect(model.schema[0].populated).toBe(true);
    expect(model.attributes.color).toBe("blue");
  });

  it("adds relationships without duplicates", () => {
    const model = createMentalModel(TEST_USER, "Alice", "person");
    
    const delta = makeDelta({
      entity: "Alice",
      additions: {
        relationships: [{ type: "friend", target: "Bob" }],
      },
    });
    
    applyMemoryDelta(TEST_USER, delta);
    applyMemoryDelta(TEST_USER, delta);
    
    expect(model.relationships.length).toBe(1);
  });

  it("adds open loops with IDs", () => {
    const model = createMentalModel(TEST_USER, "Project", "concept");
    
    applyMemoryDelta(TEST_USER, makeDelta({
      entity: "Project",
      additions: {
        openLoops: [{ description: "Need deadline", priority: "high" }],
      },
    }));
    
    expect(model.openLoops.length).toBe(1);
    expect(model.openLoops[0].id).toMatch(/^loop_/);
  });

  it("deducts schema keys and their attributes", () => {
    const model = createMentalModel(TEST_USER, "Entity", "concept");
    model.schema.push({ key: "temp", type: "string", description: "Temp", addedAt: new Date(), populated: true, required: false });
    model.attributes.temp = "value";
    
    applyMemoryDelta(TEST_USER, makeDelta({
      entity: "Entity",
      deductions: { schemaKeys: ["temp"] },
    }));
    
    expect(model.schema.length).toBe(0);
    expect(model.attributes.temp).toBeUndefined();
  });

  it("closes open loops via deductions", () => {
    const model = createMentalModel(TEST_USER, "Task", "concept");
    model.openLoops.push({
      id: "loop_abc",
      description: "Need info",
      priority: "medium",
      createdAt: new Date(),
    });
    
    applyMemoryDelta(TEST_USER, makeDelta({
      entity: "Task",
      deductions: {
        loopIds: ["loop_abc"],
        loopResolutions: { loop_abc: "Got the info" },
      },
    }));
    
    expect(model.openLoops[0].resolvedAt).toBeDefined();
    expect(model.openLoops[0].resolution).toBe("Got the info");
  });

  it("removes beliefs by ID", () => {
    const model = createMentalModel(TEST_USER, "X", "concept");
    model.beliefs.push({ id: "belief_del", statement: "Wrong", conviction: 0.5, evidence: [], addedAt: new Date() });
    
    applyMemoryDelta(TEST_USER, makeDelta({
      entity: "X",
      deductions: { beliefIds: ["belief_del"] },
    }));
    
    expect(model.beliefs.length).toBe(0);
  });

  it("applies multiple deltas in sequence", () => {
    const models = applyMemoryDeltas(TEST_USER, [
      makeDelta({ entity: "A", type: "concept", additions: { attributes: { name: "A" } } }),
      makeDelta({ entity: "B", type: "concept", additions: { attributes: { name: "B" } } }),
    ]);
    
    expect(models.length).toBe(2);
    expect(models[0].entity).toBe("A");
    expect(models[1].entity).toBe("B");
  });

  it("keeps recentDialog bounded at 20", () => {
    const model = createMentalModel(TEST_USER, "Chatty", "person");
    
    for (let i = 0; i < 25; i++) {
      applyMemoryDelta(TEST_USER, makeDelta({
        entity: "Chatty",
        summary: makeSummary(`Dialog ${i}`),
      }));
    }
    
    expect(model.recentDialog.length).toBe(20);
  });

  it("increases confidence on each delta", () => {
    createMentalModel(TEST_USER, "Conf", "concept");
    
    const model = applyMemoryDelta(TEST_USER, makeDelta({
      entity: "Conf",
    }));
    
    expect(model.confidence).toBe(0.75); // 0.7 + 0.05
  });
});

// ============================================
// SESSION TESTS
// ============================================

describe("Session Memory", () => {
  beforeEach(resetStore);

  it("creates a session on first access", () => {
    const session = getOrCreateSession(TEST_USER);
    
    expect(session.id).toMatch(/^session_/);
    expect(session.userId).toBe(TEST_USER);
    expect(session.entries).toEqual([]);
  });

  it("returns same session on subsequent access", () => {
    const s1 = getOrCreateSession(TEST_USER);
    const s2 = getOrCreateSession(TEST_USER);
    expect(s1.id).toBe(s2.id);
  });

  it("adds entries and keeps bounded at 100", () => {
    for (let i = 0; i < 110; i++) {
      addSessionEntry(TEST_USER, "user_message", `msg ${i}`);
    }
    
    const session = getOrCreateSession(TEST_USER);
    expect(session.entries.length).toBe(100);
    expect(session.entries[99].content).toBe("msg 109");
  });

  it("entry has correct structure", () => {
    const entry = addSessionEntry(TEST_USER, "user_message", "Hello", { extra: true }, "mm_123");
    
    expect(entry.id).toMatch(/^se_/);
    expect(entry.type).toBe("user_message");
    expect(entry.content).toBe("Hello");
    expect(entry.metadata).toEqual({ extra: true });
    expect(entry.mentalModelId).toBe("mm_123");
  });

  it("updates session context", () => {
    updateSessionContext(TEST_USER, {
      entityIds: ["mm_1", "mm_2"],
      recentTopics: ["weather"],
      lastAction: "checked forecast",
    });
    
    const session = getOrCreateSession(TEST_USER);
    expect(session.activeContext.entityIds).toContain("mm_1");
    expect(session.activeContext.recentTopics).toEqual(["weather"]);
    expect(session.activeContext.lastAction).toBe("checked forecast");
  });

  it("merges entityIds without duplicates", () => {
    updateSessionContext(TEST_USER, { entityIds: ["mm_1"] });
    updateSessionContext(TEST_USER, { entityIds: ["mm_1", "mm_2"] });
    
    const session = getOrCreateSession(TEST_USER);
    expect(session.activeContext.entityIds).toEqual(["mm_1", "mm_2"]);
  });

  it("restores session from snapshot", () => {
    const restored = restoreSession(TEST_USER, {
      id: "session_restored",
      startedAt: "2025-01-01T00:00:00Z",
      lastActiveAt: "2025-01-01T01:00:00Z",
      entries: [{ type: "user_message", content: "old msg", timestamp: "2025-01-01T00:30:00Z" }],
      activeContext: { entityIds: ["mm_old"], recentTopics: ["history"] },
    });
    
    expect(restored).toBe(true);
    const session = getOrCreateSession(TEST_USER);
    expect(session.id).toBe("session_restored");
    expect(session.entries.length).toBe(1);
  });

  it("does not overwrite existing session on restore", () => {
    getOrCreateSession(TEST_USER); // Create active session
    const restored = restoreSession(TEST_USER, { id: "session_new" });
    expect(restored).toBe(false);
  });

  it("hasActiveSession returns correct status", () => {
    expect(hasActiveSession(TEST_USER)).toBe(false);
    getOrCreateSession(TEST_USER);
    expect(hasActiveSession(TEST_USER)).toBe(true);
  });

  it("getRecentSessionEntries returns last N entries", () => {
    for (let i = 0; i < 20; i++) {
      addSessionEntry(TEST_USER, "user_message", `msg ${i}`);
    }
    
    const recent = getRecentSessionEntries(TEST_USER, 5);
    expect(recent.length).toBe(5);
    expect(recent[4].content).toBe("msg 19");
  });
});

// ============================================
// CONTEXT BUILDER TESTS
// ============================================

describe("Context Builder", () => {
  beforeEach(resetStore);

  it("builds context with threads, models, and session", () => {
    createThread(TEST_USER, "React Project", ["react"], ["react"]);
    createMentalModel(TEST_USER, "React", "concept");
    
    const ctx = buildMemoryContext(TEST_USER, "How do I use React?");
    
    expect(ctx.session).toBeDefined();
    expect(ctx.recentThreads.length).toBeGreaterThanOrEqual(1);
    expect(ctx.relevantModels.length).toBe(1);
    expect(ctx.summary).toContain("React");
  });

  it("returns empty context for new user", () => {
    const ctx = buildMemoryContext("new_user", "hello");
    
    expect(ctx.recentThreads.length).toBe(0);
    expect(ctx.relevantModels.length).toBe(0);
    expect(ctx.session).toBeDefined();
  });
});

// ============================================
// DEBUG / EXPORT TESTS
// ============================================

describe("Export & Clear", () => {
  beforeEach(resetStore);

  it("exports all user memory", () => {
    createThread(TEST_USER, "Thread");
    createMentalModel(TEST_USER, "Model", "concept");
    getOrCreateSession(TEST_USER);
    
    const exported = exportUserMemory(TEST_USER);
    expect(exported.threads.length).toBe(1);
    expect(exported.mentalModels.length).toBe(1);
    expect(exported.session).toBeDefined();
  });

  it("clears all user memory", () => {
    createThread(TEST_USER, "Thread");
    createMentalModel(TEST_USER, "Model", "concept");
    getOrCreateSession(TEST_USER);
    
    clearUserMemory(TEST_USER);
    
    expect(getUserThreads(TEST_USER).length).toBe(0);
    expect(getUserMentalModels(TEST_USER).length).toBe(0);
    expect(hasActiveSession(TEST_USER)).toBe(false);
  });
});
