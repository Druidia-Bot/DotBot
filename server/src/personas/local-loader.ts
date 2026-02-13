/**
 * Local Persona Loader
 *
 * Loads user-defined personas from the local agent's ~/.bot/personas/ directory.
 * These are received via WebSocket messages when needed, not read from disk on the server.
 *
 * Structure:
 * ~/.bot/personas/
 *   alex-hormozi/
 *     persona.md          (YAML frontmatter + system prompt)
 *     knowledge/
 *       frameworks.md
 *       case-studies.md
 */

import type { PersonaDefinition, LocalPersonaDefinition } from "../types/agent.js";
import { parseFrontMatter } from "./loader.js";
import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("local-loader");

// ============================================
// CACHE
// ============================================

const localPersonaCache = new Map<string, LocalPersonaDefinition>();

// ============================================
// PARSING
// ============================================

/**
 * Parse a user-defined persona from its markdown content.
 * Uses the same frontmatter format as server personas.
 *
 * Example:
 * ---
 * id: alex-hormozi
 * name: Alex Hormozi
 * modelTier: smart
 * description: Marketing and business growth expert
 * tools: []
 * ---
 * You are Alex Hormozi...
 */
export function parseLocalPersona(
  content: string,
  slug: string
): LocalPersonaDefinition | null {
  const parsed = parseFrontMatter(content);

  if (!parsed) {
    log.warn(`Failed to parse local persona frontmatter`, { slug });
    return null;
  }

  const { frontMatter, body } = parsed;

  // Validate required fields
  if (!frontMatter.id || !frontMatter.name) {
    log.warn(`Local persona missing required fields (id, name)`, { slug });
    return null;
  }

  const validRoles = ["workhorse", "deep_context", "architect", "local", "gui_fast"];

  return {
    id: frontMatter.id,
    slug,
    name: frontMatter.name,
    type: "client",
    modelTier: frontMatter.modelTier || "smart",
    description: frontMatter.description || "",
    systemPrompt: body,
    tools: Array.isArray(frontMatter.tools) ? frontMatter.tools : [],
    modelRole: validRoles.includes(frontMatter.modelRole as string)
      ? frontMatter.modelRole as any
      : undefined,
    knowledgeDocumentIds: [],
    lastSyncedAt: new Date().toISOString(),
  };
}

// ============================================
// REGISTRATION
// ============================================

/**
 * Register a user-defined persona received from the local agent.
 * This is called when the local agent sends persona definitions via WebSocket.
 */
export function registerLocalPersona(persona: LocalPersonaDefinition): void {
  localPersonaCache.set(persona.slug, persona);
  log.info(`Registered local persona`, {
    slug: persona.slug,
    name: persona.name,
    knowledgeCount: persona.knowledgeDocumentIds?.length || 0,
  });
}

/**
 * Register multiple local personas at once.
 */
export function registerLocalPersonas(personas: LocalPersonaDefinition[]): void {
  for (const persona of personas) {
    registerLocalPersona(persona);
  }
  log.info(`Registered ${personas.length} local personas`);
}

/**
 * Unregister a local persona (when disconnected or removed).
 */
export function unregisterLocalPersona(slug: string): void {
  const removed = localPersonaCache.delete(slug);
  if (removed) {
    log.info(`Unregistered local persona`, { slug });
  }
}

/**
 * Clear all local personas (e.g., on client disconnect).
 */
export function clearLocalPersonas(): void {
  const count = localPersonaCache.size;
  localPersonaCache.clear();
  if (count > 0) {
    log.info(`Cleared ${count} local personas`);
  }
}

// ============================================
// RETRIEVAL
// ============================================

/**
 * Get a local persona by slug.
 */
export function getLocalPersona(slug: string): LocalPersonaDefinition | undefined {
  return localPersonaCache.get(slug);
}

/**
 * Get all registered local personas.
 */
export function getAllLocalPersonas(): LocalPersonaDefinition[] {
  return Array.from(localPersonaCache.values());
}

/**
 * Check if a persona slug is a registered local persona.
 */
export function isLocalPersona(slug: string): boolean {
  return localPersonaCache.has(slug);
}

/**
 * Update knowledge document IDs for a persona.
 * Called when the local agent sends an updated knowledge index.
 */
export function updatePersonaKnowledge(
  slug: string,
  documentIds: string[]
): void {
  const persona = localPersonaCache.get(slug);
  if (persona) {
    persona.knowledgeDocumentIds = documentIds;
    persona.lastSyncedAt = new Date().toISOString();
    log.info(`Updated knowledge index for persona`, {
      slug,
      documentCount: documentIds.length
    });
  }
}

// ============================================
// KNOWLEDGE DOCUMENT CACHE
// ============================================

/**
 * Knowledge document metadata + content.
 * Fetched on-demand from the local agent when a persona is used.
 */
export interface KnowledgeDocument {
  id: string;
  personaSlug: string;
  filename: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  keywords: string[];
  lastUpdatedAt: string;
  characterCount: number;
}

const knowledgeCache = new Map<string, KnowledgeDocument>();

/**
 * Store knowledge documents in cache.
 * Key format: `${personaSlug}:${documentId}`
 */
export function cacheKnowledgeDocuments(
  personaSlug: string,
  documents: KnowledgeDocument[]
): void {
  for (const doc of documents) {
    const key = `${personaSlug}:${doc.id}`;
    knowledgeCache.set(key, doc);
  }
  log.info(`Cached knowledge documents`, {
    personaSlug,
    documentCount: documents.length
  });
}

/**
 * Get cached knowledge documents for a persona.
 */
export function getCachedKnowledge(personaSlug: string): KnowledgeDocument[] {
  const docs: KnowledgeDocument[] = [];
  for (const [key, doc] of knowledgeCache.entries()) {
    if (key.startsWith(`${personaSlug}:`)) {
      docs.push(doc);
    }
  }
  return docs;
}

/**
 * Clear cached knowledge for a persona (e.g., when it's updated).
 */
export function clearPersonaKnowledge(personaSlug: string): void {
  const keysToDelete: string[] = [];
  for (const key of knowledgeCache.keys()) {
    if (key.startsWith(`${personaSlug}:`)) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    knowledgeCache.delete(key);
  }
  if (keysToDelete.length > 0) {
    log.info(`Cleared cached knowledge`, {
      personaSlug,
      documentCount: keysToDelete.length
    });
  }
}

/**
 * Clear all knowledge cache (e.g., on client disconnect).
 */
export function clearAllKnowledge(): void {
  const count = knowledgeCache.size;
  knowledgeCache.clear();
  if (count > 0) {
    log.info(`Cleared all cached knowledge (${count} documents)`);
  }
}
