/**
 * Discovery Handlers
 * 
 * Handles persona, council, knowledge, and tool requests from the server.
 */

import { nanoid } from "nanoid";
import type { WSMessage } from "../types.js";
import * as memory from "../memory/index.js";
import { readAllKnowledgeFiles } from "../memory/persona-files.js";
import { getToolManifest, getRuntimeManifest } from "../tools/registry.js";

type SendFn = (message: WSMessage) => void;

// ============================================
// PERSONA REQUESTS
// ============================================

/**
 * Merge both .md file personas and directory-based persona.json personas
 * into a single list. Directory-based personas get an `id` field from their `slug`.
 * If both formats define the same persona, the directory-based one wins (it's richer).
 */
async function loadAllPersonasMerged(): Promise<any[]> {
  // .md file personas (legacy format) — have `id`
  const mdPersonas = await memory.loadAllPersonas();

  // Directory-based persona.json personas — have `slug`, need `id` added
  const dirPersonas = await memory.getAllPersonas();

  // Build a map keyed by id/slug for deduplication
  const merged = new Map<string, any>();

  // Add .md personas first
  for (const p of mdPersonas) {
    merged.set(p.id, p);
  }

  // Directory-based personas override .md if same id/slug
  for (const p of dirPersonas) {
    merged.set(p.slug, { ...p, id: p.slug });
  }

  return [...merged.values()];
}

export async function handlePersonaRequest(message: WSMessage, send: SendFn): Promise<void> {
  const { action, personaId } = message.payload || {};
  console.log(`[Agent] Persona ${action || "list"}: ${personaId || "all"}`);
  
  try {
    let result: any;
    
    switch (action) {
      case "get":
        // Check .md file personas first, then directory-based persona.json
        result = personaId ? await memory.loadPersona(personaId) : null;
        if (!result && personaId) {
          const dirPersona = await memory.getPersona(personaId);
          if (dirPersona) {
            result = { ...dirPersona, id: dirPersona.slug };
          }
        }
        break;
      case "list":
      default:
        // Merge both .md file personas and directory-based persona.json personas
        result = await loadAllPersonasMerged();
        break;
    }
    
    send({
      type: "persona_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        success: true,
        data: result
      }
    });
  } catch (error) {
    send({
      type: "persona_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }
    });
    console.error(`[Agent] Persona request failed:`, error);
  }
}

// ============================================
// COUNCIL REQUESTS
// ============================================

export async function handleCouncilRequest(message: WSMessage, send: SendFn): Promise<void> {
  const { action, councilId } = message.payload || {};
  console.log(`[Agent] Council ${action || "list"}: ${councilId || "all"}`);
  
  try {
    let result: any;
    
    switch (action) {
      case "get":
        result = councilId ? await memory.loadCouncilPath(councilId) : null;
        break;
      case "list":
      default:
        result = await memory.loadAllCouncilPaths();
        break;
    }
    
    send({
      type: "council_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        success: true,
        data: result
      }
    });
  } catch (error) {
    send({
      type: "council_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }
    });
    console.error(`[Agent] Council request failed:`, error);
  }
}

// ============================================
// KNOWLEDGE REQUESTS
// ============================================

export async function handleKnowledgeRequest(message: WSMessage, send: SendFn): Promise<void> {
  const { personaSlug, requestId } = message.payload;
  console.log(`[Agent] Knowledge request for persona: ${personaSlug}`);

  try {
    const documents = await readAllKnowledgeFiles(personaSlug);

    const formattedDocuments = documents.map((doc, index) => {
      const parsed = parseKnowledgeFrontmatter(doc.content);
      return {
        id: `${personaSlug}_doc_${index}`,
        filename: doc.filename,
        title: parsed.title || doc.filename.replace(".md", ""),
        description: parsed.description || "",
        content: parsed.body,
        tags: parsed.tags,
        keywords: extractKeywords(parsed.body),
        lastUpdatedAt: new Date().toISOString(),
        characterCount: parsed.body.length,
      };
    });

    send({
      type: "knowledge_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: requestId || message.id,
        success: true,
        documents: formattedDocuments,
      },
    });

    console.log(`[Agent] Sent ${formattedDocuments.length} knowledge documents for ${personaSlug}`);
  } catch (error) {
    send({
      type: "knowledge_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: requestId || message.id,
        success: false,
        documents: [],
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });
    console.error(`[Agent] Knowledge request failed:`, error);
  }
}

// ============================================
// KNOWLEDGE HELPERS
// ============================================

/**
 * Parse YAML frontmatter from knowledge markdown files
 */
