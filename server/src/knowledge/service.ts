/**
 * Knowledge Service
 * 
 * Production-grade service for managing persona knowledge bases.
 * Handles loading, caching, querying, and injection of knowledge into prompts.
 * 
 * Architecture:
 * - Knowledge is stored on the client (local-agent) at ~/.bot/personas/{slug}/knowledge/
 * - Server requests knowledge via WebSocket when needed
 * - Server caches knowledge in memory with TTL
 * - Personas can query their knowledge mid-execution
 */

import { createHash } from "crypto";
import { createComponentLogger } from "#logging.js";
import type {
  KnowledgeDocument,
  KnowledgeDocumentRef,
  PersonaKnowledgeBase,
  PersonaKnowledgeSummary,
  KnowledgeQuery,
  KnowledgeQueryResult,
  KnowledgeSearchResult,
  KnowledgeInjectionOptions,
  KnowledgeInjection,
  KnowledgeCacheEntry,
  KnowledgeCacheStats,
} from "./types.js";

const log = createComponentLogger("knowledge");

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  /** Default cache TTL in milliseconds (5 minutes) */
  CACHE_TTL_MS: 5 * 60 * 1000,
  /** Maximum documents to return in a query */
  MAX_QUERY_RESULTS: 10,
  /** Maximum characters to return in a query */
  MAX_QUERY_CHARACTERS: 8000,
  /** Default injection character limit */
  DEFAULT_INJECTION_LIMIT: 4000,
  /** Minimum relevance score to include in results */
  MIN_RELEVANCE_SCORE: 0.1,
} as const;

// ============================================
// CACHE
// ============================================

const knowledgeCache = new Map<string, KnowledgeCacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Generate a version hash for cache invalidation
 */
function generateVersionHash(documents: KnowledgeDocument[]): string {
  const content = documents
    .map((d) => `${d.filename}:${d.lastUpdatedAt}:${d.characterCount}`)
    .sort()
    .join("|");
  return createHash("md5").update(content).digest("hex").slice(0, 12);
}

/**
 * Check if a cache entry is still valid
 */
function isCacheValid(entry: KnowledgeCacheEntry): boolean {
  return new Date(entry.expiresAt) > new Date();
}

/**
 * Get cached knowledge base if valid
 */
function getCached(personaSlug: string): PersonaKnowledgeBase | null {
  const entry = knowledgeCache.get(personaSlug);
  if (entry && isCacheValid(entry)) {
    entry.hitCount++;
    cacheHits++;
    return entry.knowledgeBase;
  }
  cacheMisses++;
  return null;
}

/**
 * Store knowledge base in cache
 */
function setCache(knowledgeBase: PersonaKnowledgeBase): void {
  const now = new Date();
  const entry: KnowledgeCacheEntry = {
    knowledgeBase,
    cachedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CONFIG.CACHE_TTL_MS).toISOString(),
    hitCount: 0,
  };
  knowledgeCache.set(knowledgeBase.personaSlug, entry);
}

/**
 * Invalidate cache for a persona
 */
export function invalidateCache(personaSlug: string): void {
  knowledgeCache.delete(personaSlug);
}

/**
 * Clear entire cache
 */
