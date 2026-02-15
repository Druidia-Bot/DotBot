/**
 * Knowledge Service Setup
 * 
 * Wires the knowledge service to the WebSocket server for requesting
 * knowledge documents from the local-agent.
 */

import { setKnowledgeRequestCallback, setKnowledgeQueryCallback } from "./service.js";
import { requestKnowledge, requestKnowledgeQuery, getDeviceForUser } from "#ws/server.js";
import type { KnowledgeDocument, KnowledgeSearchResult } from "./types.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("knowledge");

/**
 * Initialize the knowledge service with WebSocket integration
 */
export function initKnowledgeService(): void {
  log.info("Initializing knowledge service");

  // Raw doc callback — loads ALL documents for a persona (used by cache + server-side scoring fallback)
  setKnowledgeRequestCallback(async (personaSlug: string): Promise<KnowledgeDocument[]> => {
    const deviceId = getDeviceForUser("user_demo");
    
    if (!deviceId) {
      log.warn(`No device connected for knowledge request: ${personaSlug}`);
      return [];
    }

    try {
      log.debug(`Requesting knowledge for persona: ${personaSlug}`);
      const documents = await requestKnowledge(deviceId, personaSlug);
      
      const transformed: KnowledgeDocument[] = documents.map((doc: any, index: number) => ({
        id: doc.id || `doc_${personaSlug}_${index}`,
        filename: doc.filename || `document_${index}.md`,
        title: doc.title || doc.filename || `Document ${index + 1}`,
        description: doc.description || "",
        content: doc.content || "",
        tags: doc.tags || [],
        keywords: doc.keywords || extractKeywords(doc.content || ""),
        lastUpdatedAt: doc.lastUpdatedAt || new Date().toISOString(),
        characterCount: doc.characterCount || (doc.content?.length || 0),
      }));

      log.info(`Loaded ${transformed.length} knowledge documents for ${personaSlug}`);
      return transformed;
    } catch (error) {
      log.error(`Failed to load knowledge for ${personaSlug}:`, { error });
      return [];
    }
  });

  // Pre-scored query callback — local agent scores docs and returns only relevant ones
  setKnowledgeQueryCallback(async (
    personaSlug: string,
    query: string,
    maxResults?: number,
    maxCharacters?: number
  ): Promise<{ results: KnowledgeSearchResult[]; documentsSearched: number }> => {
    const deviceId = getDeviceForUser("user_demo");

    if (!deviceId) {
      log.warn(`No device connected for knowledge query: ${personaSlug}`);
      return { results: [], documentsSearched: 0 };
    }

    const raw = await requestKnowledgeQuery(deviceId, {
      personaSlug,
      query,
      maxResults,
      maxCharacters,
    });

    // Transform raw results into KnowledgeSearchResult shape
    const results: KnowledgeSearchResult[] = raw.results.map((r: any) => ({
      document: {
        id: r.id || "",
        filename: r.filename || "",
        title: r.title || "",
        description: r.description || "",
        content: r.content || "",
        tags: r.tags || [],
        keywords: r.keywords || [],
        lastUpdatedAt: r.lastUpdatedAt || new Date().toISOString(),
        characterCount: r.characterCount || 0,
      },
      relevance: r.relevance || 0,
      matchedSections: r.matchedSections || [],
      matchReason: r.matchReason || "",
    }));

    log.debug(`Knowledge query for ${personaSlug}: ${results.length}/${raw.documentsSearched} docs matched`);
    return { results, documentsSearched: raw.documentsSearched };
  });

  log.info("Knowledge service initialized");
}

/**
 * Extract keywords from content for search indexing
 */
function extractKeywords(content: string): string[] {
  // Simple keyword extraction - extract words that appear frequently
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);

  const wordCounts = new Map<string, number>();
  for (const word of words) {
    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  }

  // Get top 10 most frequent words
  const sorted = [...wordCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);

  return sorted;
}
