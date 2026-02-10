/**
 * Council File Manager
 * 
 * Manages council/path definitions stored as markdown files with YAML frontmatter.
 * These files live on the user's machine so they can customize them.
 * 
 * File format:
 * ```markdown
 * ---
 * id: simple-query
 * name: Simple Query
 * description: Quick questions that don't need execution
 * personas: [gateway, reviewer]
 * triggers: [what, who, when, where, why, how]
 * ---
 * 
 * # Simple Query Path
 * 
 * This path handles quick questions...
 * ```
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ============================================
// TYPES
// ============================================

export interface CouncilPathConfig {
  id: string;
  name: string;
  description: string;
  personas: string[];
  triggers: string[];
  notes?: string;
}

// ============================================
// PATHS
// ============================================

const DOTBOT_DIR = path.join(os.homedir(), ".bot");
const COUNCILS_DIR = path.join(DOTBOT_DIR, "councils");

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
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  
  const [, yamlStr, body] = match;
  const frontmatter: Record<string, any> = {};
  
  for (const line of yamlStr.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    
    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();
    
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s: string) => s.trim().replace(/['"]/g, "")).filter(Boolean);
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    frontmatter[key] = value;
  }
  
  return { frontmatter, body: body.trim() };
}

/**
 * Serialize council path to markdown with frontmatter
 */
function serializeCouncilPath(council: CouncilPathConfig): string {
  const personasStr = `[${council.personas.join(", ")}]`;
  const triggersStr = `[${council.triggers.join(", ")}]`;
    
  return `---
id: ${council.id}
name: ${council.name}
description: ${council.description}
personas: ${personasStr}
triggers: ${triggersStr}
---

${council.notes || `# ${council.name}\n\nThis path handles: ${council.description}`}
`;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Initialize the councils directory
 */
export async function initCouncilsDir(): Promise<void> {
  await ensureDir(COUNCILS_DIR);
}

/**
 * List all council path files
 */
export async function listCouncilPaths(): Promise<string[]> {
  await ensureDir(COUNCILS_DIR);
  const files = await fs.readdir(COUNCILS_DIR);
  return files.filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""));
}

/**
 * Load a council path from file
 */
export async function loadCouncilPath(id: string): Promise<CouncilPathConfig | null> {
  const filePath = path.join(COUNCILS_DIR, `${id}.md`);
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    
    return {
      id: frontmatter.id || id,
      name: frontmatter.name || id,
      description: frontmatter.description || "",
      personas: Array.isArray(frontmatter.personas) ? frontmatter.personas : [],
      triggers: Array.isArray(frontmatter.triggers) ? frontmatter.triggers : [],
      notes: body
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Load all council paths
 */
export async function loadAllCouncilPaths(): Promise<CouncilPathConfig[]> {
  const ids = await listCouncilPaths();
  const paths: CouncilPathConfig[] = [];
  
  for (const id of ids) {
    const councilPath = await loadCouncilPath(id);
    if (councilPath) {
      paths.push(councilPath);
    }
  }
  
  return paths;
}

/**
 * Save a council path to file
 */
export async function saveCouncilPathFile(council: CouncilPathConfig): Promise<void> {
  await ensureDir(COUNCILS_DIR);
  const filePath = path.join(COUNCILS_DIR, `${council.id}.md`);
  const content = serializeCouncilPath(council);
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Check if default council paths exist
 */
export async function hasDefaultCouncilPaths(): Promise<boolean> {
  const paths = await listCouncilPaths();
  return paths.includes("simple-query");
}