export function clearCache(): void {
  knowledgeCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/**
 * Get cache statistics
 */
export function getCacheStats(): KnowledgeCacheStats {
  let documentCount = 0;
  let memoryUsageBytes = 0;

  for (const entry of knowledgeCache.values()) {
    documentCount += entry.knowledgeBase.documents.length;
    memoryUsageBytes += entry.knowledgeBase.totalCharacters * 2; // Rough estimate
  }

  const totalRequests = cacheHits + cacheMisses;
  return {
    personaCount: knowledgeCache.size,
    documentCount,
    memoryUsageBytes,
    hitRate: totalRequests > 0 ? cacheHits / totalRequests : 0,
    totalHits: cacheHits,
    totalMisses: cacheMisses,
  };
}

// ============================================
// KNOWLEDGE LOADING
// ============================================

/**
 * Callback type for requesting knowledge from local-agent
 */
export type KnowledgeRequestCallback = (
  personaSlug: string
) => Promise<KnowledgeDocument[]>;

/**
 * Callback type for pre-scored knowledge queries — local agent scores
 * docs and returns only relevant ones, avoiding full-doc transfer.
 */
export type KnowledgeQueryCallback = (
  personaSlug: string,
  query: string,
  maxResults?: number,
  maxCharacters?: number
) => Promise<{ results: KnowledgeSearchResult[]; documentsSearched: number }>;

let knowledgeRequestCallback: KnowledgeRequestCallback | null = null;
let knowledgeQueryCallback: KnowledgeQueryCallback | null = null;

/**
 * Set the callback for requesting knowledge from local-agent
 */
export function setKnowledgeRequestCallback(
  callback: KnowledgeRequestCallback
): void {
  knowledgeRequestCallback = callback;
}

/**
 * Set the callback for pre-scored knowledge queries from local-agent
 */
export function setKnowledgeQueryCallback(
  callback: KnowledgeQueryCallback
): void {
  knowledgeQueryCallback = callback;
}

/**
 * Load knowledge base for a persona
 * Uses cache if available, otherwise requests from local-agent
 */
export async function loadKnowledgeBase(
  personaSlug: string,
  personaName?: string
): Promise<PersonaKnowledgeBase> {
  // Check cache first
  const cached = getCached(personaSlug);
  if (cached) {
    return cached;
  }

  // Request from local-agent
  if (!knowledgeRequestCallback) {
    log.warn(`No callback set, returning empty knowledge base for ${personaSlug}`);
    return createEmptyKnowledgeBase(personaSlug, personaName);
  }

  try {
    const documents = await knowledgeRequestCallback(personaSlug);
    const knowledgeBase = createKnowledgeBase(
      personaSlug,
      personaName || personaSlug,
      documents
    );
    setCache(knowledgeBase);
    log.info(`Loaded ${documents.length} documents for ${personaSlug}`);
    return knowledgeBase;
  } catch (error) {
    log.error(`Failed to load knowledge for ${personaSlug}`, { error });
    return createEmptyKnowledgeBase(personaSlug, personaName);
  }
}

/**
 * Create a knowledge base from documents
 */
function createKnowledgeBase(
  personaSlug: string,
  personaName: string,
  documents: KnowledgeDocument[]
): PersonaKnowledgeBase {
  const totalCharacters = documents.reduce(
    (sum, doc) => sum + doc.characterCount,
    0
  );

  return {
    personaSlug,
    personaName,
    documents,
    totalCharacters,
    loadedAt: new Date().toISOString(),
    versionHash: generateVersionHash(documents),
  };
}

/**
 * Create an empty knowledge base
 */
function createEmptyKnowledgeBase(
  personaSlug: string,
  personaName?: string
): PersonaKnowledgeBase {
  return {
    personaSlug,
    personaName: personaName || personaSlug,
    documents: [],
    totalCharacters: 0,
    loadedAt: new Date().toISOString(),
    versionHash: "empty",
  };
}

/**
 * Get a compact summary of a persona's knowledge
 */
export function getKnowledgeSummary(
  knowledgeBase: PersonaKnowledgeBase
): PersonaKnowledgeSummary {
  return {
    personaSlug: knowledgeBase.personaSlug,
    documentCount: knowledgeBase.documents.length,
    totalCharacters: knowledgeBase.totalCharacters,
    documentRefs: knowledgeBase.documents.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      title: doc.title,
      description: doc.description,
      tags: doc.tags,
      keywords: doc.keywords,
      characterCount: doc.characterCount,
    })),
  };
}

// ============================================
// KNOWLEDGE QUERYING
// ============================================

