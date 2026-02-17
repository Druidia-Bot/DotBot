/**
 * Dot — Message Builder
 *
 * Assembles the LLMMessage array for Dot's tool loop.
 * Handles both single-topic and per-topic-segment paths,
 * keeping message construction logic out of the main orchestrator.
 */

import { buildTailoredSection } from "./system-prompt.js";
import {
  fetchModelRecaps,
  fetchSingleModelRecap,
  buildMultiModelRecapTurns,
  buildSingleModelRecapTurns,
} from "./conversation-context.js";
import type { TailorResult, TopicSegment } from "./pre-dot/types.js";
import type { LLMMessage } from "#llm/types.js";

// ============================================
// SINGLE-TOPIC MESSAGE BUILDER
// ============================================

/**
 * Build the full LLMMessage array for a single-topic Dot interaction.
 *
 * Layout:
 *   1. System prompt
 *   2. Synthetic "remind me" turn pair (if relevant models found)
 *   3. Manufactured topic-relevant history turns
 *   4. User message (tailored principles preamble + resolved prompt)
 */
export async function buildSingleTopicMessages(opts: {
  systemPrompt: string;
  deviceId: string;
  tailorResult: TailorResult;
  consolidatedPrinciples: string;
  resolvedPrompt: string;
  forceDispatch: boolean;
}): Promise<LLMMessage[]> {
  const { systemPrompt, deviceId, tailorResult, consolidatedPrinciples, resolvedPrompt, forceDispatch } = opts;

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Fetch and inject model conversation context
  const relevantSlugs = tailorResult.relevantModels || [];
  const recaps = await fetchModelRecaps(deviceId, relevantSlugs);
  messages.push(...buildMultiModelRecapTurns(recaps));

  // Inject manufactured topic-relevant turns from the tailor
  const manufacturedHistory = tailorResult.manufacturedHistory || [];
  for (const turn of manufacturedHistory) {
    messages.push({ role: turn.role, content: turn.content });
  }

  // Current user message — tailored principles + resolved prompt
  const tailoredPreamble = buildTailoredSection(tailorResult, consolidatedPrinciples, forceDispatch);
  const enrichedUserMessage = tailoredPreamble
    ? tailoredPreamble + "\n\n---\n\n" + resolvedPrompt
    : resolvedPrompt;
  messages.push({ role: "user", content: enrichedUserMessage });

  return messages;
}

// ============================================
// PER-TOPIC SEGMENT MESSAGE BUILDER
// ============================================

/**
 * Build the LLMMessage array for a single topic segment.
 *
 * Layout:
 *   1. System prompt
 *   2. Synthetic "remind me" turn pair (if segment has a model)
 *   3. Per-segment manufactured history turns
 *   4. User message (tailored principles preamble + segment text)
 */
export async function buildSegmentMessages(opts: {
  systemPrompt: string;
  deviceId: string;
  segment: TopicSegment;
  tailorResult: TailorResult;
  consolidatedPrinciples: string;
  forceDispatch: boolean;
}): Promise<LLMMessage[]> {
  const { systemPrompt, deviceId, segment, tailorResult, consolidatedPrinciples, forceDispatch } = opts;

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Fetch model context for this segment's model
  if (segment.modelSlug) {
    const recap = await fetchSingleModelRecap(deviceId, segment.modelSlug);
    if (recap) {
      messages.push(...buildSingleModelRecapTurns(recap));
    }
  }

  // Inject per-segment manufactured history
  for (const turn of segment.history) {
    messages.push({ role: turn.role, content: turn.content });
  }

  // Segment user message — tailored principles + segment text
  const tailoredPreamble = buildTailoredSection(tailorResult, consolidatedPrinciples, forceDispatch);
  const segmentUserMessage = tailoredPreamble
    ? tailoredPreamble + "\n\n---\n\n" + segment.text
    : segment.text;
  messages.push({ role: "user", content: segmentUserMessage });

  return messages;
}
