/**
 * Skill Operations — SKILL.md Standard
 * 
 * Skills are directories at ~/.bot/skills/{slug}/ containing a SKILL.md file
 * with YAML frontmatter and markdown instructions, following the Claude Code
 * skills standard.
 * 
 * Structure:
 *   ~/.bot/skills/{slug}/
 *   ├── SKILL.md          # Required: frontmatter + instructions
 *   ├── scripts/          # Optional: executable scripts
 *   ├── examples/         # Optional: example outputs
 *   └── reference.md      # Optional: detailed reference
 */

import * as path from "path";
import { promises as fs } from "fs";
import type {
  Skill,
  SkillFrontmatter,
  SkillIndexEntry,
} from "./types.js";
import {
  SKILLS_DIR,
  fileExists,
  slugify,
} from "./store-core.js";

// ============================================
// SKILL.md PARSING
// ============================================

/**
 * Parse SKILL.md content into frontmatter + body.
 */
function parseSkillMd(raw: string): { frontmatter: SkillFrontmatter; content: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const fmBlock = match[1];
  const content = match[2].trim();

  // Simple YAML parser for flat key-value frontmatter
  const fm: Record<string, any> = {};
  for (const line of fmBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = trimmed.substring(0, colonIdx).trim();
    let value: any = trimmed.substring(colonIdx + 1).trim();

    // Parse booleans
    if (value === "true") value = true;
    else if (value === "false") value = false;
    // Parse arrays (comma-separated or YAML-style)
    else if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s: string) => s.trim()).filter(Boolean);
    }

    fm[key] = value;
  }

  if (!fm.name || !fm.description) return null;

  return {
    frontmatter: fm as SkillFrontmatter,
    content,
  };
}

/**
 * Serialize a skill back to SKILL.md format.
 */
