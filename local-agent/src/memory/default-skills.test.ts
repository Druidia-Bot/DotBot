/**
 * Default Skills — Production Tests
 * 
 * Tests that bootstrapDefaultSkills reads from default-content/skills/*.md files,
 * writes valid SKILL.md to disk, and is idempotent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

const { tempSkillsDir } = vi.hoisted(() => {
  const _path = require("path");
  const _os = require("os");
  return { tempSkillsDir: _path.join(_os.tmpdir(), `dotbot-default-skills-test-${Date.now()}`) };
});

// Mock SKILLS_DIR so we don't touch real ~/.bot/skills/
vi.mock("./store-core.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store-core.js")>();
  return {
    ...orig,
    SKILLS_DIR: tempSkillsDir,
  };
});

import { bootstrapDefaultSkills, DEFAULT_SKILLS } from "./default-skills.js";

beforeAll(async () => {
  await fs.mkdir(tempSkillsDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tempSkillsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const entries = await fs.readdir(tempSkillsDir).catch(() => []);
  for (const entry of entries) {
    await fs.rm(path.join(tempSkillsDir, entry as string), { recursive: true, force: true });
  }
});

// ============================================
// CONFIGURATION
// ============================================

describe("Default Skills — Configuration", () => {
  it("DEFAULT_SKILLS array is non-empty", () => {
    expect(DEFAULT_SKILLS.length).toBeGreaterThan(0);
  });

  it("each default skill has slug and promptFile", () => {
    for (const skill of DEFAULT_SKILLS) {
      expect(skill.slug).toBeTruthy();
      expect(skill.promptFile).toBeTruthy();
      expect(skill.promptFile.endsWith(".md")).toBe(true);
    }
  });

  it("each promptFile exists on disk in the default-content/skills/ directory", async () => {
    const { fileURLToPath } = await import("url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const skillsSrcDir = path.join(__dirname, "default-content", "skills");

    for (const skill of DEFAULT_SKILLS) {
      const srcPath = path.join(skillsSrcDir, skill.promptFile);
      const exists = await fs.access(srcPath).then(() => true).catch(() => false);
      expect(exists, `Missing skill source file: ${skill.promptFile}`).toBe(true);
    }
  });

  it("each supportFile exists on disk in the default-content/skills/ directory", async () => {
    const { fileURLToPath } = await import("url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const skillsSrcDir = path.join(__dirname, "default-content", "skills");

    for (const skill of DEFAULT_SKILLS) {
      if (!skill.supportFiles) continue;
      for (const sf of skill.supportFiles) {
        const sfPath = path.join(skillsSrcDir, sf.src);
        const exists = await fs.access(sfPath).then(() => true).catch(() => false);
        expect(exists, `Missing support file: ${sf.src} for skill ${skill.slug}`).toBe(true);
      }
    }
  });

  it("each skill source file contains valid SKILL.md frontmatter", async () => {
    const { fileURLToPath } = await import("url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const skillsSrcDir = path.join(__dirname, "default-content", "skills");

    for (const skill of DEFAULT_SKILLS) {
      const content = await fs.readFile(
        path.join(skillsSrcDir, skill.promptFile),
        "utf-8"
      );
      const normalized = content.replace(/\r\n/g, "\n");

      // Must have frontmatter delimiters
      expect(normalized.startsWith("---\n"), `${skill.promptFile}: missing opening ---`).toBe(true);
      expect(normalized.includes("\n---\n"), `${skill.promptFile}: missing closing ---`).toBe(true);

      // Must have required fields
      expect(normalized).toContain("name:");
      expect(normalized).toContain("description:");
    }
  });
});

// ============================================
// BOOTSTRAP
// ============================================

describe("Default Skills — Bootstrap", () => {
  it("creates skill directories on first run", async () => {
    const created = await bootstrapDefaultSkills();
    expect(created).toBe(DEFAULT_SKILLS.length);

    for (const skill of DEFAULT_SKILLS) {
      const skillMdPath = path.join(tempSkillsDir, skill.slug, "SKILL.md");
      const exists = await fs.access(skillMdPath).then(() => true).catch(() => false);
      expect(exists, `Missing SKILL.md for ${skill.slug}`).toBe(true);
    }
  });

  it("written SKILL.md matches the source file content", async () => {
    await bootstrapDefaultSkills();

    const { fileURLToPath } = await import("url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const skillsSrcDir = path.join(__dirname, "default-content", "skills");

    for (const skill of DEFAULT_SKILLS) {
      const expected = await fs.readFile(
        path.join(skillsSrcDir, skill.promptFile),
        "utf-8"
      );
      const actual = await fs.readFile(
        path.join(tempSkillsDir, skill.slug, "SKILL.md"),
        "utf-8"
      );
      expect(actual).toBe(expected);
    }
  });

  it("copies supporting files alongside SKILL.md", async () => {
    await bootstrapDefaultSkills();

    const { fileURLToPath } = await import("url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const skillsSrcDir = path.join(__dirname, "default-content", "skills");

    for (const skill of DEFAULT_SKILLS) {
      if (!skill.supportFiles) continue;
      for (const sf of skill.supportFiles) {
        const destPath = path.join(tempSkillsDir, skill.slug, sf.dest);
        const exists = await fs.access(destPath).then(() => true).catch(() => false);
        expect(exists, `Missing support file ${sf.dest} for skill ${skill.slug}`).toBe(true);

        // Verify content matches source
        const expected = await fs.readFile(path.join(skillsSrcDir, sf.src), "utf-8");
        const actual = await fs.readFile(destPath, "utf-8");
        expect(actual).toBe(expected);
      }
    }
  });

  it("is idempotent — second run creates 0 skills", async () => {
    const firstRun = await bootstrapDefaultSkills();
    expect(firstRun).toBe(DEFAULT_SKILLS.length);

    const secondRun = await bootstrapDefaultSkills();
    expect(secondRun).toBe(0);
  });

  it("does not overwrite user-modified SKILL.md", async () => {
    await bootstrapDefaultSkills();

    // Modify the file
    const skillMdPath = path.join(tempSkillsDir, DEFAULT_SKILLS[0].slug, "SKILL.md");
    await fs.writeFile(skillMdPath, "user modified content", "utf-8");

    // Run again
    await bootstrapDefaultSkills();

    // Should still have user's content
    const content = await fs.readFile(skillMdPath, "utf-8");
    expect(content).toBe("user modified content");
  });
});
