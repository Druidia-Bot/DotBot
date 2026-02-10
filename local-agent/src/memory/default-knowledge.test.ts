/**
 * Default Knowledge — Production Tests
 * 
 * Tests that getDefaultKnowledgeForPersona reads content from default-content/knowledge/*.md,
 * and that all referenced source files exist and are well-formed.
 */

import { describe, it, expect } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import {
  DEFAULT_KNOWLEDGE,
  getDefaultKnowledgeForPersona,
  getPersonasWithDefaultKnowledge,
} from "./default-knowledge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_SRC_DIR = path.join(__dirname, "default-content", "knowledge");

// ============================================
// CONFIGURATION
// ============================================

describe("Default Knowledge — Configuration", () => {
  it("DEFAULT_KNOWLEDGE array is non-empty", () => {
    expect(DEFAULT_KNOWLEDGE.length).toBeGreaterThan(0);
  });

  it("each entry has personaSlug, filename, and sourceFile", () => {
    for (const doc of DEFAULT_KNOWLEDGE) {
      expect(doc.personaSlug).toBeTruthy();
      expect(doc.filename).toBeTruthy();
      expect(doc.filename.endsWith(".md")).toBe(true);
      expect(doc.sourceFile).toBeTruthy();
      expect(doc.sourceFile.endsWith(".md")).toBe(true);
    }
  });

  it("each sourceFile exists on disk", async () => {
    for (const doc of DEFAULT_KNOWLEDGE) {
      const srcPath = path.join(KNOWLEDGE_SRC_DIR, doc.sourceFile);
      const exists = await fs.access(srcPath).then(() => true).catch(() => false);
      expect(exists, `Missing source file: ${doc.sourceFile}`).toBe(true);
    }
  });

  it("each source file has valid markdown frontmatter", async () => {
    for (const doc of DEFAULT_KNOWLEDGE) {
      const content = await fs.readFile(
        path.join(KNOWLEDGE_SRC_DIR, doc.sourceFile),
        "utf-8"
      );
      const normalized = content.replace(/\r\n/g, "\n");

      expect(normalized.startsWith("---\n"), `${doc.sourceFile}: missing opening ---`).toBe(true);
      expect(normalized.includes("\n---\n"), `${doc.sourceFile}: missing closing ---`).toBe(true);
      expect(normalized).toContain("title:");
      expect(normalized).toContain("description:");
    }
  });
});

// ============================================
// getDefaultKnowledgeForPersona
// ============================================

describe("getDefaultKnowledgeForPersona", () => {
  it("returns docs for a known persona", async () => {
    const docs = await getDefaultKnowledgeForPersona("skill-writer");
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0].personaSlug).toBe("skill-writer");
  });

  it("populates content from the prompt file", async () => {
    const docs = await getDefaultKnowledgeForPersona("skill-writer");
    expect(docs.length).toBeGreaterThan(0);

    const doc = docs[0];
    expect(doc.content).toBeTruthy();
    expect(typeof doc.content).toBe("string");
    expect(doc.content!.length).toBeGreaterThan(100);

    // Content should match the source file
    const sourceContent = await fs.readFile(
      path.join(KNOWLEDGE_SRC_DIR, doc.sourceFile),
      "utf-8"
    );
    expect(doc.content).toBe(sourceContent);
  });

  it("returns empty array for unknown persona", async () => {
    const docs = await getDefaultKnowledgeForPersona("nonexistent-persona");
    expect(docs).toEqual([]);
  });

  it("each returned doc has filename for writing to disk", async () => {
    const docs = await getDefaultKnowledgeForPersona("skill-writer");
    for (const doc of docs) {
      expect(doc.filename).toBeTruthy();
      expect(doc.filename.endsWith(".md")).toBe(true);
    }
  });

  it("does not mutate module-level DEFAULT_KNOWLEDGE array", async () => {
    // Call twice — if it mutates, second call would have stale content
    const first = await getDefaultKnowledgeForPersona("skill-writer");
    expect(first[0].content).toBeTruthy();

    // Verify the original array item has no content property set
    const original = DEFAULT_KNOWLEDGE.find(d => d.personaSlug === "skill-writer");
    expect(original?.content).toBeUndefined();
  });
});

// ============================================
// getPersonasWithDefaultKnowledge
// ============================================

describe("getPersonasWithDefaultKnowledge", () => {
  it("returns unique persona slugs", () => {
    const slugs = getPersonasWithDefaultKnowledge();
    expect(slugs.length).toBeGreaterThan(0);
    // Verify uniqueness
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("includes skill-writer", () => {
    const slugs = getPersonasWithDefaultKnowledge();
    expect(slugs).toContain("skill-writer");
  });
});