function serializeSkillMd(skill: Skill): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${skill.name}`);
  lines.push(`description: ${skill.description}`);
  if (skill.tags.length > 0) {
    lines.push(`tags: [${skill.tags.join(", ")}]`);
  }
  if (skill.disableModelInvocation) {
    lines.push(`disable-model-invocation: true`);
  }
  if (!skill.userInvocable) {
    lines.push(`user-invocable: false`);
  }
  if (skill.allowedTools.length > 0) {
    lines.push(`allowed-tools: [${skill.allowedTools.join(", ")}]`);
  }
  lines.push("---");
  lines.push("");
  lines.push(skill.content);
  return lines.join("\n");
}

// ============================================
// SKILL CRUD
// ============================================

export async function getSkill(slug: string): Promise<Skill | null> {
  const skillMdPath = path.join(SKILLS_DIR, slug, "SKILL.md");
  if (!await fileExists(skillMdPath)) return null;

  try {
    const raw = await fs.readFile(skillMdPath, "utf-8");
    const parsed = parseSkillMd(raw);
    if (!parsed) return null;

    const stat = await fs.stat(skillMdPath);
    const supportingFiles = await listSupportingFiles(slug);

    return {
      slug,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      content: parsed.content,
      tags: parsed.frontmatter.tags || [],
      disableModelInvocation: parsed.frontmatter["disable-model-invocation"] || false,
      userInvocable: parsed.frontmatter["user-invocable"] !== false,
      allowedTools: parsed.frontmatter["allowed-tools"] || [],
      supportingFiles,
      createdAt: stat.birthtime.toISOString(),
      lastUpdatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export async function getAllSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];
  try {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skill = await getSkill(entry.name);
      if (skill) skills.push(skill);
    }
  } catch {
    // Skills dir may not exist yet
  }
  return skills;
}

export async function saveSkill(skill: Skill): Promise<void> {
  const skillDir = path.join(SKILLS_DIR, skill.slug);
  await fs.mkdir(skillDir, { recursive: true });
  const skillMdPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillMdPath, serializeSkillMd(skill), "utf-8");
}

export async function createSkill(
  name: string,
  description: string,
  content: string,
  tags: string[],
  options?: {
    disableModelInvocation?: boolean;
    userInvocable?: boolean;
    allowedTools?: string[];
  }
): Promise<Skill> {
  const slug = slugify(name);
  const now = new Date().toISOString();

  // LLMs often send double-escaped strings where JSON.parse yields literal
  // backslash-n instead of real newlines. Normalize before storing.
  const normalizedContent = content.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  const normalizedDescription = description.replace(/\\n/g, "\n").replace(/\\t/g, "\t");

  const skill: Skill = {
    slug,
    name,
    description: normalizedDescription,
    content: normalizedContent,
    tags,
    disableModelInvocation: options?.disableModelInvocation || false,
    userInvocable: options?.userInvocable !== false,
    allowedTools: options?.allowedTools || [],
    supportingFiles: [],
    createdAt: now,
    lastUpdatedAt: now,
  };

  await saveSkill(skill);
  return skill;
}

export async function deleteSkill(slug: string): Promise<boolean> {
  const skillDir = path.join(SKILLS_DIR, slug);
  try {
    await fs.rm(skillDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ============================================
// SUPPORTING FILES
// ============================================

async function listSupportingFiles(slug: string): Promise<string[]> {
  const skillDir = path.join(SKILLS_DIR, slug);
  const files: string[] = [];
  try {
    const walk = async (dir: string, prefix: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.name === "SKILL.md") continue;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), rel);
        } else {
          files.push(rel);
        }
      }
    };
    await walk(skillDir, "");
  } catch {
    // Directory may not exist
  }
  return files;
}

export async function addSupportingFile(
  slug: string,
  relativePath: string,
  content: string
): Promise<void> {
  const filePath = path.join(SKILLS_DIR, slug, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

export async function readSupportingFile(
  slug: string,
  relativePath: string
): Promise<string | null> {
  const filePath = path.join(SKILLS_DIR, slug, relativePath);
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

// ============================================
// SEARCH
// ============================================

export async function searchSkills(query: string): Promise<SkillIndexEntry[]> {
  const skills = await getAllSkills();

  // Empty query returns all skills (used by planner to see full inventory)
  if (!query.trim()) {
    return skills.map(skill => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      allowedTools: skill.allowedTools,
      disableModelInvocation: skill.disableModelInvocation,
      userInvocable: skill.userInvocable,
    }));
  }

  const queryLower = query.toLowerCase();

  // Stop words: common English words that cause false matches
  // (e.g., "set" matching the "setup" tag, "how" matching content)
  const STOP_WORDS = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
    "her", "was", "one", "our", "out", "has", "his", "how", "its", "let",
    "may", "new", "now", "old", "see", "way", "who", "did", "get", "got",
    "him", "hit", "put", "say", "she", "too", "use", "set", "any", "try",
    "ask", "big", "few", "give", "also", "back", "been", "call", "come",
    "each", "find", "from", "have", "help", "here", "just", "know", "like",
    "make", "many", "much", "must", "need", "only", "over", "some", "such",
    "take", "tell", "than", "that", "them", "then", "they", "this", "want",
    "well", "what", "when", "will", "with", "work", "your", "about", "after",
    "being", "could", "every", "first", "other", "should", "their", "there",
    "these", "thing", "those", "using", "where", "which", "while", "would",
  ]);

  const queryWords = queryLower
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  return skills
    .map(skill => {
      let score = 0;

      if (skill.name.toLowerCase().includes(queryLower)) score += 10;
      if (skill.description.toLowerCase().includes(queryLower)) score += 5;

      for (const word of queryWords) {
        if (skill.tags.some(t => t.toLowerCase().includes(word))) score += 3;
        if (skill.content.toLowerCase().includes(word)) score += 1;
      }

      const entry: SkillIndexEntry = {
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        allowedTools: skill.allowedTools,
        disableModelInvocation: skill.disableModelInvocation,
        userInvocable: skill.userInvocable,
      };

      return { entry, score };
    })
    .filter(r => r.score >= 3)
    .sort((a, b) => b.score - a.score)
    .map(r => r.entry);
}