/**
 * Calculate relevance score between query and document
 */
function calculateRelevance(
  query: string,
  document: KnowledgeDocument
): { score: number; matchedSections: string[]; matchReason: string } {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower
    .split(/\s+/)
    .filter((term) => term.length > 2);

  let score = 0;
  const matchedSections: string[] = [];
  const matchReasons: string[] = [];

  // Title match (highest weight)
  const titleLower = document.title.toLowerCase();
  for (const term of queryTerms) {
    if (titleLower.includes(term)) {
      score += 0.3;
      matchReasons.push(`title contains "${term}"`);
    }
  }

  // Exact title match (bonus)
  if (titleLower.includes(queryLower)) {
    score += 0.2;
    matchReasons.push("exact title match");
  }

  // Tag match (high weight)
  for (const tag of document.tags) {
    const tagLower = tag.toLowerCase();
    for (const term of queryTerms) {
      if (tagLower.includes(term) || term.includes(tagLower)) {
        score += 0.15;
        matchReasons.push(`tag "${tag}" matches`);
      }
    }
  }

  // Keyword match (medium weight)
  for (const keyword of document.keywords) {
    const keywordLower = keyword.toLowerCase();
    for (const term of queryTerms) {
      if (keywordLower.includes(term) || term.includes(keywordLower)) {
        score += 0.1;
        matchReasons.push(`keyword "${keyword}" matches`);
      }
    }
  }

  // Content match (lower weight, but find sections)
  const contentLower = document.content.toLowerCase();
  const lines = document.content.split("\n");

  for (const term of queryTerms) {
    if (contentLower.includes(term)) {
      score += 0.05;
      // Find matching lines for context
      for (const line of lines) {
        if (line.toLowerCase().includes(term) && line.trim().length > 10) {
          if (!matchedSections.includes(line.trim())) {
            matchedSections.push(line.trim());
          }
        }
      }
    }
  }

  // Cap score at 1.0
  score = Math.min(score, 1.0);

  return {
    score,
    matchedSections: matchedSections.slice(0, 3), // Limit to 3 sections
    matchReason: matchReasons.slice(0, 5).join("; ") || "content match",
  };
}

/**
 * Query a persona's knowledge base
 */
export async function queryKnowledge(
  query: KnowledgeQuery
): Promise<KnowledgeQueryResult> {
  const startTime = Date.now();

  // Load knowledge base
  const knowledgeBase = await loadKnowledgeBase(query.personaSlug);

  const maxResults = query.maxResults || CONFIG.MAX_QUERY_RESULTS;
  const maxCharacters = query.maxCharacters || CONFIG.MAX_QUERY_CHARACTERS;

  // Filter by tags if specified
  let candidateDocuments = knowledgeBase.documents;
  if (query.tags && query.tags.length > 0) {
    const queryTags = new Set(query.tags.map((t) => t.toLowerCase()));
    candidateDocuments = candidateDocuments.filter((doc) =>
      doc.tags.some((tag) => queryTags.has(tag.toLowerCase()))
    );
  }

  // Score and rank documents
  const scoredResults: KnowledgeSearchResult[] = [];
  for (const document of candidateDocuments) {
    const { score, matchedSections, matchReason } = calculateRelevance(
      query.query,
      document
    );

    if (score >= CONFIG.MIN_RELEVANCE_SCORE) {
      scoredResults.push({
        document,
        relevance: score,
        matchedSections,
        matchReason,
      });
    }
  }

  // Sort by relevance (descending)
  scoredResults.sort((a, b) => b.relevance - a.relevance);

  // Apply limits
  let totalCharacters = 0;
  const results: KnowledgeSearchResult[] = [];

  for (const result of scoredResults) {
    if (results.length >= maxResults) break;
    if (totalCharacters + result.document.characterCount > maxCharacters) {
      // Skip this document if it would exceed character limit
      continue;
    }

    results.push(result);
    totalCharacters += result.document.characterCount;
  }

  return {
    query,
    results,
    documentsSearched: candidateDocuments.length,
    executionTimeMs: Date.now() - startTime,
  };
}

