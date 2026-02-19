/**
 * Ruleset Store — CRUD for ~/.bot/rulesets/*.json
 *
 * Pure filesystem operations. No LLM calls. No network.
 * Each ruleset is a single JSON file named by slug.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Ruleset, Rule } from "./types.js";

const RULESETS_DIR = join(homedir(), ".bot", "rulesets");

// ============================================
// INIT
// ============================================

async function ensureDir(): Promise<void> {
  await fs.mkdir(RULESETS_DIR, { recursive: true });
}

function rulesetPath(slug: string): string {
  // Sanitize slug to prevent path traversal
  const safe = slug.replace(/[^a-zA-Z0-9_-]/g, "");
  return join(RULESETS_DIR, `${safe}.json`);
}

// ============================================
// LIST
// ============================================

export async function listRulesets(): Promise<Array<{ slug: string; name: string; description: string; ruleCount: number }>> {
  await ensureDir();
  const files = await fs.readdir(RULESETS_DIR);
  const results: Array<{ slug: string; name: string; description: string; ruleCount: number }> = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(join(RULESETS_DIR, file), "utf-8");
      const ruleset: Ruleset = JSON.parse(raw);
      results.push({
        slug: ruleset.slug,
        name: ruleset.name,
        description: ruleset.description,
        ruleCount: ruleset.rules.length,
      });
    } catch {
      // Skip malformed files
    }
  }

  return results;
}

// ============================================
// READ
// ============================================

export async function readRuleset(slug: string): Promise<Ruleset | null> {
  try {
    const raw = await fs.readFile(rulesetPath(slug), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ============================================
// SAVE (full overwrite — used after conflict resolution)
// ============================================

export async function saveRuleset(ruleset: Ruleset): Promise<void> {
  await ensureDir();
  await fs.writeFile(rulesetPath(ruleset.slug), JSON.stringify(ruleset, null, 2), "utf-8");
}

// ============================================
// DELETE
// ============================================

export async function deleteRuleset(slug: string): Promise<boolean> {
  try {
    await fs.unlink(rulesetPath(slug));
    return true;
  } catch {
    return false;
  }
}

// ============================================
// ADD RULE
// ============================================

/** Generate the next rule ID (r1, r2, ...). */
function nextRuleId(rules: Rule[]): string {
  const existing = rules
    .map(r => parseInt(r.id.replace("r", ""), 10))
    .filter(n => !isNaN(n));
  const max = existing.length > 0 ? Math.max(...existing) : 0;
  return `r${max + 1}`;
}

/**
 * Add a rule to a ruleset. Assigns an auto-generated ID.
 * Returns the updated ruleset and the new rule's ID.
 * Does NOT run conflict check — caller is responsible.
 */
export async function addRule(
  slug: string,
  rule: Omit<Rule, "id">,
): Promise<{ ruleset: Ruleset; ruleId: string }> {
  const ruleset = await readRuleset(slug);
  if (!ruleset) throw new Error(`Ruleset "${slug}" not found`);

  const ruleId = nextRuleId(ruleset.rules);
  const newRule: Rule = { id: ruleId, ...rule };
  ruleset.rules.push(newRule);

  await saveRuleset(ruleset);
  return { ruleset, ruleId };
}

// ============================================
// REMOVE RULE
// ============================================

export async function removeRule(slug: string, ruleId: string): Promise<Ruleset> {
  const ruleset = await readRuleset(slug);
  if (!ruleset) throw new Error(`Ruleset "${slug}" not found`);

  const before = ruleset.rules.length;
  ruleset.rules = ruleset.rules.filter(r => r.id !== ruleId);

  if (ruleset.rules.length === before) {
    throw new Error(`Rule "${ruleId}" not found in ruleset "${slug}"`);
  }

  await saveRuleset(ruleset);
  return ruleset;
}

// ============================================
// EDIT RULE (remove + add — goes through conflict detection externally)
// ============================================

/**
 * Edit an existing rule. Returns the ruleset WITHOUT the old rule
 * so the caller can run conflict detection on the new version
 * against remaining rules, then add it back.
 */
export async function removeRuleForEdit(
  slug: string,
  ruleId: string,
): Promise<{ ruleset: Ruleset; removedRule: Rule }> {
  const ruleset = await readRuleset(slug);
  if (!ruleset) throw new Error(`Ruleset "${slug}" not found`);

  const removedRule = ruleset.rules.find(r => r.id === ruleId);
  if (!removedRule) throw new Error(`Rule "${ruleId}" not found in ruleset "${slug}"`);

  ruleset.rules = ruleset.rules.filter(r => r.id !== ruleId);
  return { ruleset, removedRule };
}

/**
 * Re-insert a rule after edit + conflict check.
 */
export async function insertRule(slug: string, rule: Rule): Promise<Ruleset> {
  const ruleset = await readRuleset(slug);
  if (!ruleset) throw new Error(`Ruleset "${slug}" not found`);

  ruleset.rules.push(rule);
  await saveRuleset(ruleset);
  return ruleset;
}

/** Get the rulesets directory path. */
export function getRulesetsDir(): string {
  return RULESETS_DIR;
}
