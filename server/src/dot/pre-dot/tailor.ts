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
import type { PrincipleFile, TailorResult } from "./types.js";

const log = createComponentLogger("dot.tailor");

// ============================================
// SCHEMA BUILDER
// ============================================

/**
 * Build a JSON schema dynamically from the loaded principles.
 * Includes restatedRequest and complexity as top-level fields,
 * plus one string property per principle.
 */
export function buildTailorSchema(principles: PrincipleFile[]): {
  name: string;
  schema: Record<string, unknown>;
} {
  const properties: Record<string, unknown> = {
    restatedRequest: {
      type: "string",
      description: "The user's request restated with all ambiguous references (it, that, the project, etc.) resolved to their concrete meaning from conversation history. If the message is already clear, restate it faithfully.",
    },
    complexity: {
      type: "number",
      description: "Complexity score 0-10. 0-2: casual chat/greeting. 3-4: single tool call. 5-6: multi-step but few tools. 7-8: research + synthesis, multiple external fetches. 9-10: large project needing dedicated agent.",
    },
    relevantCache: {
      type: "array",
      items: { type: "string" },
      description: "Filenames from the research cache that are relevant to the user's current request. Return an empty array if none are relevant.",
    },
    relevantModels: {
      type: "array",
      items: { type: "string" },
      description: "Slugs of memory models that the user's CURRENT MESSAGE explicitly references or is clearly about. Do NOT match models just because they appear in older conversation history or condensed summaries. Return an empty array if none are relevant or if this is casual chat.",
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
  };
  const required: string[] = ["restatedRequest", "complexity", "relevantCache", "relevantModels", "manufacturedHistory", "topicSegments"];

  for (const p of principles) {
    properties[p.id] = {
      type: "string",
      description: `Tailored directive for "${p.summary}", or "does_not_apply" if not relevant.`,
    };
    required.push(p.id);
  }

  return {
    name: "tailor_result",
    schema: {
      type: "object",
      properties,
      required,
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
  principles: PrincipleFile[];
  modelSpines?: { model: any; spine: string }[];
  cacheIndex?: { filename: string; source: string; type: string; title?: string; summary: string; cachedAt: string; brief?: string; tags?: string[]; relatedModels?: string[] }[];
  deviceId?: string;
}): Promise<TailorResult> {
  const { llm, prompt, recentHistory, principles, modelSpines, cacheIndex, deviceId } = opts;

  if (principles.length === 0) {
    return { restatedRequest: null, complexity: null, relevantCache: [], relevantModels: [], manufacturedHistory: [], topicSegments: [], tailored: {}, principles };
  }

  // Build conversation history text
  const historyText = recentHistory.length > 0
    ? recentHistory
        .map(h => `${h.role === "user" ? "Human" : "Assistant"}: ${h.content}`)
        .join("\n")
    : "(No recent conversation history)";

  // Build principle summaries for the prompt
  const summaryLines = principles.map(
    (p, i) => `${i + 1}. **${p.id}**: ${p.summary}`
  ).join("\n");

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
    PrincipleSummaries: summaryLines,
  });

  // Build the schema
  const responseSchema = buildTailorSchema(principles);

  try {
    const { selectedModel, client } = await resolveModelAndClient(
      llm,
      { explicitRole: "assistant" },
      deviceId,
    );

    log.info("Calling tailor LLM", {
      model: selectedModel.model,
      principleCount: principles.length,
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
      log.warn("No JSON found in tailor response, falling back to raw principles");
      return { restatedRequest: null, complexity: null, relevantCache: [], relevantModels: [], manufacturedHistory: [], topicSegments: [], tailored: {}, principles };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, any>;

    // Extract context resolution fields
    const restatedRequest = typeof parsed.restatedRequest === "string" ? parsed.restatedRequest : null;
    const complexity = typeof parsed.complexity === "number" ? parsed.complexity : null;
    const relevantCache = Array.isArray(parsed.relevantCache) ? parsed.relevantCache.filter((f: any) => typeof f === "string") : [];
    const relevantModels = Array.isArray(parsed.relevantModels) ? parsed.relevantModels.filter((s: any) => typeof s === "string") : [];
    const manufacturedHistory = Array.isArray(parsed.manufacturedHistory)
      ? parsed.manufacturedHistory
          .filter((t: any) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
          .slice(0, 4) // hard cap at 4 turns
          .map((t: any) => ({ role: t.role as "user" | "assistant", content: t.content as string }))
      : [];

    // Build the tailored map — null for "does_not_apply"
    const tailored: Record<string, string | null> = {};
    for (const p of principles) {
      const value = parsed[p.id];
      if (!value || value === "does_not_apply") {
        tailored[p.id] = null;
      } else {
        tailored[p.id] = value;
      }
    }

    const appliedCount = Object.values(tailored).filter(v => v !== null).length;
    log.info("Tailor complete", {
      complexity,
      restatedLength: restatedRequest?.length || 0,
      principlesApplied: appliedCount,
      principlesSkipped: principles.length - appliedCount,
      relevantCacheCount: relevantCache.length,
      relevantModelCount: relevantModels.length,
      relevantModels,
    });

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

    return { restatedRequest, complexity, relevantCache, relevantModels, manufacturedHistory, topicSegments, tailored, principles };
  } catch (err) {
    log.error("Tailor LLM call failed, falling back to raw principles", { error: err });
    return { restatedRequest: null, complexity: null, relevantCache: [], relevantModels: [], manufacturedHistory: [], topicSegments: [], tailored: {}, principles };
  }
}