/**
 * Get specific document by filename
 */
export async function getDocument(
  personaSlug: string,
  filename: string
): Promise<KnowledgeDocument | null> {
  const knowledgeBase = await loadKnowledgeBase(personaSlug);
  return (
    knowledgeBase.documents.find((doc) => doc.filename === filename) || null
  );
}

// ============================================
// KNOWLEDGE INJECTION
// ============================================

/**
 * Format a document for injection into a prompt
 */
function formatDocument(
  document: KnowledgeDocument,
  options: KnowledgeInjectionOptions
): string {
  switch (options.format) {
    case "structured":
      return formatStructured(document, options.includeMetadata);
    case "compact":
      return formatCompact(document);
    case "markdown":
    default:
      return formatMarkdown(document, options.includeMetadata);
  }
}

function formatMarkdown(
  document: KnowledgeDocument,
  includeMetadata: boolean
): string {
  const lines: string[] = [];

  lines.push(`### ${document.title}`);

  if (includeMetadata && document.description) {
    lines.push(`> ${document.description}`);
  }

  lines.push("");
  lines.push(document.content);
  lines.push("");

  return lines.join("\n");
}

function formatStructured(
  document: KnowledgeDocument,
  includeMetadata: boolean
): string {
  const lines: string[] = [];

  lines.push(`<knowledge_document file="${document.filename}">`);
  lines.push(`<title>${document.title}</title>`);

  if (includeMetadata) {
    if (document.tags.length > 0) {
      lines.push(`<tags>${document.tags.join(", ")}</tags>`);
    }
    if (document.description) {
      lines.push(`<description>${document.description}</description>`);
    }
  }

  lines.push(`<content>`);
  lines.push(document.content);
  lines.push(`</content>`);
  lines.push(`</knowledge_document>`);

  return lines.join("\n");
}

function formatCompact(document: KnowledgeDocument): string {
  return `[${document.title}] ${document.content}`;
}

/**
 * Inject knowledge into a prompt based on options
 */
export async function injectKnowledge(
  personaSlug: string,
  options?: Partial<KnowledgeInjectionOptions>
): Promise<KnowledgeInjection> {
  const opts: KnowledgeInjectionOptions = {
    maxCharacters: options?.maxCharacters || CONFIG.DEFAULT_INJECTION_LIMIT,
    includeMetadata: options?.includeMetadata ?? true,
    format: options?.format || "markdown",
    priority: options?.priority || "alphabetical",
  };

  const knowledgeBase = await loadKnowledgeBase(personaSlug);

  if (knowledgeBase.documents.length === 0) {
    return {
      content: "",
      characterCount: 0,
      includedDocuments: [],
      excludedDocuments: [],
      summary: "No knowledge documents available",
    };
  }

  // Sort documents by priority
  let sortedDocs = [...knowledgeBase.documents];
  switch (opts.priority) {
    case "recency":
      sortedDocs.sort(
        (a, b) =>
          new Date(b.lastUpdatedAt).getTime() -
          new Date(a.lastUpdatedAt).getTime()
      );
      break;
    case "alphabetical":
    default:
      sortedDocs.sort((a, b) => a.title.localeCompare(b.title));
      break;
  }

  // Select documents within character limit
  const includedDocuments: string[] = [];
  const excludedDocuments: string[] = [];
  const formattedParts: string[] = [];
  let totalCharacters = 0;

  for (const doc of sortedDocs) {
    const formatted = formatDocument(doc, opts);
    const docLength = formatted.length;

    if (totalCharacters + docLength <= opts.maxCharacters) {
      formattedParts.push(formatted);
      includedDocuments.push(doc.filename);
      totalCharacters += docLength;
    } else {
      excludedDocuments.push(doc.filename);
    }
  }

  // Build final content
  let content = "";
  if (formattedParts.length > 0) {
    content = `## Knowledge Base\n\n${formattedParts.join("\n---\n\n")}`;
  }

  return {
    content,
    characterCount: content.length,
    includedDocuments,
    excludedDocuments,
    summary: `Included ${includedDocuments.length} of ${knowledgeBase.documents.length} documents (${totalCharacters} chars)`,
  };
}

