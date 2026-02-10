/**
 * Persona File Manager
 * 
 * Manages persona definitions stored as markdown files with YAML frontmatter.
 * These files live on the user's machine so they can customize them.
 * 
 * File format:
 * ```markdown
 * ---
 * id: gateway
 * name: Gateway
 * modelTier: fast
 * description: Routes requests and classifies intent
 * tools: []
 * ---
 * 
 * You are the Gateway agent for DotBot...
 * ```
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ============================================
// TYPES
// ============================================

export interface PersonaConfig {
  id: string;
  name: string;
  modelTier: "fast" | "smart" | "powerful";
  description: string;
  tools: string[];
  systemPrompt: string;
  role?: string;
  traits?: string[];
  expertise?: string[];
  triggers?: string[];
  modelRole?: string;
  councilOnly?: boolean;
}

// ============================================
// PATHS
// ============================================

const DOTBOT_DIR = path.join(os.homedir(), ".bot");
const PERSONAS_DIR = path.join(DOTBOT_DIR, "personas");

// ============================================
// HELPERS
// ============================================

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Parse YAML frontmatter from markdown content
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  
  const [, yamlStr, body] = match;
  const frontmatter: Record<string, any> = {};
  
  // Simple YAML parser for our use case
  for (const line of yamlStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    
    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();
    
    // Handle arrays
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/['"]/g, "")).filter(Boolean);
    }
    // Handle quoted strings
    else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    frontmatter[key] = value;
  }
  
  return { frontmatter, body: body.trim() };
}

/**
 * Serialize persona to markdown with frontmatter
 */
function serializeArray(arr: string[]): string {
  if (arr.length === 0) return "[]";
  return `[${arr.map(t => `"${t}"`).join(", ")}]`;
}

function serializePersona(persona: PersonaConfig): string {
  const lines: string[] = [
    `id: ${persona.id}`,
    `name: ${persona.name}`,
    `modelTier: ${persona.modelTier}`,
    `description: ${persona.description}`,
  ];

  if (persona.role) lines.push(`role: ${persona.role}`);
  lines.push(`tools: ${serializeArray(persona.tools)}`);
  if (persona.traits && persona.traits.length > 0) lines.push(`traits: ${serializeArray(persona.traits)}`);
  if (persona.expertise && persona.expertise.length > 0) lines.push(`expertise: ${serializeArray(persona.expertise)}`);
  if (persona.triggers && persona.triggers.length > 0) lines.push(`triggers: ${serializeArray(persona.triggers)}`);
  if (persona.modelRole) lines.push(`modelRole: ${persona.modelRole}`);
  if (persona.councilOnly) lines.push(`councilOnly: true`);

  return `---\n${lines.join("\n")}\n---\n\n${persona.systemPrompt}\n`;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Initialize the personas directory
 */
export async function initPersonasDir(): Promise<void> {
  await ensureDir(PERSONAS_DIR);
}

/**
 * List all persona files
 */
export async function listPersonas(): Promise<string[]> {
  await ensureDir(PERSONAS_DIR);
  const files = await fs.readdir(PERSONAS_DIR);
  return files.filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""));
}

/**
 * Load a persona from file
 */
export async function loadPersona(id: string): Promise<PersonaConfig | null> {
  const filePath = path.join(PERSONAS_DIR, `${id}.md`);
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    
    return {
      id: frontmatter.id || id,
      name: frontmatter.name || id,
      modelTier: frontmatter.modelTier || "fast",
      description: frontmatter.description || "",
      tools: Array.isArray(frontmatter.tools) ? frontmatter.tools : [],
      systemPrompt: body,
      role: frontmatter.role || undefined,
      traits: Array.isArray(frontmatter.traits) ? frontmatter.traits : undefined,
      expertise: Array.isArray(frontmatter.expertise) ? frontmatter.expertise : undefined,
      triggers: Array.isArray(frontmatter.triggers) ? frontmatter.triggers : undefined,
      modelRole: frontmatter.modelRole || undefined,
      councilOnly: frontmatter.councilOnly === "true" || frontmatter.councilOnly === true || undefined,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Load all personas
 */
export async function loadAllPersonas(): Promise<PersonaConfig[]> {
  const ids = await listPersonas();
  const personas: PersonaConfig[] = [];
  
  for (const id of ids) {
    const persona = await loadPersona(id);
    if (persona) {
      personas.push(persona);
    }
  }
  
  return personas;
}

/**
 * Save a persona to file
 */
export async function savePersonaFile(persona: PersonaConfig): Promise<void> {
  await ensureDir(PERSONAS_DIR);
  const filePath = path.join(PERSONAS_DIR, `${persona.id}.md`);
  const content = serializePersona(persona);
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Delete a persona file
 */
export async function deletePersonaFile(id: string): Promise<boolean> {
  const filePath = path.join(PERSONAS_DIR, `${id}.md`);
  
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if default personas exist
 */
export async function hasDefaultPersonas(): Promise<boolean> {
  const personas = await listPersonas();
  return personas.includes("gateway");
}

/**
 * Write a knowledge file directly to a persona's knowledge directory.
 * Does not require the JSON persona store — works with markdown persona files.
 */
export async function writeKnowledgeFile(
  personaId: string,
  filename: string,
  content: string
): Promise<void> {
  const knowledgeDir = path.join(PERSONAS_DIR, personaId, "knowledge");
  await ensureDir(knowledgeDir);
  await fs.writeFile(path.join(knowledgeDir, filename), content, "utf-8");
}

/**
 * Read all knowledge files for a persona from the filesystem.
 * Works independently of the JSON persona store.
 */
export async function readAllKnowledgeFiles(
  personaId: string
): Promise<{ filename: string; content: string }[]> {
  const knowledgeDir = path.join(PERSONAS_DIR, personaId, "knowledge");
  
  try {
    const files = await fs.readdir(knowledgeDir);
    const mdFiles = files.filter(f => f.endsWith(".md"));
    const results: { filename: string; content: string }[] = [];

    for (const filename of mdFiles) {
      const content = await fs.readFile(path.join(knowledgeDir, filename), "utf-8");
      results.push({ filename, content });
    }

    return results;
  } catch {
    return [];
  }
}
