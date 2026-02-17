/**
 * Journal — Narrative Synthesizer
 *
 * Sends cache entry content + agent identity to the server LLM
 * and gets back a first-person narrative journal entry written
 * in the agent's voice with self-reflection.
 */

import { serverLLMCall } from "../../server-llm.js";
import type { CacheEntry } from "../research-cache.js";
import type { AgentContext } from "./types.js";

/**
 * Synthesize a narrative journal section from cache entries via LLM.
 * Throws on failure — caller should fall back to structured format.
 */
export async function synthesizeNarrative(
  entries: CacheEntry[],
  contents: Map<string, string>,
  existingJournal: string,
  agent: AgentContext,
): Promise<string> {
  const material = buildMaterial(entries, contents);
  const priorContext = buildPriorContext(existingJournal);
  const systemPrompt = buildSystemPrompt(agent);
  const userPrompt = `${priorContext}\n\n---\n\nNew material to journal:\n\n${material}`;

  const result = await serverLLMCall({
    role: "workhorse",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    maxTokens: 1024,
    temperature: 0.4,
  });

  if (!result.success || !result.content?.trim()) {
    throw new Error(result.error || "Empty LLM response");
  }

  return result.content.trim();
}

// ============================================
// PROMPT BUILDERS
// ============================================

function buildMaterial(entries: CacheEntry[], contents: Map<string, string>): string {
  const sections: string[] = [];

  for (const entry of entries) {
    const time = entry.cachedAt.slice(11, 16);
    const title = entry.title || entry.source;
    const content = contents.get(entry.filename);

    const parts = [`## ${time} — ${title}`, `Source: ${entry.source}`, `Type: ${entry.type}`];
    if (entry.tags?.length) parts.push(`Tags: ${entry.tags.join(", ")}`);
    if (entry.relatedModels?.length) parts.push(`Related topics: ${entry.relatedModels.join(", ")}`);
    if (content) {
      parts.push("");
      parts.push(content);
    } else if (entry.brief) {
      parts.push("");
      parts.push(entry.brief);
    }
    sections.push(parts.join("\n"));
  }

  return sections.join("\n\n---\n\n");
}

function buildPriorContext(existingJournal: string): string {
  if (existingJournal) {
    return `Here is what I've already written in today's journal:\n\n${existingJournal.slice(-2000)}\n\n---\n\nNow continue the journal with the new material below.`;
  }
  return "This is the first entry for today.";
}

function buildSystemPrompt(agent: AgentContext): string {
  const identityBlock = agent.backstory
    ? `## Who You Are\n\n${agent.backstory}\n\n---\n\n${agent.skeleton}`
    : `## Who You Are\n\n${agent.skeleton}`;

  return [
    identityBlock,
    "",
    `You are ${agent.name}, writing your daily Assistant's Log — a personal journal.`,
    "Write in first person. Your voice, personality, and perspective should reflect the identity above.",
    "For each piece of research or activity, cover:",
    "- What you looked into and why",
    "- What you found that was interesting or useful",
    "- **What you learned** — a brief self-reflection on what this taught you, changed your understanding of, or what you'd do differently next time",
    "- Any connections to things you already know or are working on",
    "- Anything the user might want to follow up on",
    "",
    "The self-reflection is the most important part. Every entry must end with what you took away from it — even if it's small.",
    "Write it as flowing prose paragraphs, not bullet lists. Use ### time headers to separate entries.",
    "Keep each entry to 3-5 sentences. Don't pad with filler — if something was routine, say so briefly, but still reflect.",
    "Don't repeat information that's already in today's journal.",
  ].join("\n");
}