/**
 * Inject relevant knowledge based on a query.
 * Prefers the pre-scored path (local agent scores docs) when available,
 * falls back to server-side scoring if the query callback isn't set.
 */
export async function injectRelevantKnowledge(
  personaSlug: string,
  queryText: string,
  options?: Partial<KnowledgeInjectionOptions>
): Promise<KnowledgeInjection> {
  const opts: KnowledgeInjectionOptions = {
    maxCharacters: options?.maxCharacters || CONFIG.DEFAULT_INJECTION_LIMIT,
    includeMetadata: options?.includeMetadata ?? true,
    format: options?.format || "markdown",
    priority: options?.priority || "relevance",
  };

  // Prefer pre-scored path: local agent scores and filters docs
  if (knowledgeQueryCallback) {
    try {
      const { results, documentsSearched } = await knowledgeQueryCallback(
        personaSlug,
        queryText,
        CONFIG.MAX_QUERY_RESULTS,
        opts.maxCharacters,
      );

      if (results.length === 0) {
        return {
          content: "",
          characterCount: 0,
          includedDocuments: [],
          excludedDocuments: [],
          summary: `No relevant knowledge found for query: "${queryText}" (searched ${documentsSearched} docs)`,
        };
      }

      const formattedParts: string[] = [];
      const includedDocuments: string[] = [];
      let totalCharacters = 0;

      for (const result of results) {
        const formatted = formatDocument(result.document, opts);
        formattedParts.push(formatted);
        includedDocuments.push(result.document.filename);
        totalCharacters += formatted.length;
      }

      let content = `## Relevant Knowledge\n\n`;
      content += `_Query: "${queryText}"_\n\n`;
      content += formattedParts.join("\n---\n\n");

      return {
        content,
        characterCount: content.length,
        includedDocuments,
        excludedDocuments: [],
        summary: `Found ${includedDocuments.length} relevant documents (${totalCharacters} chars) from ${documentsSearched} searched`,
      };
    } catch (error) {
      log.warn(`Pre-scored query failed, falling back to server scoring`, { error });
    }
  }

  // Fallback: server-side scoring (loads all docs from local agent)
  const queryResult = await queryKnowledge({
    personaSlug,
    query: queryText,
    maxCharacters: opts.maxCharacters,
  });

  if (queryResult.results.length === 0) {
    return {
      content: "",
      characterCount: 0,
      includedDocuments: [],
      excludedDocuments: [],
      summary: `No relevant knowledge found for query: "${queryText}"`,
    };
  }

  // Format relevant documents
  const formattedParts: string[] = [];
  const includedDocuments: string[] = [];
  let totalCharacters = 0;

  for (const result of queryResult.results) {
    const formatted = formatDocument(result.document, opts);
    formattedParts.push(formatted);
    includedDocuments.push(result.document.filename);
    totalCharacters += formatted.length;
  }

  // Build final content with relevance context
  let content = `## Relevant Knowledge\n\n`;
  content += `_Query: "${queryText}"_\n\n`;
  content += formattedParts.join("\n---\n\n");

  const knowledgeBase = await loadKnowledgeBase(personaSlug);
  const excludedDocuments = knowledgeBase.documents
    .filter((doc) => !includedDocuments.includes(doc.filename))
    .map((doc) => doc.filename);

  return {
    content,
    characterCount: content.length,
    includedDocuments,
    excludedDocuments,
    summary: `Found ${includedDocuments.length} relevant documents (${totalCharacters} chars) in ${queryResult.executionTimeMs}ms`,
  };
}

