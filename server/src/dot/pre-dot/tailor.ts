/**
 * Tailor — Pass 1
 *
 * Pre-Dot LLM call that resolves conversational context, scores complexity,
 * and selects which behavioral principles apply to the current request.
 *
 * Outputs:
 *   1. restatedRequest — the user's prompt with ambiguous references resolved
 *   2. complexity — 0-10 score indicating task complexity
 *   3. relevantCache — filenames of research cache entries relevant to this request
 *   4. tailored — per-principle directives or "does_not_apply"
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { loadPrompt } from "../../prompt-template.js";
import type { ILLMClient } from "#llm/types.js";
import type { TailorResult } from "./types.js";

const log = createComponentLogger("dot.tailor");

// ============================================
// SCHEMA BUILDER
// ============================================

/**
 * Build the static JSON schema for the tailor.
 * Context resolution only — no principle fields.
 */
export function buildTailorSchema(): {
  name: string;
  schema: Record<string, unknown>;
} {
  return {
    name: "tailor_result",
    schema: {
      type: "object",
      properties: {
        restatedRequest: {
          type: "string",
          description: "The user's request restated with all ambiguous references (it, that, the project, etc.) resolved to their concrete meaning from conversation history. If the message is already clear, restate it faithfully.",
        },
        complexity: {
          type: "number",
          description: "Complexity score 0-10. 0-2: casual chat/greeting. 3-4: single tool call. 5-6: multi-step but few tools. 7-8: research + synthesis, multiple external fetches. 9-10: large project needing dedicated agent.",
        },
        contextConfidence: {
          type: "number",
          description: "How confident are you that you understand the full context of this request? 0.0 = no idea, 1.0 = completely certain. Consider whether the conversation history provides enough context to resolve all references and understand the user's intent.",
        },
        relevantCache: {
          type: "array",
          items: { type: "string" },
          description: "Filenames from the research cache that are relevant to the user's current request. Return an empty array if none are relevant.",
        },
        relevantMemories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The memory model slug" },
              confidence: { type: "number", description: "How confident you are this model is relevant to the CURRENT message (0.0-1.0)" },
            },
            required: ["name", "confidence"],
            additionalProperties: false,
          },
          description: "Memory models that the user's CURRENT MESSAGE explicitly references or is clearly about, with confidence scores. Do NOT match models just because they appear in older conversation history. Return an empty array for casual chat.",
        },
        manufacturedHistory: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
            additionalProperties: false,
          },
          description: "Extract 2-4 of the most RECENT conversation turns (not condensed summaries) that directly continue the topic of the current message. Ignore turns about unrelated topics. Return an empty array if no model is relevant or no on-topic turns exist.",
        },
        topicSegments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The portion of the user's message about this topic, restated clearly." },
              modelSlug: { type: ["string", "null"], description: "The model slug this segment relates to, or null for general topics." },
              history: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    role: { type: "string", enum: ["user", "assistant"] },
                    content: { type: "string" },
                  },
                  required: ["role", "content"],
                  additionalProperties: false,
                },
                description: "0-4 manufactured history turns specific to this topic segment.",
              },
            },
            required: ["text", "modelSlug", "history"],
            additionalProperties: false,
          },
          description: "ONLY populate when the user's CURRENT MESSAGE explicitly asks about 2+ distinct topics matching 2+ models. Split the message into separate topic segments. Return an empty array for single-topic or no-model messages.",
        },
        skillSearchQuery: {
          type: ["string", "null"],
          description: "If complexity >= 4, provide 2-4 focused keywords for searching the skill library. Use the most distinctive, specific terms (e.g. 'react frontend tailwind', 'discord bot setup'). Return null for complexity < 4 or casual chat.",
        },
        skillFeedback: {
          type: ["string", "null"],
          description: "If complexity >= 4, a short natural message (under 60 chars) the assistant sends immediately to show engagement while searching skills. Match tone to request. Examples: 'Let me check my notes on that...', 'Searching my workflows...'. Return null for complexity < 4.",
        },
      },
      required: ["restatedRequest", "complexity", "contextConfidence", "relevantCache", "relevantMemories", "manufacturedHistory", "topicSegments", "skillSearchQuery", "skillFeedback"],
      additionalProperties: false,
    },
  };
}

// ============================================
// TAILOR FUNCTION
// ============================================

/**
 * Run the pre-Dot call. Resolves context, scores complexity, and
 * tailors principles. Falls back gracefully if the LLM call fails.
 */
