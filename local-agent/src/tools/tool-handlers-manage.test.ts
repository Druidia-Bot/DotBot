/**
 * Tool Handlers — Skills Management — Production Tests
 * 
 * Tests handleSkillsManagement: save, list, read, delete skill handlers.
 * Uses a temp directory to avoid touching real ~/.bot/skills/.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

const { tempSkillsDir } = vi.hoisted(() => {
  const _path = require("path");
  const _os = require("os");
  return { tempSkillsDir: _path.join(_os.tmpdir(), `dotbot-handler-skills-test-${Date.now()}`) };
});

// Mock SKILLS_DIR before any imports that use it
vi.mock("../memory/store-core.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../memory/store-core.js")>();
  return {
    ...orig,
    SKILLS_DIR: tempSkillsDir,
  };
});

import { handleSkillsManagement } from "./tool-handlers-manage.js";
import { createSkill, getSkill, addSupportingFile } from "../memory/store-skills.js";

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
  const entries = await fs.readdir(tempSkillsDir).catch(() => []);
  for (const entry of entries) {
    await fs.rm(path.join(tempSkillsDir, entry as string), { recursive: true, force: true });
  }
});

// ============================================
// skills.save_skill
// ============================================

describe("handleSkillsManagement — save_skill", () => {
  it("creates a new skill and returns success", async () => {
    const result = await handleSkillsManagement("skills.save_skill", {
      name: "test-save",
      description: "A test skill",
      content: "Do the thing.",
      tags: "tag1, tag2",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Saved skill");
    expect(result.output).toContain("test-save");
    expect(result.output).toContain("tag1");

    // Verify it was actually written
    const skill = await getSkill("test-save");
    expect(skill).not.toBeNull();
    expect(skill!.content).toBe("Do the thing.");
  });

  it("handles tags as an array", async () => {
    const result = await handleSkillsManagement("skills.save_skill", {
      name: "array-tags",
      description: "Tags as array",
      content: "Content.",
      tags: ["a", "b", "c"],
    });

    expect(result.success).toBe(true);
    const skill = await getSkill("array-tags");
    expect(skill!.tags).toEqual(["a", "b", "c"]);
  });

  it("handles missing tags gracefully", async () => {
    const result = await handleSkillsManagement("skills.save_skill", {
      name: "no-tags",
      description: "No tags",
      content: "Content.",
    });

    expect(result.success).toBe(true);
    const skill = await getSkill("no-tags");
    expect(skill!.tags).toEqual([]);
  });

  it("fails when name is missing", async () => {
    const result = await handleSkillsManagement("skills.save_skill", {
      description: "No name",
      content: "Content.",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("name");
  });

  it("fails when description is missing", async () => {
    const result = await handleSkillsManagement("skills.save_skill", {
      name: "missing-desc",
      content: "Content.",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("description");
  });

  it("fails when content is missing", async () => {
    const result = await handleSkillsManagement("skills.save_skill", {
      name: "missing-content",
      description: "No content",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("content");
  });

  it("overwrites an existing skill with the same name", async () => {
    await handleSkillsManagement("skills.save_skill", {
      name: "overwrite-me",
      description: "Version 1",
      content: "Original.",
    });

    await handleSkillsManagement("skills.save_skill", {
      name: "overwrite-me",
      description: "Version 2",
      content: "Updated.",
    });

    const skill = await getSkill("overwrite-me");
    expect(skill!.description).toBe("Version 2");
    expect(skill!.content).toBe("Updated.");
  });
});

// ============================================
// skills.list_skills
// ============================================

describe("handleSkillsManagement — list_skills", () => {
  it("returns 'No skills found' when empty", async () => {
    const result = await handleSkillsManagement("skills.list_skills", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("No skills found");
  });

  it("lists all skills with slugs and descriptions", async () => {
    await createSkill("skill-alpha", "Alpha skill", "Alpha content", ["a"]);
    await createSkill("skill-beta", "Beta skill", "Beta content", ["b"]);

    const result = await handleSkillsManagement("skills.list_skills", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("2 skills");
    expect(result.output).toContain("/skill-alpha");
    expect(result.output).toContain("/skill-beta");
    expect(result.output).toContain("Alpha skill");
    expect(result.output).toContain("Beta skill");
  });

  it("shows tags in listing", async () => {
    await createSkill("tagged", "Tagged skill", "Content", ["react", "ui"]);

    const result = await handleSkillsManagement("skills.list_skills", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("react");
    expect(result.output).toContain("ui");
  });

  it("shows flags for special skills", async () => {
    await createSkill("deploy", "Deploy", "Content", [], { disableModelInvocation: true });

    const result = await handleSkillsManagement("skills.list_skills", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("user-only");
  });

  it("filters by query when provided", async () => {
    await createSkill("frontend-design", "Design frontends", "Typography", ["frontend", "design"]);
    await createSkill("api-conventions", "API patterns", "REST", ["api"]);

    const result = await handleSkillsManagement("skills.list_skills", { query: "frontend" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("frontend-design");
    // api-conventions should not match "frontend"
    expect(result.output).not.toContain("api-conventions");
  });
});

// ============================================
// skills.read_skill
// ============================================

describe("handleSkillsManagement — read_skill", () => {
  it("returns full skill content", async () => {
    await createSkill("readable", "A readable skill", "# Instructions\n\nDo this, then that.", ["test"]);

    const result = await handleSkillsManagement("skills.read_skill", { slug: "readable" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("# /readable");
    expect(result.output).toContain("A readable skill");
    expect(result.output).toContain("# Instructions");
    expect(result.output).toContain("Do this, then that.");
  });

  it("shows tags in output", async () => {
    await createSkill("with-tags", "Tagged", "Content", ["design", "ui"]);

    const result = await handleSkillsManagement("skills.read_skill", { slug: "with-tags" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("design, ui");
  });

  it("shows supporting files when present", async () => {
    await createSkill("with-files", "Has files", "Content", []);
    await addSupportingFile("with-files", "scripts/run.js", "code");

    const result = await handleSkillsManagement("skills.read_skill", { slug: "with-files" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("scripts/run.js");
  });

  it("fails when slug is missing", async () => {
    const result = await handleSkillsManagement("skills.read_skill", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("slug");
  });

  it("fails for nonexistent skill", async () => {
    const result = await handleSkillsManagement("skills.read_skill", { slug: "ghost" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

// ============================================
// skills.delete_skill
// ============================================

describe("handleSkillsManagement — delete_skill", () => {
  it("deletes an existing skill", async () => {
    await createSkill("doomed", "Will be deleted", "Goodbye", []);

    const result = await handleSkillsManagement("skills.delete_skill", { slug: "doomed" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Deleted");
    expect(result.output).toContain("doomed");

    // Verify it's gone
    const skill = await getSkill("doomed");
    expect(skill).toBeNull();
  });

  it("fails when slug is missing", async () => {
    const result = await handleSkillsManagement("skills.delete_skill", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("slug");
  });

  it("fails for nonexistent skill", async () => {
    const result = await handleSkillsManagement("skills.delete_skill", { slug: "nope" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

// ============================================
// UNKNOWN TOOL
// ============================================

describe("handleSkillsManagement — unknown tool", () => {
  it("returns error for unknown tool ID", async () => {
    const result = await handleSkillsManagement("skills.unknown_action", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown");
  });
});
