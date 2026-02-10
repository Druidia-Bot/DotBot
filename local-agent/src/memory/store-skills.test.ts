/**
 * Store Skills — Production Tests
 * 
 * Tests the SKILL.md store: parsing, serialization, full CRUD lifecycle,
 * search, supporting files, and edge cases. Uses a temp directory to
 * avoid touching the real ~/.bot/skills/.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

const { tempSkillsDir } = vi.hoisted(() => {
  const _path = require("path");
  const _os = require("os");
  return { tempSkillsDir: _path.join(_os.tmpdir(), `dotbot-skills-test-${Date.now()}`) };
});

// Mock SKILLS_DIR to point to our temp directory
vi.mock("./store-core.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store-core.js")>();
  return {
    ...orig,
    SKILLS_DIR: tempSkillsDir,
  };
});

// Import AFTER mock is set up
import {
  getSkill, getAllSkills, saveSkill, createSkill, deleteSkill,
  searchSkills, addSupportingFile, readSupportingFile,
} from "./store-skills.js";
import type { Skill } from "./types.js";

// ============================================
// SETUP / TEARDOWN
// ============================================

beforeAll(async () => {
  await fs.mkdir(tempSkillsDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tempSkillsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean the temp skills dir between tests
  const entries = await fs.readdir(tempSkillsDir).catch(() => []);
  for (const entry of entries) {
    await fs.rm(path.join(tempSkillsDir, entry as string), { recursive: true, force: true });
  }
});

// ============================================
// HELPERS
// ============================================

function makeSkillMd(opts: {
  name: string;
  description: string;
  tags?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  content: string;
}): string {
  const lines = ["---"];
  lines.push(`name: ${opts.name}`);
  lines.push(`description: ${opts.description}`);
  if (opts.tags?.length) lines.push(`tags: [${opts.tags.join(", ")}]`);
  if (opts.disableModelInvocation) lines.push("disable-model-invocation: true");
  if (opts.userInvocable === false) lines.push("user-invocable: false");
  if (opts.allowedTools?.length) lines.push(`allowed-tools: [${opts.allowedTools.join(", ")}]`);
  lines.push("---");
  lines.push("");
  lines.push(opts.content);
  return lines.join("\n");
}

async function writeDiskSkill(slug: string, content: string): Promise<void> {
  const dir = path.join(tempSkillsDir, slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), content, "utf-8");
}

// ============================================
// EXPORTS
// ============================================

describe("Store Skills — Exports", () => {
  it("exports all CRUD functions", () => {
    expect(typeof getSkill).toBe("function");
    expect(typeof getAllSkills).toBe("function");
    expect(typeof saveSkill).toBe("function");
    expect(typeof createSkill).toBe("function");
    expect(typeof deleteSkill).toBe("function");
  });

  it("exports supporting file functions", () => {
    expect(typeof addSupportingFile).toBe("function");
    expect(typeof readSupportingFile).toBe("function");
  });

  it("exports search function", () => {
    expect(typeof searchSkills).toBe("function");
  });
});

// ============================================
// PARSING (via getSkill)
// ============================================

describe("SKILL.md Parsing", () => {
  it("parses minimal frontmatter (name + description only)", async () => {
    const md = makeSkillMd({
      name: "test-skill",
      description: "A test skill",
      content: "Do the thing.",
    });
    await writeDiskSkill("test-skill", md);

    const skill = await getSkill("test-skill");
    expect(skill).not.toBeNull();
    expect(skill!.slug).toBe("test-skill");
    expect(skill!.name).toBe("test-skill");
    expect(skill!.description).toBe("A test skill");
    expect(skill!.content).toBe("Do the thing.");
    expect(skill!.tags).toEqual([]);
    expect(skill!.disableModelInvocation).toBe(false);
    expect(skill!.userInvocable).toBe(true);
    expect(skill!.allowedTools).toEqual([]);
  });

  it("parses all frontmatter fields", async () => {
    const md = makeSkillMd({
      name: "full-skill",
      description: "Fully configured skill",
      tags: ["react", "ui", "design"],
      disableModelInvocation: true,
      userInvocable: false,
      allowedTools: ["Read", "Grep"],
      content: "# Full Skill\n\nInstructions here.",
    });
    await writeDiskSkill("full-skill", md);

    const skill = await getSkill("full-skill");
    expect(skill).not.toBeNull();
    expect(skill!.tags).toEqual(["react", "ui", "design"]);
    expect(skill!.disableModelInvocation).toBe(true);
    expect(skill!.userInvocable).toBe(false);
    expect(skill!.allowedTools).toEqual(["Read", "Grep"]);
    expect(skill!.content).toContain("# Full Skill");
    expect(skill!.content).toContain("Instructions here.");
  });

  it("handles CRLF line endings", async () => {
    const md = "---\r\nname: crlf-skill\r\ndescription: CRLF test\r\n---\r\n\r\nBody with CRLF.";
    await writeDiskSkill("crlf-skill", md);

    const skill = await getSkill("crlf-skill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("crlf-skill");
    expect(skill!.content).toBe("Body with CRLF.");
  });

  it("returns null for missing skill", async () => {
    const skill = await getSkill("nonexistent");
    expect(skill).toBeNull();
  });

  it("returns null for malformed frontmatter (no name)", async () => {
    const md = "---\ndescription: Missing name\n---\n\nContent.";
    await writeDiskSkill("bad-skill", md);

    const skill = await getSkill("bad-skill");
    expect(skill).toBeNull();
  });

  it("returns null for file without frontmatter delimiters", async () => {
    await writeDiskSkill("no-frontmatter", "Just some markdown content.");
    const skill = await getSkill("no-frontmatter");
    expect(skill).toBeNull();
  });

  it("preserves multi-line content with markdown formatting", async () => {
    const body = [
      "# Design System",
      "",
      "## Step 1",
      "- Use bold colors",
      "- Avoid Inter font",
      "",
      "## Step 2",
      "```css",
      ".hero { font-size: 4rem; }",
      "```",
    ].join("\n");
    const md = makeSkillMd({ name: "multiline", description: "test", content: body });
    await writeDiskSkill("multiline", md);

    const skill = await getSkill("multiline");
    expect(skill).not.toBeNull();
    expect(skill!.content).toContain("# Design System");
    expect(skill!.content).toContain("```css");
    expect(skill!.content).toContain(".hero { font-size: 4rem; }");
  });
});

// ============================================
// CRUD LIFECYCLE
// ============================================

describe("SKILL.md CRUD", () => {
  it("createSkill writes a valid SKILL.md to disk", async () => {
    const skill = await createSkill(
      "my-workflow",
      "A reusable workflow",
      "Follow these steps:\n1. Step one\n2. Step two",
      ["workflow", "automation"],
    );

    expect(skill.slug).toBe("my-workflow");
    expect(skill.name).toBe("my-workflow");

    // Verify file was written
    const diskContent = await fs.readFile(
      path.join(tempSkillsDir, "my-workflow", "SKILL.md"),
      "utf-8"
    );
    expect(diskContent).toContain("name: my-workflow");
    expect(diskContent).toContain("description: A reusable workflow");
    expect(diskContent).toContain("tags: [workflow, automation]");
    expect(diskContent).toContain("Follow these steps:");
  });

  it("createSkill with options sets frontmatter flags", async () => {
    const skill = await createSkill(
      "deploy",
      "Deploy to production",
      "Run tests, then deploy.",
      ["devops"],
      { disableModelInvocation: true },
    );

    expect(skill.disableModelInvocation).toBe(true);

    // Verify roundtrip
    const loaded = await getSkill("deploy");
    expect(loaded).not.toBeNull();
    expect(loaded!.disableModelInvocation).toBe(true);
  });

  it("saveSkill overwrites existing SKILL.md", async () => {
    await createSkill("mutable", "Original", "Version 1", ["v1"]);

    const skill = await getSkill("mutable");
    expect(skill).not.toBeNull();
    expect(skill!.content).toBe("Version 1");

    skill!.content = "Version 2";
    skill!.tags = ["v2"];
    await saveSkill(skill!);

    const updated = await getSkill("mutable");
    expect(updated!.content).toBe("Version 2");
    expect(updated!.tags).toEqual(["v2"]);
  });

  it("getAllSkills returns all skill directories", async () => {
    await createSkill("skill-a", "First", "Content A", ["a"]);
    await createSkill("skill-b", "Second", "Content B", ["b"]);
    await createSkill("skill-c", "Third", "Content C", ["c"]);

    const all = await getAllSkills();
    expect(all.length).toBe(3);

    const slugs = all.map(s => s.slug).sort();
    expect(slugs).toEqual(["skill-a", "skill-b", "skill-c"]);
  });

  it("getAllSkills returns empty array when no skills exist", async () => {
    const all = await getAllSkills();
    expect(all).toEqual([]);
  });

  it("getAllSkills skips directories without valid SKILL.md", async () => {
    await createSkill("valid", "Valid skill", "Content", []);
    // Create a directory without SKILL.md
    await fs.mkdir(path.join(tempSkillsDir, "orphan-dir"), { recursive: true });
    // Create a directory with malformed SKILL.md
    await writeDiskSkill("bad-frontmatter", "No frontmatter here.");

    const all = await getAllSkills();
    expect(all.length).toBe(1);
    expect(all[0].slug).toBe("valid");
  });

  it("deleteSkill removes the entire directory", async () => {
    await createSkill("to-delete", "Will be deleted", "Gone soon", ["temp"]);

    // Verify it exists
    const before = await getSkill("to-delete");
    expect(before).not.toBeNull();

    // Delete
    const result = await deleteSkill("to-delete");
    expect(result).toBe(true);

    // Verify gone
    const after = await getSkill("to-delete");
    expect(after).toBeNull();
  });

  it("deleteSkill returns true for nonexistent skill (idempotent)", async () => {
    const result = await deleteSkill("never-existed");
    expect(result).toBe(true);
  });

  it("createSkill → getSkill roundtrip preserves all fields", async () => {
    const original = await createSkill(
      "Roundtrip Test",
      "Tests full roundtrip",
      "Instructions:\n- Do this\n- Do that",
      ["test", "roundtrip"],
      { disableModelInvocation: true, allowedTools: ["Read", "Grep"] },
    );

    const loaded = await getSkill(original.slug);
    expect(loaded).not.toBeNull();
    expect(loaded!.slug).toBe(original.slug);
    expect(loaded!.name).toBe(original.name);
    expect(loaded!.description).toBe(original.description);
    expect(loaded!.content).toBe(original.content);
    expect(loaded!.tags).toEqual(original.tags);
    expect(loaded!.disableModelInvocation).toBe(original.disableModelInvocation);
    expect(loaded!.allowedTools).toEqual(original.allowedTools);
  });
});

// ============================================
// SUPPORTING FILES
// ============================================

describe("Supporting Files", () => {
  it("addSupportingFile creates file in skill directory", async () => {
    await createSkill("with-scripts", "Has scripts", "Use the script.", ["script"]);

    await addSupportingFile("with-scripts", "scripts/run.js", "console.log('hello');");

    const content = await readSupportingFile("with-scripts", "scripts/run.js");
    expect(content).toBe("console.log('hello');");
  });

  it("readSupportingFile returns null for nonexistent file", async () => {
    await createSkill("no-files", "No supporting files", "Content", []);
    const result = await readSupportingFile("no-files", "scripts/nope.js");
    expect(result).toBeNull();
  });

  it("supporting files appear in skill.supportingFiles", async () => {
    await createSkill("listed", "Listed files", "Content", []);
    await addSupportingFile("listed", "scripts/run.js", "code");
    await addSupportingFile("listed", "examples/sample.md", "example");
    await addSupportingFile("listed", "reference.md", "ref");

    const skill = await getSkill("listed");
    expect(skill).not.toBeNull();
    const files = skill!.supportingFiles.sort();
    expect(files).toEqual(["examples/sample.md", "reference.md", "scripts/run.js"]);
  });

  it("SKILL.md is NOT listed as a supporting file", async () => {
    await createSkill("no-self", "Test", "Content", []);
    const skill = await getSkill("no-self");
    expect(skill!.supportingFiles).not.toContain("SKILL.md");
  });
});

// ============================================
// SEARCH
// ============================================

describe("Skill Search", () => {
  beforeEach(async () => {
    // Seed three skills for search tests
    await createSkill("frontend-design", "Create beautiful frontends", "Typography, color theory, responsive layouts, and component architecture patterns.", ["frontend", "design", "ui"]);
    await createSkill("api-conventions", "REST API patterns", "Use RESTful naming.", ["api", "rest"]);
    await createSkill("deploy-prod", "Deploy to production", "Run tests first.", ["devops", "deploy"]);
  });

  it("finds skills by name match", async () => {
    const results = await searchSkills("frontend-design");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].slug).toBe("frontend-design");
  });

  it("finds skills by description match", async () => {
    const results = await searchSkills("REST API");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.slug === "api-conventions")).toBe(true);
  });

  it("finds skills by tag match", async () => {
    const results = await searchSkills("devops");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.slug === "deploy-prod")).toBe(true);
  });

  it("finds skills by content match (multi-word)", async () => {
    const results = await searchSkills("responsive layouts component architecture");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.slug === "frontend-design")).toBe(true);
  });

  it("rejects weak content-only matches (single word)", async () => {
    const results = await searchSkills("typography");
    expect(results).toEqual([]);
  });

  it("returns all skills when query is empty (planner inventory)", async () => {
    const results = await searchSkills("");
    expect(results.length).toBe(3);
    const slugs = results.map(r => r.slug).sort();
    expect(slugs).toEqual(["api-conventions", "deploy-prod", "frontend-design"]);
  });

  it("returns all skills when query is whitespace-only", async () => {
    const results = await searchSkills("   ");
    expect(results.length).toBe(3);
  });

  it("returns empty array for no matches", async () => {
    const results = await searchSkills("quantum-physics");
    expect(results).toEqual([]);
  });

  it("ranks name matches higher than content matches", async () => {
    const results = await searchSkills("deploy");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // "deploy-prod" has "deploy" in both name and tags — should rank first
    expect(results[0].slug).toBe("deploy-prod");
  });

  it("returns SkillIndexEntry shape (no content field)", async () => {
    const results = await searchSkills("frontend");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const entry = results[0];
    expect(entry).toHaveProperty("slug");
    expect(entry).toHaveProperty("name");
    expect(entry).toHaveProperty("description");
    expect(entry).toHaveProperty("tags");
    expect(entry).toHaveProperty("allowedTools");
    expect(entry).toHaveProperty("disableModelInvocation");
    expect(entry).toHaveProperty("userInvocable");
    expect(entry).not.toHaveProperty("content");
  });
});
