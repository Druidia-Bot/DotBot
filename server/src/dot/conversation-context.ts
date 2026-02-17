/**
 * Dot — Conversation Context Builder
 *
 * Fetches memory model conversation refs and builds synthetic "remind me"
 * turn pairs that give Dot topic continuity. Used by both the single-topic
 * and per-topic paths in runDot().
 */

import { fetchModel } from "#pipeline/context/memory-models.js";
import type { LLMMessage } from "#llm/types.js";

// ============================================
// TYPES
// ============================================

export interface ModelRecap {
  slug: string;
  name: string;
  conversations: any[];
}

// ============================================
// FETCH MODEL CONVERSATIONS
// ============================================

/**
 * Fetch conversation refs for a list of model slugs.
 * Returns only models that have conversations. Caps at `limit` models.
 */
export async function fetchModelRecaps(
  deviceId: string,
  slugs: string[],
  limit = 3,
): Promise<ModelRecap[]> {
  if (slugs.length === 0) return [];

  const fetches = await Promise.all(
    slugs.slice(0, limit).map((slug) => fetchModel(deviceId, slug)),
  );

  const recaps: ModelRecap[] = [];
  for (const model of fetches) {
    if (model && model.conversations?.length > 0) {
      recaps.push({
        slug: model.slug,
        name: model.name,
        conversations: model.conversations,
      });
    }
  }
  return recaps;
}

/**
 * Fetch a single model's conversation refs.
 * Returns null if the model doesn't exist or has no conversations.
 */
export async function fetchSingleModelRecap(
  deviceId: string,
  slug: string,
): Promise<ModelRecap | null> {
  const model = await fetchModel(deviceId, slug);
  if (!model || !model.conversations?.length) return null;
  return { slug: model.slug, name: model.name, conversations: model.conversations };
}

// ============================================
// FORMAT RECAP LINES
// ============================================

function formatConversationRefs(conversations: any[], limit = 10): string[] {
  const refs = conversations.slice(-limit);
  return refs.map((c: any) => {
    const date = c.timestamp?.slice(0, 10) || "recently";
    const summary = c.summary || (c.content ? c.content.slice(0, 200) : "discussion");
    const points = c.keyPoints?.length > 0 ? ` (${c.keyPoints.join("; ")})` : "";
    return `- **${date}**: ${summary}${points}`;
  });
}

// ============================================
// BUILD SYNTHETIC TURN PAIRS
// ============================================

/**
 * Build a synthetic "remind me" user/assistant turn pair for multiple models.
 * Returns 0 or 2 messages.
 */
export function buildMultiModelRecapTurns(recaps: ModelRecap[]): LLMMessage[] {
  if (recaps.length === 0) return [];

  const modelNames = recaps.map(m => m.name).join(" and ");
  const recapLines: string[] = [];

  for (const model of recaps) {
    const lines = formatConversationRefs(model.conversations);
    recapLines.push(`**${model.name}:**\n${lines.join("\n")}`);
  }

  return [
    { role: "user", content: `Remind me where we left off with ${modelNames}.` },
    { role: "assistant", content: `Here's what we've discussed:\n\n${recapLines.join("\n\n")}` },
  ];
}

/**
 * Build a synthetic "remind me" user/assistant turn pair for a single model.
 * Returns 0 or 2 messages.
 */
export function buildSingleModelRecapTurns(recap: ModelRecap): LLMMessage[] {
  const lines = formatConversationRefs(recap.conversations);
  return [
    { role: "user", content: `Remind me where we left off with ${recap.name}.` },
    { role: "assistant", content: `Here's what we've discussed:\n\n**${recap.name}:**\n${lines.join("\n")}` },
  ];
}
