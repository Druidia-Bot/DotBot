/**
 * Startup Validator
 * 
 * Runs on local-agent startup to:
 * 1. Scan all council .md files — validate frontmatter, auto-fix CRLF
 * 2. Scan all persona directories — validate persona.json structure
 * 3. Rebuild index.json for both from actual files on disk
 * 4. Report malformed files clearly so the user can fix them
 * 
 * The index.json files are the source of truth for the system's knowledge
 * of what councils and personas exist. They MUST stay in sync with disk.
 * This validator ensures that by regenerating them every startup.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type {
  CouncilsIndex,
  CouncilIndexEntry,
  PersonasIndex,
  PersonaIndexEntry,
  Persona,
} from "./types.js";

// ============================================
// PATHS
// ============================================

const DOTBOT_DIR = path.join(os.homedir(), ".bot");
const COUNCILS_DIR = path.join(DOTBOT_DIR, "councils");
const PERSONAS_DIR = path.join(DOTBOT_DIR, "personas");
const COUNCILS_INDEX_PATH = path.join(COUNCILS_DIR, "index.json");
const PERSONAS_INDEX_PATH = path.join(PERSONAS_DIR, "index.json");

// ============================================
// TYPES
// ============================================

export interface MalformedFile {
  filePath: string;
  fileType: "persona" | "council";
  content: string;
  errors: string[];
}

export interface ValidationResult {
  councilsScanned: number;
  councilsValid: number;
  councilsFixed: number;
  councilErrors: string[];
  personasScanned: number;
  personasValid: number;
  personasFixed: number;
  personaErrors: string[];
  personaMdScanned: number;
  personaMdValid: number;
  personaMdErrors: string[];
  malformedFiles: MalformedFile[];
  indexesRebuilt: boolean;
}

interface CouncilFrontmatter {
  slug: string;
  name: string;
  handles: string[];
  tags: string[];
}

// ============================================
// COUNCIL VALIDATION
// ============================================

/**
 * Parse council frontmatter from a .md file.
 * Returns null if the file can't be parsed.
 */
