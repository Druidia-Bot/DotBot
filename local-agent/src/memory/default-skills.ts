/**
 * Default Skills — Bootstrapped SKILL.md files
 * 
 * Skills that ship with DotBot. Written to ~/.bot/skills/{slug}/SKILL.md
 * on first startup if they don't already exist.
 * 
 * Version tracking: each skill has a version number. When the source version
 * is newer than the installed version, the skill is updated on disk automatically.
 * Version is stored in {slug}/.version alongside SKILL.md.
 * 
 * Skill content lives in separate .md files under default-content/skills/.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { SKILLS_DIR, fileExists } from "./store-core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_SRC_DIR = path.join(__dirname, "default-content", "skills");

export interface DefaultSkill {
  slug: string;
  /** Filename in default-content/skills/ directory (e.g. "frontend-design-skill.md") */
  promptFile: string;
  /** Version number — bump this when the source .md changes to trigger an update on disk */
  version: number;
  /** Optional supporting files to copy alongside SKILL.md (e.g. reference docs) */
  supportFiles?: { src: string; dest: string }[];
}

export const DEFAULT_SKILLS: DefaultSkill[] = [
  { slug: "frontend-design", version: 1, promptFile: "frontend-design-skill.md" },
  { slug: "self-improvement", version: 1, promptFile: "self-improvement-skill.md" },
  {
    slug: "discord-setup",
    version: 6, // v6: only MESSAGE CONTENT INTENT needed (removed SERVER MEMBERS INTENT)
    promptFile: "discord-setup-skill.md",
    supportFiles: [
      { src: "discord-setup-reference.md", dest: "reference.md" },
    ],
  },
  { slug: "brave-search-setup", version: 1, promptFile: "brave-search-setup-skill.md" },
  { slug: "tool-creation", version: 1, promptFile: "tool-creation-skill.md" },
  { slug: "claude-code-setup", version: 1, promptFile: "claude-code-setup-skill.md" },
  { slug: "codex-setup", version: 1, promptFile: "codex-setup-skill.md" },
  { slug: "temp-email", version: 1, promptFile: "temp-email-skill.md" },
];

/**
 * Bootstrap default skills — creates or updates SKILL.md files on disk.
 * 
 * - New skill (no SKILL.md): creates the skill directory + files.
 * - Outdated skill (version mismatch): overwrites SKILL.md + support files.
 * - Current skill (version matches): skipped.
 * 
 * Reads content from default-content/skills/*.md source files.
 */
export async function bootstrapDefaultSkills(): Promise<number> {
  let changed = 0;

  for (const skill of DEFAULT_SKILLS) {
    const skillDir = path.join(SKILLS_DIR, skill.slug);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const versionPath = path.join(skillDir, ".version");

    const exists = await fileExists(skillMdPath);
    const installedVersion = await readInstalledVersion(versionPath);
    const needsUpdate = !exists || installedVersion < skill.version;

    if (!needsUpdate) continue;

    try {
      const srcPath = path.join(SKILLS_SRC_DIR, skill.promptFile);
      const content = await fs.readFile(srcPath, "utf-8");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(skillMdPath, content, "utf-8");
      await fs.writeFile(versionPath, String(skill.version), "utf-8");

      // Copy supporting files (reference docs, scripts, examples)
      if (skill.supportFiles) {
        for (const sf of skill.supportFiles) {
          const sfSrc = path.join(SKILLS_SRC_DIR, sf.src);
          const sfDest = path.join(skillDir, sf.dest);
          await fs.mkdir(path.dirname(sfDest), { recursive: true });
          await fs.copyFile(sfSrc, sfDest);
        }
      }

      const action = exists ? `updated v${installedVersion}→v${skill.version}` : "created";
      console.log(`[Bootstrap] Skill ${skill.slug}: ${action}`);
      changed++;
    } catch (err) {
      console.warn(`[Bootstrap] Failed to write skill ${skill.slug}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (changed > 0) {
    console.log(`[Bootstrap] ${changed} default skill(s) created/updated`);
  }

  return changed;
}

async function readInstalledVersion(versionPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(versionPath, "utf-8");
    const v = parseInt(raw.trim(), 10);
    return isNaN(v) ? 0 : v;
  } catch {
    return 0;
  }
}
