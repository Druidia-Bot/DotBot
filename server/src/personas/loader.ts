/**
 * Server Persona Loader
 * 
 * Loads intake agents and internal personas from .md files on the server.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { PersonaDefinition } from "../types/agent.js";

// ============================================
// PATHS
// ============================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PERSONAS_DIR = __dirname;
const INTAKE_DIR = path.join(PERSONAS_DIR, "intake");
const INTERNAL_DIR = path.join(PERSONAS_DIR, "internal");

// ============================================
// CACHE
// ============================================

const personaCache = new Map<string, PersonaDefinition>();
let cacheInitialized = false;

// ============================================
// FRONTMATTER PARSING
// ============================================

interface FrontMatter {
  id: string;
  name: string;
  type: "intake" | "internal";
  modelTier: "fast" | "smart" | "powerful";
  description: string;
  tools?: string[];
  modelRole?: "workhorse" | "deep_context" | "architect" | "local" | "gui_fast";
  councilOnly?: string;  // parsed as string from YAML, coerced to boolean below
}

/** Exported for testing — parses YAML frontmatter from markdown content */
export function parseFrontMatter(content: string): { frontMatter: FrontMatter; body: string } | null {
  // Handle both \r\n (Windows) and \n (Unix) line endings
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  
  const yamlStr = match[1];
  const body = match[2].trim();
  
  // Simple YAML parsing (key: value)
  const frontMatter: any = {};
  for (const line of yamlStr.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    
    // Handle arrays like [a, b, c]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      frontMatter[key] = rawValue.slice(1, -1).split(",").map(s => s.trim());
    } else {
      frontMatter[key] = rawValue;
    }
  }
  
  return { frontMatter, body };
}

// ============================================
// LOADING
// ============================================

function loadPersonaFromFile(filePath: string, type: "intake" | "internal"): PersonaDefinition | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseFrontMatter(content);
    
    if (!parsed) {
      console.error(`[Personas] Failed to parse frontmatter in ${filePath}`);
      return null;
    }
    
    const { frontMatter, body } = parsed;
    
    const validRoles = ["workhorse", "deep_context", "architect", "local", "gui_fast"];
    return {
      id: frontMatter.id,
      name: frontMatter.name,
      type: type,
      modelTier: frontMatter.modelTier || "fast",
      description: frontMatter.description || "",
      systemPrompt: body,
      tools: Array.isArray(frontMatter.tools) ? frontMatter.tools : [],
      modelRole: validRoles.includes(frontMatter.modelRole as string) ? frontMatter.modelRole : undefined,
      councilOnly: frontMatter.councilOnly === "true",
    };
  } catch (error) {
    console.error(`[Personas] Error loading ${filePath}:`, error);
    return null;
  }
}

function loadPersonasFromDir(dir: string, type: "intake" | "internal"): PersonaDefinition[] {
  const personas: PersonaDefinition[] = [];
  
  if (!fs.existsSync(dir)) {
    console.warn(`[Personas] Directory not found: ${dir}`);
    return personas;
  }
  
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".md"));
  
  for (const file of files) {
    const persona = loadPersonaFromFile(path.join(dir, file), type);
    if (persona) {
      personas.push(persona);
      personaCache.set(persona.id, persona);
    }
  }
  
  return personas;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Initialize and cache all server-side personas.
 */
export function initServerPersonas(): void {
  if (cacheInitialized) return;
  
  console.log("[Personas] Loading server-side personas...");
  
  const intake = loadPersonasFromDir(INTAKE_DIR, "intake");
  const internal = loadPersonasFromDir(INTERNAL_DIR, "internal");
  
  console.log(`[Personas] Loaded ${intake.length} intake agents, ${internal.length} internal personas`);
  cacheInitialized = true;
}

/**
 * Get a persona by ID.
 */
export function getPersona(id: string): PersonaDefinition | undefined {
  if (!cacheInitialized) initServerPersonas();
  return personaCache.get(id);
}

/**
 * Get all intake agents.
 */
export function getIntakeAgents(): PersonaDefinition[] {
  if (!cacheInitialized) initServerPersonas();
  return Array.from(personaCache.values()).filter(p => p.type === "intake");
}

/**
 * Get all internal personas.
 */
export function getInternalPersonas(): PersonaDefinition[] {
  if (!cacheInitialized) initServerPersonas();
  return Array.from(personaCache.values()).filter(p => p.type === "internal");
}

/**
 * Get specific intake agent by role.
 */
export function getReceptionist(): PersonaDefinition | undefined {
  return getPersona("receptionist");
}

/** @deprecated Use getReceptionist() */
export function getGateway(): PersonaDefinition | undefined {
  return getReceptionist();
}

export function getPlanner(): PersonaDefinition | undefined {
  return getPersona("planner");
}

export function getChairman(): PersonaDefinition | undefined {
  return getPersona("chairman");
}

export function getUpdater(): PersonaDefinition | undefined {
  return getPersona("updater");
}

export function getJudge(): PersonaDefinition | undefined {
  return getPersona("judge");
}

/**
 * Register a user-defined persona at runtime (fetched from local agent).
 * This allows getPersona() to resolve user personas during execution.
 */
export function registerUserPersona(persona: PersonaDefinition): void {
  personaCache.set(persona.id, persona);
}

/**
 * Reload personas from disk (useful for hot-reloading during development).
 */
export function reloadPersonas(): void {
  personaCache.clear();
  cacheInitialized = false;
  initServerPersonas();
}