function parseCouncilFrontmatter(content: string): CouncilFrontmatter | null {
  // Normalize CRLF → LF
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const fm = match[1];
  const body = match[2];

  const slug = fm.match(/slug:\s*(.+)/)?.[1]?.trim();
  const name = fm.match(/name:\s*(.+)/)?.[1]?.trim();
  if (!slug || !name) return null;

  // Parse YAML list (handles/tags)
  const parseList = (key: string): string[] => {
    const listMatch = fm.match(new RegExp(`${key}:\\n([\\s\\S]*?)(?=\\n[a-z]+:|$)`));
    if (!listMatch) return [];
    return listMatch[1]
      .split("\n")
      .filter(l => l.trim().startsWith("-"))
      .map(l => l.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean);
  };

  // Extract mission from body
  const missionMatch = body.match(/## Mission\n\n([\s\S]*?)(?=\n## |$)/);
  const mission = missionMatch?.[1]?.trim() || "";

  // Count members
  const memberMatches = body.match(/### \d+\. @\S+ — .+/g);
  const memberCount = memberMatches?.length || 0;

  return {
    slug,
    name,
    handles: parseList("handles"),
    tags: parseList("tags"),
  };
}

/**
 * Extract an index entry from a council .md file.
 */
function councilFileToIndexEntry(content: string, filename: string): CouncilIndexEntry | null {
  const fm = parseCouncilFrontmatter(content);
  if (!fm) return null;

  // Normalize CRLF for body parsing
  const normalized = content.replace(/\r\n/g, "\n");
  const bodyMatch = normalized.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  const body = bodyMatch?.[1] || "";

  // Extract mission from body
  const missionMatch = body.match(/## Mission\n\n([\s\S]*?)(?=\n## |$)/);
  const mission = missionMatch?.[1]?.trim() || "";

  // Count members
  const memberMatches = body.match(/### \d+\. @\S+ — .+/g);
  const memberCount = memberMatches?.length || 0;

  return {
    slug: fm.slug,
    name: fm.name,
    mission,
    memberCount,
    handles: fm.handles,
  };
}

/**
 * Scan all council .md files, validate, auto-fix CRLF, rebuild index.
 */
async function validateCouncils(result: ValidationResult): Promise<void> {
  try {
    await fs.mkdir(COUNCILS_DIR, { recursive: true });
  } catch { /* exists */ }

  let files: string[];
  try {
    files = (await fs.readdir(COUNCILS_DIR)).filter(f => f.endsWith(".md"));
  } catch {
    files = [];
  }

  const indexEntries: CouncilIndexEntry[] = [];

  for (const file of files) {
    result.councilsScanned++;
    const filePath = path.join(COUNCILS_DIR, file);

    try {
      let content = await fs.readFile(filePath, "utf-8");

      // Auto-fix: normalize CRLF → LF in the actual file
      if (content.includes("\r\n")) {
        content = content.replace(/\r\n/g, "\n");
        await fs.writeFile(filePath, content, "utf-8");
        result.councilsFixed++;
      }

      const entry = councilFileToIndexEntry(content, file);
      if (entry) {
        indexEntries.push(entry);
        result.councilsValid++;
      } else {
        const errMsg = `Missing or malformed frontmatter (need slug, name, --- delimiters)`;
        result.councilErrors.push(`${file}: ${errMsg}`);
        result.malformedFiles.push({
          filePath: filePath,
          fileType: "council",
          content,
          errors: [errMsg],
        });
      }
    } catch (err) {
      result.councilErrors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rebuild index.json from disk
  const index: CouncilsIndex = {
    version: "1.0.0",
    lastUpdatedAt: new Date().toISOString(),
    councils: indexEntries,
  };
  await fs.writeFile(COUNCILS_INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}

// ============================================
// PERSONA .MD VALIDATION
// ============================================

/**
 * Required frontmatter fields for a persona .md file.
 */
const PERSONA_MD_REQUIRED_FIELDS = ["id", "name", "modelTier", "description", "tools"];
const VALID_MODEL_TIERS = ["fast", "smart", "powerful"];

/**
 * Validate a single persona .md file. Returns errors found (empty = valid).
 */
function validatePersonaMd(content: string, filename: string): string[] {
  const errors: string[] = [];

  // Normalize CRLF for parsing
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    errors.push("Missing or malformed --- frontmatter delimiters");
    return errors;
  }

  const [, yamlStr, body] = match;

  // Parse frontmatter keys
  const fm: Record<string, string> = {};
  for (const line of yamlStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
  }

  // Check required fields
  for (const field of PERSONA_MD_REQUIRED_FIELDS) {
    if (!fm[field]) {
      errors.push(`missing required field '${field}'`);
    }
  }

  // Validate modelTier value
  if (fm.modelTier && !VALID_MODEL_TIERS.includes(fm.modelTier)) {
    errors.push(`invalid modelTier '${fm.modelTier}' (must be fast|smart|powerful)`);
  }

  // Check that tools looks like an array
  if (fm.tools && !fm.tools.startsWith("[")) {
    errors.push(`'tools' should be an array like [tool1, tool2] or []`);
  }

  // Body must have content (systemPrompt)
  if (!body.trim()) {
    errors.push("missing body content (systemPrompt)");
  }

  return errors;
}

/**
 * Scan all persona .md files, validate frontmatter and body.
 */
async function validatePersonaMdFiles(result: ValidationResult): Promise<void> {
  let files: string[];
  try {
    files = (await fs.readdir(PERSONAS_DIR)).filter(f => f.endsWith(".md"));
  } catch {
    files = [];
  }

  for (const file of files) {
    result.personaMdScanned++;
    const filePath = path.join(PERSONAS_DIR, file);

    try {
      let content = await fs.readFile(filePath, "utf-8");

      // Auto-fix CRLF
      if (content.includes("\r\n")) {
        content = content.replace(/\r\n/g, "\n");
        await fs.writeFile(filePath, content, "utf-8");
      }

      const errors = validatePersonaMd(content, file);
      if (errors.length === 0) {
        result.personaMdValid++;
      } else {
        result.personaMdErrors.push(`${file}: ${errors.join(", ")}`);
        result.malformedFiles.push({
          filePath,
          fileType: "persona",
          content,
          errors,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.personaMdErrors.push(`${file}: ${errMsg}`);
    }
  }
}

// ============================================
// PERSONA DIRECTORY VALIDATION
// ============================================

/**
 * Validate a persona.json file has the required fields.
 */
function validatePersonaJson(persona: any): string[] {
  const errors: string[] = [];
  if (!persona.slug) errors.push("missing 'slug'");
  if (!persona.name) errors.push("missing 'name'");
  if (!persona.systemPrompt) errors.push("missing 'systemPrompt'");
  if (!persona.role) errors.push("missing 'role'");
  return errors;
}

/**
 * Build an index entry from a persona.json.
 */
function personaToIndexEntry(persona: Persona): PersonaIndexEntry {
  return {
    slug: persona.slug,
    name: persona.name,
    role: persona.role || "",
    modelTier: persona.modelTier || "smart",
    knowledgeFileCount: persona.knowledgeFiles?.length || 0,
  };
}

/**
 * Scan all persona directories, validate persona.json, rebuild index.
 */
async function validatePersonas(result: ValidationResult): Promise<void> {
  try {
    await fs.mkdir(PERSONAS_DIR, { recursive: true });
  } catch { /* exists */ }

  let entries: string[];
  try {
    entries = await fs.readdir(PERSONAS_DIR);
  } catch {
    entries = [];
  }

  const indexEntries: PersonaIndexEntry[] = [];

  for (const entry of entries) {
    // Skip index.json and non-directories
    if (entry === "index.json") continue;

    const entryPath = path.join(PERSONAS_DIR, entry);
    let stat;
    try {
      stat = await fs.stat(entryPath);
    } catch { continue; }
    if (!stat.isDirectory()) continue;

    result.personasScanned++;
    const personaPath = path.join(entryPath, "persona.json");

    try {
      const content = await fs.readFile(personaPath, "utf-8");
      const persona = JSON.parse(content) as Persona;

      const fieldErrors = validatePersonaJson(persona);
      if (fieldErrors.length > 0) {
        result.personaErrors.push(`${entry}/persona.json: ${fieldErrors.join(", ")}`);
        continue;
      }

      // Sync knowledgeFiles array with actual files on disk
      const knowledgeDir = path.join(entryPath, "knowledge");
      let knowledgeFiles: string[] = [];
      try {
        knowledgeFiles = (await fs.readdir(knowledgeDir)).filter(f => f.endsWith(".md"));
      } catch { /* no knowledge dir */ }

      const needsUpdate = JSON.stringify(persona.knowledgeFiles?.sort()) !== JSON.stringify(knowledgeFiles.sort());
      if (needsUpdate) {
        persona.knowledgeFiles = knowledgeFiles;
        persona.lastUpdatedAt = new Date().toISOString();
        await fs.writeFile(personaPath, JSON.stringify(persona, null, 2), "utf-8");
        result.personasFixed++;
      }

      indexEntries.push(personaToIndexEntry(persona));
      result.personasValid++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        result.personaErrors.push(`${entry}/: Directory exists but no persona.json found`);
      } else {
        result.personaErrors.push(`${entry}/persona.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Rebuild index.json from disk
  const index: PersonasIndex = {
    version: "1.0.0",
    lastUpdatedAt: new Date().toISOString(),
    personas: indexEntries,
  };
  await fs.writeFile(PERSONAS_INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Run the full startup validation. Call this early in the startup sequence.
 * 
 * - Scans all council .md files and persona directories
 * - Auto-fixes CRLF line endings in .md files
 * - Syncs knowledgeFiles arrays with actual disk contents
 * - Rebuilds both index.json files from disk
 * - Reports any files that couldn't be validated
 */
export async function runStartupValidation(): Promise<ValidationResult> {
  const result: ValidationResult = {
    councilsScanned: 0,
    councilsValid: 0,
    councilsFixed: 0,
    councilErrors: [],
    personasScanned: 0,
    personasValid: 0,
    personasFixed: 0,
    personaErrors: [],
    personaMdScanned: 0,
    personaMdValid: 0,
    personaMdErrors: [],
    malformedFiles: [],
    indexesRebuilt: false,
  };

  await validateCouncils(result);
  await validatePersonaMdFiles(result);
  await validatePersonas(result);
  result.indexesRebuilt = true;

  return result;
}

/**
 * Print a human-readable validation report to console.
 */
export function printValidationReport(result: ValidationResult): void {
  const totalFixed = result.councilsFixed + result.personasFixed;
  const totalErrors = result.councilErrors.length + result.personaMdErrors.length + result.personaErrors.length;

  console.log("[Validator] Startup validation complete:");
  console.log(`  Councils: ${result.councilsValid}/${result.councilsScanned} valid${result.councilsFixed ? `, ${result.councilsFixed} auto-fixed` : ""}`);
  console.log(`  Persona .md: ${result.personaMdValid}/${result.personaMdScanned} valid`);
  console.log(`  Persona dirs: ${result.personasValid}/${result.personasScanned} valid${result.personasFixed ? `, ${result.personasFixed} synced` : ""}`);

  if (result.indexesRebuilt) {
    console.log("  Indexes: rebuilt from disk ✓");
  }

  if (totalErrors > 0) {
    console.warn(`\n[Validator] ⚠️  ${totalErrors} issue(s) found:`);
    for (const err of result.councilErrors) {
      console.warn(`  [council] ${err}`);
    }
    for (const err of result.personaMdErrors) {
      console.warn(`  [persona.md] ${err}`);
    }
    for (const err of result.personaErrors) {
      console.warn(`  [persona dir] ${err}`);
    }
  }

  if (result.malformedFiles.length > 0) {
    console.warn(`\n[Validator] ${result.malformedFiles.length} file(s) have format issues and were NOT loaded.`);
  }
}