/**
 * Inject relevant knowledge with persona priority.
 *
 * When a local persona is executing, search their knowledge directory first.
 * If persona-specific results don't fill the character budget, fall back to
 * general knowledge to supplement.
 *
 * This gives local personas access to their curated knowledge base while still
 * allowing access to system-wide knowledge when needed.
 */
export async function injectRelevantKnowledgeWithPersonaPriority(
  priorityPersonaSlug: string,
  fallbackPersonaSlug: string | null,
  queryText: string,
  options?: Partial<KnowledgeInjectionOptions>
): Promise<KnowledgeInjection> {
  const opts: KnowledgeInjectionOptions = {
    maxCharacters: options?.maxCharacters || CONFIG.DEFAULT_INJECTION_LIMIT,
    includeMetadata: options?.includeMetadata ?? true,
    format: options?.format || "markdown",
    priority: options?.priority || "relevance",
  };

  const formattedParts: string[] = [];
  const includedDocuments: string[] = [];
  let totalCharacters = 0;
  let priorityDocs = 0;
  let fallbackDocs = 0;

  // Step 1: Search priority persona's knowledge first
  try {
    const priorityResult = await injectRelevantKnowledge(
      priorityPersonaSlug,
      queryText,
      { ...opts, maxCharacters: opts.maxCharacters }
    );

    if (priorityResult.characterCount > 0) {
      formattedParts.push(priorityResult.content);
      includedDocuments.push(...priorityResult.includedDocuments);
      totalCharacters += priorityResult.characterCount;
      priorityDocs = priorityResult.includedDocuments.length;

      log.info(`Priority search found ${priorityDocs} documents (${priorityResult.characterCount} chars) for ${priorityPersonaSlug}`);
    }
  } catch (error) {
    log.warn(`Priority persona search failed for ${priorityPersonaSlug}`, { error });
  }

  // Step 2: If we have room left, supplement with general/fallback knowledge
  const remainingCharacters = opts.maxCharacters - totalCharacters;
  if (remainingCharacters > 500 && fallbackPersonaSlug) {
    try {
      const fallbackResult = await injectRelevantKnowledge(
        fallbackPersonaSlug,
        queryText,
        { ...opts, maxCharacters: remainingCharacters }
      );

      if (fallbackResult.characterCount > 0) {
        // Filter out documents we already included from priority search
        const newDocs = fallbackResult.includedDocuments.filter(
          doc => !includedDocuments.includes(doc)
        );

        if (newDocs.length > 0) {
          formattedParts.push(`\n---\n\n### Supplementary Knowledge\n\n${fallbackResult.content}`);
          includedDocuments.push(...newDocs);
          totalCharacters += fallbackResult.characterCount;
          fallbackDocs = newDocs.length;

          log.info(`Fallback search added ${fallbackDocs} documents (${fallbackResult.characterCount} chars) from ${fallbackPersonaSlug}`);
        }
      }
    } catch (error) {
      log.warn(`Fallback persona search failed for ${fallbackPersonaSlug}`, { error });
    }
  }

  // Step 3: Build final content
  if (formattedParts.length === 0) {
    return {
      content: "",
      characterCount: 0,
      includedDocuments: [],
      excludedDocuments: [],
      summary: `No relevant knowledge found for query: "${queryText}" in ${priorityPersonaSlug} or fallback sources`,
    };
  }

  const content = formattedParts.join("\n\n");
  const summary = fallbackDocs > 0
    ? `Found ${priorityDocs} priority documents + ${fallbackDocs} fallback documents (${totalCharacters} chars total)`
    : `Found ${priorityDocs} priority documents (${totalCharacters} chars)`;

  return {
    content,
    characterCount: content.length,
    includedDocuments,
    excludedDocuments: [],
    summary,
  };
}
