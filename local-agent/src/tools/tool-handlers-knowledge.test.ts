/**
 * Tool Handlers — Knowledge & Persona Management — Tests
 *
 * Tests the skeleton builder (pure functions), knowledge CRUD handlers,
 * and persona CRUD handlers. Uses a temp directory to avoid touching
 * real ~/.bot/ storage.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// TEMP DIRECTORY SETUP
// ============================================

const { tempDir, tempKnowledgeDir, tempPersonasDir } = vi.hoisted(() => {
  const _path = require("path");
  const _os = require("os");
  const base = _path.join(_os.tmpdir(), `dotbot-knowledge-test-${Date.now()}`);
  return {
    tempDir: base,
    tempKnowledgeDir: _path.join(base, ".bot", "knowledge"),
    tempPersonasDir: _path.join(base, ".bot", "personas"),
  };
});

// Mock the paths before any imports that use them
vi.mock("os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("os")>();
  return {
    ...orig,
    default: {
      ...orig,
      homedir: () => tempDir,
    },
    homedir: () => tempDir,
  };
});

// Mock stores for both persona formats
const mockPersonaStore = new Map<string, any>(); // directory-based persona.json
const mockMdPersonaStore = new Map<string, any>(); // .md file personas
const mockPersonaKnowledge = new Map<string, Map<string, string>>(); // slug -> (filename -> content)

// Mock directory-based personas module
vi.mock("../memory/personas.js", () => ({
  getPersona: async (slug: string) => mockPersonaStore.get(slug) || null,
  getPersonasIndex: async () => ({
    personas: Array.from(mockPersonaStore.values()).map((p: any) => ({
      slug: p.slug,
      name: p.name,
      role: p.role,
      modelTier: p.modelTier || "smart",
      knowledgeFileCount: p.knowledgeFiles?.length || 0,
    })),
  }),
  addKnowledge: async (slug: string, filename: string, content: string) => {
    if (!mockPersonaKnowledge.has(slug)) mockPersonaKnowledge.set(slug, new Map());
    mockPersonaKnowledge.get(slug)!.set(filename, content);
    const persona = mockPersonaStore.get(slug);
    if (persona && !persona.knowledgeFiles.includes(filename)) {
      persona.knowledgeFiles.push(filename);
    }
  },
  listKnowledge: async (slug: string) => {
    const files = mockPersonaKnowledge.get(slug);
    return files ? Array.from(files.keys()) : [];
  },
  getKnowledge: async (slug: string, filename: string) => {
    return mockPersonaKnowledge.get(slug)?.get(filename) || null;
  },
}));

// Mock .md file personas module
vi.mock("../memory/persona-files.js", () => ({
  savePersonaFile: async (persona: any) => {
    mockMdPersonaStore.set(persona.id, persona);
  },
  loadPersona: async (id: string) => mockMdPersonaStore.get(id) || null,
  loadAllPersonas: async () => Array.from(mockMdPersonaStore.values()),
}));

import { buildKnowledgeSkeleton } from "./tool-handlers-knowledge.js";
import { handleKnowledge, handlePersonas } from "./tool-handlers-knowledge.js";

// ============================================
// SETUP / TEARDOWN
// ============================================

beforeAll(async () => {
  await fs.mkdir(tempKnowledgeDir, { recursive: true });
  await fs.mkdir(tempPersonasDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean general knowledge dir
  const entries = await fs.readdir(tempKnowledgeDir).catch(() => []);
  for (const entry of entries) {
    await fs.rm(path.join(tempKnowledgeDir, entry as string), { recursive: true, force: true });
  }
  // Clean persona mocks
  mockPersonaStore.clear();
  mockMdPersonaStore.clear();
  mockPersonaKnowledge.clear();
});

// ============================================
// SKELETON BUILDER — Pure Function Tests
// ============================================

describe("buildKnowledgeSkeleton", () => {
  it("shows _meta as title with source type and tags", () => {
    const doc = {
      _meta: { title: "React Docs", source_type: "url", tags: ["react", "docs"], description: "Full API ref" },
      overview: "React is a library",
    };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toContain("React Docs (url) [react, docs]");
    expect(skeleton).toContain("Full API ref");
    expect(skeleton).toContain("overview: React is a library");
  });

  it("truncates long strings with word count", () => {
    const longText = "word ".repeat(200).trim(); // 999 chars, 200 words
    const doc = { content: longText };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toContain("content:");
    expect(skeleton).toContain("... (200 words)");
    expect(skeleton.length).toBeLessThan(longText.length);
  });

  it("shows short strings inline verbatim", () => {
    const doc = { color: "blue and yellow" };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toBe("color: blue and yellow");
  });

  it("shows numbers and booleans inline", () => {
    const doc = { count: 42, active: true };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toContain("count: 42");
    expect(skeleton).toContain("active: true");
  });

  it("shows null values", () => {
    const doc = { empty: null };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toBe("empty: null");
  });

  it("shows small arrays inline", () => {
    const doc = { tags: ["react", "vue", "angular"] };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toContain('["react", "vue", "angular"]');
  });

  it("truncates large arrays with count", () => {
    const doc = { items: ["a", "b", "c", "d", "e", "f"] };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toContain('"a"');
    expect(skeleton).toContain('"b"');
    expect(skeleton).toContain('"c"');
    expect(skeleton).toContain("... +3 more");
  });

  it("shows empty arrays as []", () => {
    const doc = { empty: [] };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toBe("empty: []");
  });

  it("shows array of objects with name/title labels", () => {
    const doc = { examples: [{ name: "Basic" }, { name: "Advanced" }, { name: "Expert" }, { name: "Pro" }] };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toContain("{Basic}");
    expect(skeleton).toContain("{Advanced}");
    expect(skeleton).toContain("{Expert}");
    expect(skeleton).toContain("... +1 more");
  });

  it("recurses into small nested objects (≤4 keys)", () => {
    const doc = { api: { get: "GET /users", post: "POST /users" } };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toContain("api:");
    expect(skeleton).toContain("get: GET /users");
    expect(skeleton).toContain("post: POST /users");
  });

  it("summarizes large nested objects (>4 keys)", () => {
    const doc = { api: { a: 1, b: 2, c: 3, d: 4, e: 5 } };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toContain("api: {a, b, c, d, ... +1 more keys}");
  });

  it("stops recursion at depth 2", () => {
    const doc = { level1: { level2: { level3: { deep: "value" } } } };
    const skeleton = buildKnowledgeSkeleton(doc);
    // At depth 2, level3 should show key count, not recurse
    expect(skeleton).toContain("level3: {1 keys}");
  });

  it("handles mixed content document", () => {
    const doc = {
      _meta: { title: "Test", tags: [] },
      overview: "Short overview",
      gotchas: ["No useState", "No event handlers", "No functions as props", "No conditional rendering", "No hooks"],
      compatibility: "React 19+",
    };
    const skeleton = buildKnowledgeSkeleton(doc);
    expect(skeleton).toContain("Test");
    expect(skeleton).toContain("overview: Short overview");
    expect(skeleton).toContain("... +2 more");
    expect(skeleton).toContain("compatibility: React 19+");
  });
});

// ============================================
// KNOWLEDGE HANDLERS
// ============================================

describe("handleKnowledge — save", () => {
  it("saves a JSON knowledge document to general knowledge", async () => {
    const result = await handleKnowledge("knowledge.save", {
      title: "Test Knowledge",
      content: JSON.stringify({ overview: "Test content", details: ["a", "b"] }),
      tags: "test, unit",
      description: "A test doc",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Saved knowledge");
    expect(result.output).toContain("test-knowledge.json");
    expect(result.output).toContain("Skeleton:");

    // Verify file was written
    const filePath = path.join(tempKnowledgeDir, "test-knowledge.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const doc = JSON.parse(raw);
    expect(doc._meta.title).toBe("Test Knowledge");
    expect(doc._meta.tags).toEqual(["test", "unit"]);
    expect(doc.overview).toBe("Test content");
    expect(doc.details).toEqual(["a", "b"]);
  });

  it("rejects missing title", async () => {
    const result = await handleKnowledge("knowledge.save", { content: "{}" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("title is required");
  });

  it("rejects missing content", async () => {
    const result = await handleKnowledge("knowledge.save", { title: "Test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("content is required");
  });

  it("rejects invalid JSON content", async () => {
    const result = await handleKnowledge("knowledge.save", { title: "Test", content: "not json" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("valid JSON string");
  });

  it("accepts content as an object directly", async () => {
    const result = await handleKnowledge("knowledge.save", {
      title: "Object Content",
      content: { key: "value" },
    });
    expect(result.success).toBe(true);
  });

  it("saves to persona knowledge when persona_slug is provided", async () => {
    // Create a persona first
    mockPersonaStore.set("test-persona", {
      slug: "test-persona",
      name: "Test Persona",
      role: "tester",
      knowledgeFiles: [],
    });

    const result = await handleKnowledge("knowledge.save", {
      title: "Persona Knowledge",
      content: JSON.stringify({ info: "persona-specific data" }),
      persona_slug: "test-persona",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("persona test-persona");
    expect(mockPersonaKnowledge.get("test-persona")?.has("persona-knowledge.json")).toBe(true);
  });

  it("rejects saving to non-existent persona", async () => {
    const result = await handleKnowledge("knowledge.save", {
      title: "Test",
      content: "{}",
      persona_slug: "nonexistent",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Persona not found");
  });
});

describe("handleKnowledge — list", () => {
  it("returns empty message when no knowledge exists", async () => {
    const result = await handleKnowledge("knowledge.list", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("No knowledge documents found");
  });

  it("lists knowledge with skeletons", async () => {
    // Save a doc first
    await handleKnowledge("knowledge.save", {
      title: "Listed Doc",
      content: JSON.stringify({ overview: "Test", items: [1, 2, 3] }),
      tags: "list-test",
    });

    const result = await handleKnowledge("knowledge.list", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("1 knowledge doc(s)");
    expect(result.output).toContain("listed-doc.json");
    expect(result.output).toContain("Listed Doc");
  });
});

describe("handleKnowledge — read", () => {
  it("reads full document", async () => {
    await handleKnowledge("knowledge.save", {
      title: "Readable Doc",
      content: JSON.stringify({ data: "full content here" }),
    });

    const result = await handleKnowledge("knowledge.read", { filename: "readable-doc.json" });
    expect(result.success).toBe(true);
    const doc = JSON.parse(result.output);
    expect(doc.data).toBe("full content here");
  });

  it("reads specific section by key", async () => {
    await handleKnowledge("knowledge.save", {
      title: "Sectioned Doc",
      content: JSON.stringify({ overview: "Short", gotchas: ["No hooks", "No state"], api: { get: "/users" } }),
    });

    const result = await handleKnowledge("knowledge.read", {
      filename: "sectioned-doc.json",
      section: "gotchas",
    });
    expect(result.success).toBe(true);
    const gotchas = JSON.parse(result.output);
    expect(gotchas).toEqual(["No hooks", "No state"]);
  });

  it("reads nested sections with dot notation", async () => {
    await handleKnowledge("knowledge.save", {
      title: "Nested Doc",
      content: JSON.stringify({ api: { endpoints: { get: "/users", post: "/users" } } }),
    });

    const result = await handleKnowledge("knowledge.read", {
      filename: "nested-doc.json",
      section: "api.endpoints.get",
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe("/users");
  });

  it("returns error for non-existent section", async () => {
    await handleKnowledge("knowledge.save", {
      title: "No Section",
      content: JSON.stringify({ a: 1 }),
    });

    const result = await handleKnowledge("knowledge.read", {
      filename: "no-section.json",
      section: "missing",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(result.error).toContain("Available keys");
  });

  it("returns error for missing filename", async () => {
    const result = await handleKnowledge("knowledge.read", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("filename is required");
  });

  it("returns error for non-existent file", async () => {
    const result = await handleKnowledge("knowledge.read", { filename: "ghost.json" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("handleKnowledge — search", () => {
  it("finds matching keys by name", async () => {
    await handleKnowledge("knowledge.save", {
      title: "Search Target",
      content: JSON.stringify({ authentication: "OAuth2 flow", database: "PostgreSQL 15" }),
    });

    const result = await handleKnowledge("knowledge.search", { query: "auth" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("authentication");
    expect(result.output).toContain("OAuth2");
  });

  it("finds matching string values", async () => {
    await handleKnowledge("knowledge.save", {
      title: "Value Match",
      content: JSON.stringify({ framework: "React Server Components handle streaming" }),
    });

    const result = await handleKnowledge("knowledge.search", { query: "streaming" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("framework");
  });

  it("finds matching array items", async () => {
    await handleKnowledge("knowledge.save", {
      title: "Array Match",
      content: JSON.stringify({ gotchas: ["No useState in server components", "No event handlers"] }),
    });

    const result = await handleKnowledge("knowledge.search", { query: "useState" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("gotchas");
    expect(result.output).toContain("matching item");
  });

  it("returns no matches message when nothing found", async () => {
    await handleKnowledge("knowledge.save", {
      title: "No Match",
      content: JSON.stringify({ info: "nothing relevant here" }),
    });

    const result = await handleKnowledge("knowledge.search", { query: "zzzzzzzzz" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("No matches found");
  });

  it("rejects missing query", async () => {
    const result = await handleKnowledge("knowledge.search", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("query is required");
  });
});

describe("handleKnowledge — delete", () => {
  it("deletes an existing knowledge document", async () => {
    await handleKnowledge("knowledge.save", {
      title: "Deletable",
      content: JSON.stringify({ temp: true }),
    });

    const result = await handleKnowledge("knowledge.delete", { filename: "deletable.json" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Deleted");

    // Verify file is gone
    const readResult = await handleKnowledge("knowledge.read", { filename: "deletable.json" });
    expect(readResult.success).toBe(false);
  });

  it("returns error for non-existent file", async () => {
    const result = await handleKnowledge("knowledge.delete", { filename: "ghost.json" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("File not found");
  });

  it("rejects missing filename", async () => {
    const result = await handleKnowledge("knowledge.delete", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("filename is required");
  });
});

describe("handleKnowledge — unknown tool", () => {
  it("returns error for unknown tool ID", async () => {
    const result = await handleKnowledge("knowledge.bogus", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown knowledge tool");
  });
});

// ============================================
// PERSONA HANDLERS
// ============================================

describe("handlePersonas — create", () => {
  it("creates a new persona", async () => {
    const result = await handlePersonas("personas.create", {
      name: "Marketing Expert",
      role: "marketing strategist",
      system_prompt: "You are a marketing expert.",
      tools: "knowledge, http",
      expertise: "SEO, content marketing",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Created persona");
    expect(result.output).toContain("marketing-expert");
    expect(result.output).toContain("marketing strategist");

    // Verify stored as .md persona
    const stored = mockMdPersonaStore.get("marketing-expert");
    expect(stored).toBeTruthy();
    expect(stored.tools).toEqual(["knowledge", "http"]);
    expect(stored.expertise).toEqual(["SEO", "content marketing"]);
  });

  it("rejects duplicate persona", async () => {
    await handlePersonas("personas.create", {
      name: "Duplicate",
      role: "test",
      system_prompt: "test",
    });

    const result = await handlePersonas("personas.create", {
      name: "Duplicate",
      role: "test2",
      system_prompt: "test2",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("rejects missing name", async () => {
    const result = await handlePersonas("personas.create", { role: "test", system_prompt: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("name is required");
  });

  it("rejects missing role", async () => {
    const result = await handlePersonas("personas.create", { name: "Test", system_prompt: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("role is required");
  });

  it("rejects missing system_prompt", async () => {
    const result = await handlePersonas("personas.create", { name: "Test", role: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("system_prompt is required");
  });
});

describe("handlePersonas — list", () => {
  it("returns empty message when no personas exist", async () => {
    const result = await handlePersonas("personas.list", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("No local personas found");
  });

  it("lists existing personas", async () => {
    await handlePersonas("personas.create", {
      name: "Listed Persona",
      role: "lister",
      system_prompt: "You list things.",
    });

    const result = await handlePersonas("personas.list", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("1 local persona(s)");
    expect(result.output).toContain("Listed Persona");
    expect(result.output).toContain("lister");
  });
});

describe("handlePersonas — read", () => {
  it("reads a persona's full definition", async () => {
    await handlePersonas("personas.create", {
      name: "Readable Persona",
      role: "reader",
      system_prompt: "You read things.",
      model_tier: "fast",
    });

    const result = await handlePersonas("personas.read", { slug: "readable-persona" });
    expect(result.success).toBe(true);
    const persona = JSON.parse(result.output);
    expect(persona.name).toBe("Readable Persona");
    expect(persona.role).toBe("reader");
    expect(persona.systemPrompt).toBe("You read things.");
    expect(persona.modelTier).toBe("fast");
  });

  it("returns error for non-existent persona", async () => {
    const result = await handlePersonas("personas.read", { slug: "ghost" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Persona not found");
  });

  it("rejects missing slug", async () => {
    const result = await handlePersonas("personas.read", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("slug is required");
  });
});

describe("handlePersonas — unknown tool", () => {
  it("returns error for unknown tool ID", async () => {
    const result = await handlePersonas("personas.bogus", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown persona tool");
  });
});
