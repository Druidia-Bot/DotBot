/**
 * Persona Store
 * 
 * Manages locally stored personas and their knowledge repositories.
 * 
 * File structure:
 * ~/.bot/personas/
 * ├── index.json
 * └── {persona-slug}/
 *     ├── persona.json
 *     └── knowledge/
 *         └── *.md
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type {
  Persona,
  PersonaIndexEntry,
  PersonasIndex,
  KnowledgeDocument
} from "./types.js";

// ============================================
// PATHS
// ============================================

const DOTBOT_DIR = path.join(os.homedir(), ".bot");
const PERSONAS_DIR = path.join(DOTBOT_DIR, "personas");
const PERSONAS_INDEX_PATH = path.join(PERSONAS_DIR, "index.json");

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
// INITIALIZATION
// ============================================

export async function initPersonasStore(): Promise<void> {
  await ensureDir(PERSONAS_DIR);
  
  const existingIndex = await readJson<PersonasIndex>(PERSONAS_INDEX_PATH);
  if (!existingIndex) {
    const defaultIndex: PersonasIndex = {
      version: "1.0.0",
      lastUpdatedAt: new Date().toISOString(),
      personas: []
    };
    await writeJson(PERSONAS_INDEX_PATH, defaultIndex);
    console.log("[Personas] Initialized personas store");
  }
}

// ============================================
// INDEX OPERATIONS
// ============================================

export async function getPersonasIndex(): Promise<PersonasIndex> {
  const index = await readJson<PersonasIndex>(PERSONAS_INDEX_PATH);
  return index || { version: "1.0.0", lastUpdatedAt: new Date().toISOString(), personas: [] };
}

async function updatePersonasIndex(
  updater: (index: PersonasIndex) => void
): Promise<void> {
  const index = await getPersonasIndex();
  updater(index);
  index.lastUpdatedAt = new Date().toISOString();
  await writeJson(PERSONAS_INDEX_PATH, index);
}

// ============================================
// PERSONA CRUD
// ============================================

export async function getPersona(slug: string): Promise<Persona | null> {
  const personaPath = path.join(PERSONAS_DIR, slug, "persona.json");
  return readJson<Persona>(personaPath);
}

export async function getAllPersonas(): Promise<Persona[]> {
  const index = await getPersonasIndex();
  const personas: Persona[] = [];
  
  for (const entry of index.personas) {
    const persona = await getPersona(entry.slug);
    if (persona) personas.push(persona);
  }
  
  return personas;
}

export async function savePersona(persona: Persona): Promise<void> {
  const personaDir = path.join(PERSONAS_DIR, persona.slug);
  const personaPath = path.join(personaDir, "persona.json");
  const knowledgeDir = path.join(personaDir, "knowledge");
  
  await ensureDir(personaDir);
  await ensureDir(knowledgeDir);
  await writeJson(personaPath, persona);
  
  await updatePersonasIndex(index => {
    const existingIdx = index.personas.findIndex(p => p.slug === persona.slug);
    const entry: PersonaIndexEntry = {
      slug: persona.slug,
      name: persona.name,
      role: persona.role,
      modelTier: persona.modelTier,
      knowledgeFileCount: persona.knowledgeFiles.length
    };
    
    if (existingIdx >= 0) {
      index.personas[existingIdx] = entry;
    } else {
      index.personas.push(entry);
    }
  });
}

export async function createPersona(
  name: string,
  role: string,
  description: string,
  systemPrompt: string,
  options?: {
    modelTier?: Persona["modelTier"];
    modelRole?: Persona["modelRole"];
    councilOnly?: boolean;
    tools?: string[];
    traits?: string[];
    expertise?: string[];
    triggers?: string[];
  }
): Promise<Persona> {
  const slug = slugify(name);
  const now = new Date().toISOString();
  
  const persona: Persona = {
    slug,
    name,
    role,
    description,
    systemPrompt,
    modelTier: options?.modelTier || "smart",
    tools: options?.tools || [],
    traits: options?.traits || [],
    expertise: options?.expertise || [],
    triggers: options?.triggers || [],
    knowledgeFiles: [],
    modelRole: options?.modelRole,
    councilOnly: options?.councilOnly || false,
    createdAt: now,
    lastUpdatedAt: now
  };
  
  await savePersona(persona);
  return persona;
}

export async function deletePersona(slug: string): Promise<boolean> {
  const personaDir = path.join(PERSONAS_DIR, slug);
  
  try {
    await fs.rm(personaDir, { recursive: true });
    await updatePersonasIndex(index => {
      index.personas = index.personas.filter(p => p.slug !== slug);
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================
// KNOWLEDGE MANAGEMENT
// ============================================

export async function getKnowledgeDir(personaSlug: string): Promise<string> {
  return path.join(PERSONAS_DIR, personaSlug, "knowledge");
}

export async function addKnowledge(
  personaSlug: string,
  filename: string,
  content: string
): Promise<void> {
  const persona = await getPersona(personaSlug);
  if (!persona) throw new Error(`Persona not found: ${personaSlug}`);
  
  const knowledgeDir = await getKnowledgeDir(personaSlug);
  const filePath = path.join(knowledgeDir, filename);
  
  await ensureDir(knowledgeDir);
  await fs.writeFile(filePath, content, "utf-8");
  
  if (!persona.knowledgeFiles.includes(filename)) {
    persona.knowledgeFiles.push(filename);
    persona.lastUpdatedAt = new Date().toISOString();
    await savePersona(persona);
  }
}

export async function getKnowledge(
  personaSlug: string,
  filename: string
): Promise<string | null> {
  const knowledgeDir = await getKnowledgeDir(personaSlug);
  const filePath = path.join(knowledgeDir, filename);
  
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function listKnowledge(personaSlug: string): Promise<string[]> {
  const knowledgeDir = await getKnowledgeDir(personaSlug);
  
  try {
    const files = await fs.readdir(knowledgeDir);
    return files.filter((f: string) => f.endsWith(".md") || f.endsWith(".json"));
  } catch {
    return [];
  }
}

export async function getAllKnowledge(personaSlug: string): Promise<KnowledgeDocument[]> {
  const files = await listKnowledge(personaSlug);
  const documents: KnowledgeDocument[] = [];
  
  for (const filename of files) {
    const content = await getKnowledge(personaSlug, filename);
    if (content) {
      // Parse frontmatter if present
      // Normalize CRLF → LF for consistent parsing on Windows
      const normalizedContent = content.replace(/\r\n/g, "\n");
      const frontmatterMatch = normalizedContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let title = filename.replace(".md", "");
      let description = "";
      let tags: string[] = [];
      let body = normalizedContent;
      
      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        body = frontmatterMatch[2];
        
        const titleMatch = frontmatter.match(/title:\s*(.+)/);
        if (titleMatch) title = titleMatch[1].trim();
        
        const descMatch = frontmatter.match(/description:\s*(.+)/);
        if (descMatch) description = descMatch[1].trim();
        
        const tagsMatch = frontmatter.match(/tags:\s*\[([^\]]+)\]/);
        if (tagsMatch) {
          tags = tagsMatch[1].split(",").map(t => t.trim().replace(/"/g, ""));
        }
      }
      
      documents.push({
        filename,
        title,
        description,
        content: body,
        tags,
        lastUpdatedAt: new Date().toISOString()
      });
    }
  }
  
  return documents;
}

// ============================================
// SEARCH
// ============================================

export async function searchPersonas(query: string): Promise<PersonaIndexEntry[]> {
  const index = await getPersonasIndex();
  const queryLower = query.toLowerCase();
  
  return index.personas.filter(p =>
    p.name.toLowerCase().includes(queryLower) ||
    p.role.toLowerCase().includes(queryLower)
  );
}