export async function tailorPrinciples(opts: {
  llm: ILLMClient;
  prompt: string;
  recentHistory: { role: string; content: string }[];
  modelSpines?: { model: any; spine: string }[];
  cacheIndex?: { filename: string; source: string; type: string; title?: string; summary: string; cachedAt: string; brief?: string; tags?: string[]; relatedModels?: string[] }[];
  deviceId?: string;
}): Promise<TailorResult> {
  const { llm, prompt, recentHistory, modelSpines, cacheIndex, deviceId } = opts;

  // Build conversation history text
  const historyText = recentHistory.length > 0
    ? recentHistory
        .map(h => `${h.role === "user" ? "Human" : "Assistant"}: ${h.content}`)
        .join("\n")
    : "(No recent conversation history)";

  // Build memory model summaries for context resolution
  const memoryModelsText = modelSpines && modelSpines.length > 0
    ? modelSpines.map(s => `- ${s.spine}`).join("\n")
    : "(No memory models stored yet)";

  // Build research cache summary for the tailor — show enriched data when available
  const cacheText = cacheIndex && cacheIndex.length > 0
    ? cacheIndex.map(e => {
        const label = e.title || e.source;
        const date = e.cachedAt.slice(0, 10);
        const tags = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
        const brief = e.brief ? ` — ${e.brief}` : "";
        return `- **${e.filename}**: ${label} (${e.type}, ${date})${tags}${brief}`;
      }).join("\n")
    : "(No cached research)";

  // Build the tailor prompt
  const tailorPrompt = await loadPrompt("dot/pre-dot/prompts/tailor.md", {
    MemoryModels: memoryModelsText,
    ResearchCache: cacheText,
    ConversationHistory: historyText,
    UserMessage: prompt,
  });

  // Build the schema (static — no principle fields)
  const responseSchema = buildTailorSchema();

  try {
    const { selectedModel, client } = await resolveModelAndClient(
      llm,
      { explicitRole: "assistant" },
      deviceId,
    );

    log.info("Calling tailor LLM", {
      model: selectedModel.model,
      historyCount: recentHistory.length,
    });

    const response = await client.chat(
      [{ role: "user", content: tailorPrompt }],
      {
        model: selectedModel.model,
        maxTokens: 2048,
        temperature: 0.2,
        responseFormat: "json_object",
        responseSchema,
      },
    );

    log.info("Tailor LLM responded", {
      model: response.model,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    });

    // Parse the response
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn("No JSON found in tailor response, returning empty result");
      return { restatedRequest: null, complexity: null, contextConfidence: null, relevantCache: [], relevantMemories: [], relevantModels: [], manufacturedHistory: [], topicSegments: [], skillSearchQuery: null, skillFeedback: null };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, any>;

    // Extract context resolution fields
    const restatedRequest = typeof parsed.restatedRequest === "string" ? parsed.restatedRequest : null;
    const complexity = typeof parsed.complexity === "number" ? parsed.complexity : null;
    const contextConfidence = typeof parsed.contextConfidence === "number" ? parsed.contextConfidence : null;
    const relevantCache = Array.isArray(parsed.relevantCache) ? parsed.relevantCache.filter((f: any) => typeof f === "string") : [];
    const relevantMemories = Array.isArray(parsed.relevantMemories)
      ? parsed.relevantMemories
          .filter((m: any) => m && typeof m.name === "string" && typeof m.confidence === "number")
          .map((m: any) => ({ name: m.name as string, confidence: m.confidence as number }))
      : [];
    const relevantModels = relevantMemories.map(m => m.name);
    const manufacturedHistory = Array.isArray(parsed.manufacturedHistory)
      ? parsed.manufacturedHistory
          .filter((t: any) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
          .slice(0, 4) // hard cap at 4 turns
          .map((t: any) => ({ role: t.role as "user" | "assistant", content: t.content as string }))
      : [];

    // Parse topic segments (only populated when 2+ models are relevant)
    const topicSegments = Array.isArray(parsed.topicSegments)
      ? parsed.topicSegments
          .filter((s: any) => s && typeof s.text === "string" && s.text.length > 0)
          .map((s: any) => ({
            text: s.text as string,
            modelSlug: typeof s.modelSlug === "string" ? s.modelSlug : null,
            history: Array.isArray(s.history)
              ? s.history
                  .filter((t: any) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
                  .slice(0, 4)
                  .map((t: any) => ({ role: t.role as "user" | "assistant", content: t.content as string }))
              : [],
          }))
      : [];

    // Parse skill search fields (only meaningful when complexity >= 4)
    const skillSearchQuery = typeof parsed.skillSearchQuery === "string" ? parsed.skillSearchQuery : null;
    const skillFeedback = typeof parsed.skillFeedback === "string" ? parsed.skillFeedback : null;

    log.info("Tailor complete", {
      complexity,
      contextConfidence,
      restatedLength: restatedRequest?.length || 0,
      relevantCacheCount: relevantCache.length,
      relevantMemoryCount: relevantMemories.length,
      relevantModels,
      skillSearchQuery,
    });

    return { restatedRequest, complexity, contextConfidence, relevantCache, relevantMemories, relevantModels, manufacturedHistory, topicSegments, skillSearchQuery, skillFeedback };
  } catch (err) {
    log.error("Tailor LLM call failed", { error: err });
    return { restatedRequest: null, complexity: null, contextConfidence: null, relevantCache: [], relevantMemories: [], relevantModels: [], manufacturedHistory: [], topicSegments: [], skillSearchQuery: null, skillFeedback: null };
  }
}
