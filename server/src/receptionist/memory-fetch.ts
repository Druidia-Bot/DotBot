/**
 * Receptionist — Memory Fetching
 *
 * Single entry point: fetchMemoryContext() fetches all relevant models once,
 * then extracts conversation history, related conversations, and model
 * summaries from the pre-fetched data.
 */

import { createComponentLogger } from "../logging.js";
import { sendMemoryRequest } from "../ws/device-bridge.js";
import { formatModelSpine } from "../tool-loop/handlers/memory-get-model-spine.js";
import type { EnhancedPromptRequest } from "../types/agent.js";
import type { ClassifyResult } from "../intake/intake.js";

const log = createComponentLogger("receptionist.memory");

const RELEVANCE_CONFIDENCE_THRESHOLD = 0.3;
const MAX_CHAT_MESSAGES = 40;
const MAX_RELATED_MODELS = 3;
const MAX_RELATED_CONVERSATIONS = 10;

// ============================================
// TYPES
// ============================================

interface RelevantModel {
  name: string;
  confidence: number;
  slug: string;
  data: any | null;
}

export interface MemoryContext {
  conversationHistory: { role: "user" | "assistant"; content: string }[];
  relevantModelSummaries: string;
  relatedConversationsText: string;
}

// ============================================
// ROUTER — single entry point
// ============================================

/**
 * Fetch all memory context the receptionist needs in one pass.
 * Models are fetched once and shared across all three extractors.
 */
export async function fetchMemoryContext(
  deviceId: string,
  intakeResult: ClassifyResult,
  request: EnhancedPromptRequest,
): Promise<MemoryContext> {
  const models = await fetchRelevantModels(deviceId, intakeResult);

  return {
    conversationHistory: extractConversationHistory(models, request),
    relevantModelSummaries: extractModelSummaries(models),
    relatedConversationsText: extractRelatedConversations(models),
  };
}

// ============================================
// FETCH — one round-trip per model
// ============================================

/**
 * Fetch all relevant models above the confidence threshold, sorted by
 * confidence descending. Each entry includes the raw model data (or null
 * if the fetch failed).
 */
async function fetchRelevantModels(
  deviceId: string,
  intakeResult: ClassifyResult,
): Promise<RelevantModel[]> {
  const raw = (intakeResult.relevantMemories as any[]) || [];
  if (raw.length === 0) return [];

  const sorted = [...raw].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const qualifying = sorted.filter(m => (m.confidence || 0) >= RELEVANCE_CONFIDENCE_THRESHOLD);

  const results: RelevantModel[] = [];

  for (const mem of qualifying) {
    const slug = slugify(mem.name);
    try {
      const data = await sendMemoryRequest(deviceId, {
        action: "get_model_detail",
        modelSlug: slug,
      } as any);
      results.push({ name: mem.name, confidence: mem.confidence, slug, data: data ?? null });
    } catch {
      log.warn("Failed to fetch model", { slug });
      results.push({ name: mem.name, confidence: mem.confidence, slug, data: null });
    }
  }

  log.info("Fetched relevant models", {
    total: raw.length,
    qualifying: qualifying.length,
    loaded: results.filter(r => r.data).length,
  });

  return results;
}

// ============================================
// EXTRACTORS — process pre-fetched data
// ============================================

/**
 * Extract chat messages from the top-confidence model's conversations.
 * Falls back to request.recentHistory if no model conversations found.
 */
function extractConversationHistory(
  models: RelevantModel[],
  request: EnhancedPromptRequest,
): { role: "user" | "assistant"; content: string }[] {
  const top = models.find(m => m.data);

  if (top) {
    const conversations: any[] = top.data.conversations || [];
    if (conversations.length > 0) {
      log.info("Using conversation history from model", {
        slug: top.slug,
        totalConversations: conversations.length,
      });
      return conversations
        .slice(-MAX_CHAT_MESSAGES)
        .map((c: any) => ({
          role: c.role === "user" ? "user" as const : "assistant" as const,
          content: String(c.content || c.summary || ""),
        }))
        .filter(m => m.content.length > 0);
    }
  }

  if (request.recentHistory.length > 0) {
    return request.recentHistory.slice(-MAX_CHAT_MESSAGES).map(h => ({
      role: h.role === "user" ? "user" as const : "assistant" as const,
      content: h.content,
    }));
  }

  return [];
}

/**
 * Format each fetched model into a structured spine (beliefs, open loops,
 * data shape, tool guidance).
 */
function extractModelSummaries(models: RelevantModel[]): string {
  const sections = models
    .filter(m => m.data)
    .map(m => formatModelSpine(m.data, m.confidence));

  if (sections.length === 0) return "(No relevant memory models)";
  return sections.join("\n---\n\n");
}

/**
 * Format conversations from related models (excluding the top one which
 * is already in chat history) into a markdown string for the system prompt.
 */
function extractRelatedConversations(models: RelevantModel[]): string {
  if (models.length <= 1) return "(No other related conversations)";

  const related = models.slice(1, 1 + MAX_RELATED_MODELS);
  const sections: string[] = [];

  for (const m of related) {
    const conversations: any[] = m.data?.conversations || [];
    if (conversations.length === 0) continue;

    sections.push(`### Recent discussion about ${m.name} (confidence: ${m.confidence})`);
    for (const c of conversations.slice(-MAX_RELATED_CONVERSATIONS)) {
      const role = c.role === "user" ? "User" : "Assistant";
      const content = String(c.content || c.summary || "").slice(0, 500);
      if (content.length > 0) sections.push(`**${role}**: ${content}`);
    }
    sections.push("");
  }

  if (sections.length === 0) return "(No other related conversations)";
  return sections.join("\n");
}

// ============================================
// UTILITIES
// ============================================

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
