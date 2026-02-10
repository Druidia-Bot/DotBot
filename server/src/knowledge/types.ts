/**
 * Knowledge System Types
 * 
 * Types for the persona knowledge base system.
 * Each persona can have associated knowledge documents that inform their decisions.
 */

// ============================================
// KNOWLEDGE DOCUMENT
// ============================================

/**
 * A knowledge document associated with a persona
 */
export interface KnowledgeDocument {
  /** Unique identifier */
  id: string;
  /** Filename in the knowledge directory */
  filename: string;
  /** Human-readable title */
  title: string;
  /** Brief description of contents */
  description: string;
  /** The actual content (markdown) */
  content: string;
  /** Categorization tags */
  tags: string[];
  /** Keywords extracted for search */
  keywords: string[];
  /** When this document was last modified */
  lastUpdatedAt: string;
  /** Character count for context budget tracking */
  characterCount: number;
}

/**
 * Compact reference to a knowledge document (for indexing)
 */
export interface KnowledgeDocumentRef {
  id: string;
  filename: string;
  title: string;
  description: string;
  tags: string[];
  keywords: string[];
  characterCount: number;
}

// ============================================
// PERSONA KNOWLEDGE BASE
// ============================================

/**
 * Complete knowledge base for a single persona
 */
export interface PersonaKnowledgeBase {
  /** Persona slug this knowledge belongs to */
  personaSlug: string;
  /** Persona name for logging */
  personaName: string;
  /** All knowledge documents */
  documents: KnowledgeDocument[];
  /** Total character count across all documents */
  totalCharacters: number;
  /** When this knowledge base was last loaded */
  loadedAt: string;
  /** Version hash for cache invalidation */
  versionHash: string;
}

/**
 * Compact summary of a persona's knowledge (for transfer)
 */
export interface PersonaKnowledgeSummary {
  personaSlug: string;
  documentCount: number;
  totalCharacters: number;
  documentRefs: KnowledgeDocumentRef[];
}

// ============================================
// KNOWLEDGE QUERY
// ============================================

/**
 * Query request for knowledge lookup
 */
export interface KnowledgeQuery {
  /** Which persona's knowledge to search */
  personaSlug: string;
  /** Natural language query */
  query: string;
  /** Maximum number of results */
  maxResults?: number;
  /** Maximum total characters to return */
  maxCharacters?: number;
  /** Filter by tags (optional) */
  tags?: string[];
}

/**
 * A single search result
 */
export interface KnowledgeSearchResult {
  /** The document that matched */
  document: KnowledgeDocument;
  /** Relevance score (0-1) */
  relevance: number;
  /** Which parts matched (for highlighting) */
  matchedSections: string[];
  /** Reason for match (for debugging) */
  matchReason: string;
}

/**
 * Complete query response
 */
export interface KnowledgeQueryResult {
  /** The original query */
  query: KnowledgeQuery;
  /** Matching results, sorted by relevance */
  results: KnowledgeSearchResult[];
  /** Total documents searched */
  documentsSearched: number;
  /** Query execution time in ms */
  executionTimeMs: number;
}

// ============================================
// KNOWLEDGE INJECTION
// ============================================

/**
 * Options for injecting knowledge into a prompt
 */
export interface KnowledgeInjectionOptions {
  /** Maximum characters of knowledge to inject */
  maxCharacters: number;
  /** Whether to include document metadata */
  includeMetadata: boolean;
  /** Format for injection */
  format: "markdown" | "structured" | "compact";
  /** Priority order for documents */
  priority: "relevance" | "recency" | "alphabetical";
}

/**
 * Result of knowledge injection
 */
export interface KnowledgeInjection {
  /** The formatted knowledge text to inject */
  content: string;
  /** How many characters were injected */
  characterCount: number;
  /** Which documents were included */
  includedDocuments: string[];
  /** Which documents were truncated or excluded due to limits */
  excludedDocuments: string[];
  /** Summary for debugging */
  summary: string;
}

// ============================================
// CACHE
// ============================================

/**
 * Cache entry for a persona's knowledge
 */
export interface KnowledgeCacheEntry {
  /** The cached knowledge base */
  knowledgeBase: PersonaKnowledgeBase;
  /** When this cache entry was created */
  cachedAt: string;
  /** When this cache entry expires */
  expiresAt: string;
  /** Number of times this cache has been hit */
  hitCount: number;
}

/**
 * Cache statistics
 */
export interface KnowledgeCacheStats {
  /** Number of personas cached */
  personaCount: number;
  /** Total documents cached */
  documentCount: number;
  /** Total memory used (estimated) */
  memoryUsageBytes: number;
  /** Cache hit rate */
  hitRate: number;
  /** Total hits */
  totalHits: number;
  /** Total misses */
  totalMisses: number;
}