function parseKnowledgeFrontmatter(content: string): { title: string; description: string; tags: string[]; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { title: "", description: "", tags: [], body: content };
  }

  const [, yaml, body] = match;
  let title = "";
  let description = "";
  let tags: string[] = [];

  const titleMatch = yaml.match(/title:\s*(.+)/);
  if (titleMatch) title = titleMatch[1].trim();

  const descMatch = yaml.match(/description:\s*(.+)/);
  if (descMatch) description = descMatch[1].trim();

  const tagsMatch = yaml.match(/tags:\s*\[([^\]]+)\]/);
  if (tagsMatch) {
    tags = tagsMatch[1].split(",").map(t => t.trim().replace(/['"]/g, "")).filter(Boolean);
  }

  return { title, description, tags, body: body.trim() };
}

// ============================================
// KNOWLEDGE QUERY (pre-scored results)
// ============================================

interface ScoredKnowledgeDoc {
  id: string;
  filename: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  keywords: string[];
  lastUpdatedAt: string;
  characterCount: number;
  relevance: number;
  matchReason: string;
  matchedSections: string[];
}

/**
 * Calculate relevance score between a query and a knowledge document.
 * Moved from server to local agent for efficiency — score locally,
 * send only relevant docs over WS.
 */
function calculateRelevance(
  query: string,
  doc: { title: string; description: string; tags: string[]; keywords: string[]; content: string }
): { score: number; matchedSections: string[]; matchReason: string } {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower
    .split(/\s+/)
    .filter((term) => term.length > 2);

  let score = 0;
  const matchedSections: string[] = [];
  const matchReasons: string[] = [];

  // Title match (highest weight)
  const titleLower = doc.title.toLowerCase();
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
  for (const tag of doc.tags) {
    const tagLower = tag.toLowerCase();
    for (const term of queryTerms) {
      if (tagLower.includes(term) || term.includes(tagLower)) {
        score += 0.15;
        matchReasons.push(`tag "${tag}" matches`);
      }
    }
  }

  // Keyword match (medium weight)
  for (const keyword of doc.keywords) {
    const keywordLower = keyword.toLowerCase();
    for (const term of queryTerms) {
      if (keywordLower.includes(term) || term.includes(keywordLower)) {
        score += 0.1;
        matchReasons.push(`keyword "${keyword}" matches`);
      }
    }
  }

  // Content match (lower weight, but find sections)
  const contentLower = doc.content.toLowerCase();
  const lines = doc.content.split("\n");

  for (const term of queryTerms) {
    if (contentLower.includes(term)) {
      score += 0.05;
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
    matchedSections: matchedSections.slice(0, 3),
    matchReason: matchReasons.slice(0, 5).join("; ") || "content match",
  };
}

const KNOWLEDGE_QUERY_MIN_SCORE = 0.1;
const KNOWLEDGE_QUERY_MAX_RESULTS = 10;
const KNOWLEDGE_QUERY_MAX_CHARS = 8000;

/**
 * Handle a knowledge query from the server — scores docs locally
 * and returns only relevant ones, pre-scored.
 */
export async function handleKnowledgeQuery(message: WSMessage, send: SendFn): Promise<void> {
  const { personaSlug, query, maxResults, maxCharacters, requestId } = message.payload;
  console.log(`[Agent] Knowledge query for persona: ${personaSlug}, query: "${query}"`);

  try {
    const documents = await readAllKnowledgeFiles(personaSlug);
    const limit = maxResults || KNOWLEDGE_QUERY_MAX_RESULTS;
    const charLimit = maxCharacters || KNOWLEDGE_QUERY_MAX_CHARS;

    // Parse, score, and filter
    const scored: ScoredKnowledgeDoc[] = [];
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const parsed = parseKnowledgeFrontmatter(doc.content);
      const keywords = extractKeywords(parsed.body);
      const { score, matchedSections, matchReason } = calculateRelevance(query, {
        title: parsed.title || doc.filename.replace(".md", ""),
        description: parsed.description,
        tags: parsed.tags,
        keywords,
        content: parsed.body,
      });

      if (score >= KNOWLEDGE_QUERY_MIN_SCORE) {
        scored.push({
          id: `${personaSlug}_doc_${i}`,
          filename: doc.filename,
          title: parsed.title || doc.filename.replace(".md", ""),
          description: parsed.description || "",
          content: parsed.body,
          tags: parsed.tags,
          keywords,
          lastUpdatedAt: new Date().toISOString(),
          characterCount: parsed.body.length,
          relevance: score,
          matchReason,
          matchedSections,
        });
      }
    }

    // Sort by relevance descending
    scored.sort((a, b) => b.relevance - a.relevance);

    // Apply limits
    let totalChars = 0;
    const results: ScoredKnowledgeDoc[] = [];
    for (const doc of scored) {
      if (results.length >= limit) break;
      if (totalChars + doc.characterCount > charLimit) continue;
      results.push(doc);
      totalChars += doc.characterCount;
    }

    send({
      type: "knowledge_query_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: requestId || message.id,
        success: true,
        results,
        documentsSearched: documents.length,
      },
    });

    console.log(`[Agent] Knowledge query: ${results.length}/${documents.length} docs matched for ${personaSlug}`);
  } catch (error) {
    send({
      type: "knowledge_query_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: requestId || message.id,
        success: false,
        results: [],
        documentsSearched: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });
    console.error(`[Agent] Knowledge query failed:`, error);
  }
}

// ============================================
// TOOL REQUESTS
// ============================================

export async function handleToolRequest(message: WSMessage, send: SendFn): Promise<void> {
  console.log(`[Agent] Tool request: manifest`);

  try {
    const manifest = await getToolManifest();
    const runtimes = getRuntimeManifest();

    send({
      type: "tool_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        success: true,
        data: manifest,
        runtimes,
      },
    });

    console.log(`[Agent] Sent tool manifest: ${manifest.length} tools, ${runtimes.length} runtimes`);
  } catch (error) {
    send({
      type: "tool_result",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        success: false,
        data: [],
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });
    console.error(`[Agent] Tool request failed:`, error);
  }
}

// ============================================
// KEYWORD EXTRACTION
// ============================================

/**
 * Extract keywords from content for search indexing
 */
function extractKeywords(content: string): string[] {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);

  const wordCounts = new Map<string, number>();
  for (const word of words) {
    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  }

  return [...wordCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}
