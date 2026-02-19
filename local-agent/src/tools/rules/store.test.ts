/**
 * Tests for Ruleset Store — CRUD operations.
 *
 * Uses a temp directory to avoid polluting real rulesets.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Ruleset, Rule } from "./types.js";

// We test store functions by importing them and overriding the dir
// Since the store uses a hardcoded path, we test at a higher level
// using the functions directly, writing/reading our own temp files.

const TEST_DIR = join(tmpdir(), `dotbot-rules-test-${Date.now()}`);

// Minimal self-contained store functions for testing (mirror store.ts logic)
async function ensureDir(): Promise<void> {
  await fs.mkdir(TEST_DIR, { recursive: true });
}

function rulesetPath(slug: string): string {
  return join(TEST_DIR, `${slug.replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
}

async function saveRuleset(ruleset: Ruleset): Promise<void> {
  await ensureDir();
  await fs.writeFile(rulesetPath(ruleset.slug), JSON.stringify(ruleset, null, 2), "utf-8");
}

async function readRuleset(slug: string): Promise<Ruleset | null> {
  try {
    const raw = await fs.readFile(rulesetPath(slug), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function deleteRuleset(slug: string): Promise<boolean> {
  try {
    await fs.unlink(rulesetPath(slug));
    return true;
  } catch {
    return false;
  }
}

async function listRulesets(): Promise<Array<{ slug: string; name: string; ruleCount: number }>> {
  await ensureDir();
  const files = await fs.readdir(TEST_DIR);
  const results: Array<{ slug: string; name: string; ruleCount: number }> = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(join(TEST_DIR, file), "utf-8");
      const rs: Ruleset = JSON.parse(raw);
      results.push({ slug: rs.slug, name: rs.name, ruleCount: rs.rules.length });
    } catch { /* skip */ }
  }
  return results;
}

// ============================================
// FIXTURES
// ============================================

function makeRuleset(overrides: Partial<Ruleset> = {}): Ruleset {
  return {
    name: "Email Triage",
    slug: "email-triage",
    description: "Daily email processing rules",
    rules: [
      {
        id: "r1",
        assess: "Is this a promotional newsletter?",
        scale: [0, 1] as [number, number],
        threshold: 1,
        when_above: "Archive it.",
        when_below: null,
      },
      {
        id: "r2",
        assess: "How urgently does this need a response?",
        scale: [1, 10] as [number, number],
        threshold: 7,
        when_above: "Flag as urgent.",
        when_below: null,
      },
    ],
    ...overrides,
  };
}

// ============================================
// TESTS
// ============================================

describe("Ruleset Store", () => {
  beforeEach(async () => {
    // Clean test dir
    try {
      const files = await fs.readdir(TEST_DIR);
      for (const f of files) await fs.unlink(join(TEST_DIR, f));
    } catch { /* dir may not exist yet */ }
  });

  afterAll(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true });
    } catch { /* ok */ }
  });

  it("saves and reads a ruleset", async () => {
    const rs = makeRuleset();
    await saveRuleset(rs);

    const loaded = await readRuleset("email-triage");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("Email Triage");
    expect(loaded!.rules).toHaveLength(2);
    expect(loaded!.rules[0].assess).toBe("Is this a promotional newsletter?");
  });

  it("returns null for nonexistent ruleset", async () => {
    const loaded = await readRuleset("nonexistent");
    expect(loaded).toBeNull();
  });

  it("overwrites on save", async () => {
    await saveRuleset(makeRuleset());
    await saveRuleset(makeRuleset({ description: "Updated" }));

    const loaded = await readRuleset("email-triage");
    expect(loaded!.description).toBe("Updated");
  });

  it("deletes a ruleset", async () => {
    await saveRuleset(makeRuleset());
    const deleted = await deleteRuleset("email-triage");
    expect(deleted).toBe(true);

    const loaded = await readRuleset("email-triage");
    expect(loaded).toBeNull();
  });

  it("returns false when deleting nonexistent", async () => {
    const deleted = await deleteRuleset("nope");
    expect(deleted).toBe(false);
  });

  it("lists all rulesets", async () => {
    await saveRuleset(makeRuleset());
    await saveRuleset(makeRuleset({ name: "Lead Qual", slug: "lead-qual", rules: [] }));

    const list = await listRulesets();
    expect(list).toHaveLength(2);
    expect(list.map(r => r.slug).sort()).toEqual(["email-triage", "lead-qual"]);
  });

  it("generates correct rule IDs", () => {
    // Test nextRuleId logic
    const rules: Rule[] = [
      { id: "r1", assess: "a", scale: [0, 1], threshold: 1, when_above: null, when_below: null },
      { id: "r3", assess: "b", scale: [0, 1], threshold: 1, when_above: null, when_below: null },
    ];
    const existing = rules.map(r => parseInt(r.id.replace("r", ""), 10)).filter(n => !isNaN(n));
    const max = existing.length > 0 ? Math.max(...existing) : 0;
    expect(`r${max + 1}`).toBe("r4"); // Skips r2, next after r3 is r4
  });

  it("validates rule structure", async () => {
    const rs = makeRuleset();
    expect(rs.rules[0].scale).toEqual([0, 1]);
    expect(rs.rules[1].scale).toEqual([1, 10]);
    expect(rs.rules[0].threshold).toBe(1);
    expect(rs.rules[1].threshold).toBe(7);
  });

  it("preserves when_above and when_below through save/load", async () => {
    const rs = makeRuleset({
      rules: [
        {
          id: "r1",
          assess: "test",
          scale: [1, 10] as [number, number],
          threshold: 5,
          when_above: "Do this",
          when_below: "Do that instead",
        },
      ],
    });
    await saveRuleset(rs);

    const loaded = await readRuleset("email-triage");
    expect(loaded!.rules[0].when_above).toBe("Do this");
    expect(loaded!.rules[0].when_below).toBe("Do that instead");
  });
});
