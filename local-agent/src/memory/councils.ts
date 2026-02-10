/**
 * Council Store
 * 
 * Manages locally stored council definitions.
 * Councils are stored as markdown files with YAML frontmatter for easy editing.
 * 
 * File structure:
 * ~/.bot/councils/
 * ├── index.json
 * └── {council-slug}.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type {
  Council,
  CouncilMember,
  GoverningPrinciple,
  CouncilIndexEntry,
  CouncilsIndex
} from "./types.js";

// ============================================
// PATHS
// ============================================

const DOTBOT_DIR = path.join(os.homedir(), ".bot");
const COUNCILS_DIR = path.join(DOTBOT_DIR, "councils");
const COUNCILS_INDEX_PATH = path.join(COUNCILS_DIR, "index.json");

// ============================================
// HELPERS
// ============================================

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ============================================
// MARKDOWN SERIALIZATION
// ============================================

function councilToMarkdown(council: Council): string {
  const lines: string[] = [];
  
  // YAML frontmatter
  lines.push("---");
  lines.push(`slug: ${council.slug}`);
  lines.push(`name: ${council.name}`);
  lines.push(`created: ${council.createdAt}`);
  lines.push(`updated: ${council.lastUpdatedAt}`);
  lines.push(`handles:`);
  for (const h of council.handles) {
    lines.push(`  - ${h}`);
  }
  lines.push(`tags:`);
  for (const t of council.tags) {
    lines.push(`  - ${t}`);
  }
  lines.push("---");
  lines.push("");
  
  // Mission
  lines.push("# " + council.name);
  lines.push("");
  lines.push("## Mission");
  lines.push("");
  lines.push(council.mission);
  lines.push("");
  
  // Description
  lines.push("## Description");
  lines.push("");
  lines.push(council.description);
  lines.push("");
  
  // Governing Principles
  lines.push("## Governing Principles");
  lines.push("");
  for (const principle of council.principles.sort((a, b) => b.priority - a.priority)) {
    lines.push(`### ${principle.id}. ${principle.title} (Priority: ${principle.priority})`);
    lines.push("");
    lines.push(principle.description);
    lines.push("");
  }
  
  // Members
  lines.push("## Council Members");
  lines.push("");
  for (const member of council.members.sort((a, b) => a.sequence - b.sequence)) {
    lines.push(`### ${member.sequence}. @${member.personaSlug} — ${member.councilRole}`);
    lines.push("");
    const meta: string[] = [];
    meta.push(`- **Required:** ${member.required !== false ? "yes" : "no"}`);
    if (member.providerOverride) meta.push(`- **Provider:** ${member.providerOverride}`);
    if (member.modelOverride) meta.push(`- **Model:** ${member.modelOverride}`);
    if (member.reviewFocus) meta.push(`- **Review Focus:** ${member.reviewFocus}`);
    if (meta.length) {
      lines.push(...meta);
      lines.push("");
    }
    if (member.invocationConditions && member.invocationConditions.length > 0) {
      lines.push("**Invoked when:**");
      for (const cond of member.invocationConditions) {
        lines.push(`- ${cond}`);
      }
      lines.push("");
    }
  }
  
  // Execution Mode
  lines.push("## Execution Mode");
  lines.push("");
  lines.push(`**Mode:** ${council.executionMode}`);
  if (council.executionMode === "iterative" && council.maxIterations) {
    lines.push(`**Max Iterations:** ${council.maxIterations}`);
  }
  lines.push("");
  
  // Default Path
  lines.push("## Default Execution Path");
  lines.push("");
  lines.push(council.defaultPath.map(p => `@${p}`).join(" → "));
  lines.push("");
  
  return lines.join("\n");
}

function markdownToCouncil(content: string, slug: string): Council | null {
  try {
    // Normalize CRLF → LF for consistent parsing on Windows
    const normalized = content.replace(/\r\n/g, "\n");

    // Extract frontmatter
    const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) return null;
    
    const frontmatter = frontmatterMatch[1];
    const body = frontmatterMatch[2];
    
    // Parse frontmatter
    const getName = (fm: string) => fm.match(/name:\s*(.+)/)?.[1]?.trim() || "";
    const getCreated = (fm: string) => fm.match(/created:\s*(.+)/)?.[1]?.trim() || new Date().toISOString();
    const getUpdated = (fm: string) => fm.match(/updated:\s*(.+)/)?.[1]?.trim() || new Date().toISOString();
    
    const getList = (fm: string, key: string): string[] => {
      const match = fm.match(new RegExp(`${key}:\\n([\\s\\S]*?)(?=\\n[a-z]+:|$)`));
      if (!match) return [];
      return match[1]
        .split("\n")
        .filter((l: string) => l.trim().startsWith("-"))
        .map((l: string) => l.replace(/^\s*-\s*/, "").trim());
    };
    
    // Parse body sections
    const getMission = (b: string) => {
      const match = b.match(/## Mission\n\n([\s\S]*?)(?=\n## |$)/);
      return match?.[1]?.trim() || "";
    };
    
    const getDescription = (b: string) => {
      const match = b.match(/## Description\n\n([\s\S]*?)(?=\n## |$)/);
      return match?.[1]?.trim() || "";
    };
    
    const getPrinciples = (b: string): GoverningPrinciple[] => {
      const section = b.match(/## Governing Principles\n\n([\s\S]*?)(?=\n## |$)/)?.[1] || "";
      const principles: GoverningPrinciple[] = [];
      const matches = section.matchAll(/### (\w+)\. ([^(]+) \(Priority: (\d+)\)\n\n([\s\S]*?)(?=\n### |$)/g);
      
      for (const match of matches) {
        principles.push({
          id: match[1],
          title: match[2].trim(),
          priority: parseInt(match[3], 10),
          description: match[4].trim()
        });
      }
      
      return principles;
    };
    
    const getMembers = (b: string): CouncilMember[] => {
      const section = b.match(/## Council Members\n\n([\s\S]*?)(?=\n## |$)/)?.[1] || "";
      const members: CouncilMember[] = [];
      const matches = section.matchAll(/### (\d+)\. @(\S+) — (.+)\n\n([\s\S]*?)(?=\n### |$)/g);
      
      for (const match of matches) {
        const body = match[4];
        const conditions: string[] = [];
        const condMatch = body.match(/\*\*Invoked when:\*\*\n([\s\S]*?)(?=\n\n|$)/);
        if (condMatch) {
          const condLines = condMatch[1].split("\n").filter((l: string) => l.trim().startsWith("-"));
          for (const line of condLines) {
            conditions.push(line.replace(/^\s*-\s*/, "").trim());
          }
        }
        
        // Parse member metadata
        const reqMatch = body.match(/\*\*Required:\*\*\s*(yes|no)/i);
        const providerMatch = body.match(/\*\*Provider:\*\*\s*(\S+)/);
        const modelMatch = body.match(/\*\*Model:\*\*\s*(\S+)/);
        const focusMatch = body.match(/\*\*Review Focus:\*\*\s*(.+)/);
        
        members.push({
          sequence: parseInt(match[1], 10),
          personaSlug: match[2],
          councilRole: match[3].trim(),
          required: reqMatch ? reqMatch[1].toLowerCase() === "yes" : true,
          providerOverride: providerMatch ? providerMatch[1] as any : undefined,
          modelOverride: modelMatch ? modelMatch[1] : undefined,
          reviewFocus: focusMatch ? focusMatch[1].trim() : undefined,
          invocationConditions: conditions.length > 0 ? conditions : undefined
        });
      }
      
      return members;
    };
    
    const getDefaultPath = (b: string): string[] => {
      const match = b.match(/## Default Execution Path\n\n(.+)/);
      if (!match) return [];
      return match[1].split("→").map((p: string) => p.trim().replace(/^@/, ""));
    };
    
    // Parse execution mode
    const getExecutionMode = (b: string): "single_pass" | "iterative" => {
      const match = b.match(/\*\*Mode:\*\*\s*(single_pass|iterative)/);
      return (match?.[1] as "single_pass" | "iterative") || "single_pass";
    };
    const getMaxIterations = (b: string): number | undefined => {
      const match = b.match(/\*\*Max Iterations:\*\*\s*(\d+)/);
      return match ? parseInt(match[1], 10) : undefined;
    };

    return {
      slug,
      name: getName(frontmatter),
      mission: getMission(body),
      description: getDescription(body),
      principles: getPrinciples(body),
      members: getMembers(body),
      handles: getList(frontmatter, "handles"),
      defaultPath: getDefaultPath(body),
      tags: getList(frontmatter, "tags"),
      executionMode: getExecutionMode(body),
      maxIterations: getMaxIterations(body),
      createdAt: getCreated(frontmatter),
      lastUpdatedAt: getUpdated(frontmatter)
    };
  } catch {
    return null;
  }
}

// ============================================
// INITIALIZATION
// ============================================

export async function initCouncilsStore(): Promise<void> {
  await ensureDir(COUNCILS_DIR);
  
  const existingIndex = await readJson<CouncilsIndex>(COUNCILS_INDEX_PATH);
  if (!existingIndex) {
    const defaultIndex: CouncilsIndex = {
      version: "1.0.0",
      lastUpdatedAt: new Date().toISOString(),
      councils: []
    };
    await writeJson(COUNCILS_INDEX_PATH, defaultIndex);
    console.log("[Councils] Initialized councils store");
  }
}

// ============================================
// INDEX OPERATIONS
// ============================================

export async function getCouncilsIndex(): Promise<CouncilsIndex> {
  const index = await readJson<CouncilsIndex>(COUNCILS_INDEX_PATH);
  return index || { version: "1.0.0", lastUpdatedAt: new Date().toISOString(), councils: [] };
}

async function updateCouncilsIndex(
  updater: (index: CouncilsIndex) => void
): Promise<void> {
  const index = await getCouncilsIndex();
  updater(index);
  index.lastUpdatedAt = new Date().toISOString();
  await writeJson(COUNCILS_INDEX_PATH, index);
}

// ============================================
// COUNCIL CRUD
// ============================================

export async function getCouncil(slug: string): Promise<Council | null> {
  const councilPath = path.join(COUNCILS_DIR, `${slug}.md`);
  
  try {
    const content = await fs.readFile(councilPath, "utf-8");
    return markdownToCouncil(content, slug);
  } catch {
    return null;
  }
}

export async function getAllCouncils(): Promise<Council[]> {
  const index = await getCouncilsIndex();
  const councils: Council[] = [];
  
  for (const entry of index.councils) {
    const council = await getCouncil(entry.slug);
    if (council) councils.push(council);
  }
  
  return councils;
}

export async function saveCouncil(council: Council): Promise<void> {
  const councilPath = path.join(COUNCILS_DIR, `${council.slug}.md`);
  const markdown = councilToMarkdown(council);
  
  await ensureDir(COUNCILS_DIR);
  await fs.writeFile(councilPath, markdown, "utf-8");
  
  await updateCouncilsIndex(index => {
    const existingIdx = index.councils.findIndex(c => c.slug === council.slug);
    const entry: CouncilIndexEntry = {
      slug: council.slug,
      name: council.name,
      mission: council.mission,
      memberCount: council.members.length,
      handles: council.handles
    };
    
    if (existingIdx >= 0) {
      index.councils[existingIdx] = entry;
    } else {
      index.councils.push(entry);
    }
  });
}

export async function createCouncil(
  name: string,
  mission: string,
  description: string,
  principles: GoverningPrinciple[],
  members: CouncilMember[],
  options?: {
    handles?: string[];
    defaultPath?: string[];
    tags?: string[];
    executionMode?: "single_pass" | "iterative";
    maxIterations?: number;
  }
): Promise<Council> {
  const slug = slugify(name);
  const now = new Date().toISOString();
  
  const council: Council = {
    slug,
    name,
    mission,
    description,
    principles,
    members,
    handles: options?.handles || [],
    defaultPath: options?.defaultPath || members.sort((a, b) => a.sequence - b.sequence).map(m => m.personaSlug),
    tags: options?.tags || [],
    executionMode: options?.executionMode || "single_pass",
    maxIterations: options?.maxIterations,
    createdAt: now,
    lastUpdatedAt: now
  };
  
  await saveCouncil(council);
  return council;
}

export async function deleteCouncil(slug: string): Promise<boolean> {
  const councilPath = path.join(COUNCILS_DIR, `${slug}.md`);
  
  try {
    await fs.unlink(councilPath);
    await updateCouncilsIndex(index => {
      index.councils = index.councils.filter(c => c.slug !== slug);
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================
// SEARCH
// ============================================

export async function searchCouncils(query: string): Promise<CouncilIndexEntry[]> {
  const index = await getCouncilsIndex();
  const queryLower = query.toLowerCase();
  
  return index.councils.filter(c =>
    c.name.toLowerCase().includes(queryLower) ||
    c.mission.toLowerCase().includes(queryLower) ||
    c.handles.some(h => h.toLowerCase().includes(queryLower))
  );
}

export async function findCouncilForRequest(requestType: string): Promise<Council | null> {
  const index = await getCouncilsIndex();
  const typeLower = requestType.toLowerCase();
  
  for (const entry of index.councils) {
    if (entry.handles.some(h => h.toLowerCase().includes(typeLower))) {
      return getCouncil(entry.slug);
    }
  }
  
  return null;
}
