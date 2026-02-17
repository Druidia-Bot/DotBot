/**
 * Consolidator — Pass 2
 *
 * Takes the tailor's selections (pass 1) and the full principle bodies,
 * then merges applicable principles into a single unified briefing via LLM.
 *
 * Falls back to the assembler if the LLM call fails or if too few
 * principles apply to justify the extra latency.
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { sendRunLog } from "../../ws/bridge/notifications.js";
import { loadPrompt } from "../../prompt-template.js";
import { assembleTailoredPrinciples } from "./assembler.js";
import type { ILLMClient } from "#llm/types.js";
import type { TailorResult } from "./types.js";

const log = createComponentLogger("dot.consolidator");

/**
 * Consolidate applicable principles into a single unified briefing via LLM.
 *
 * Pass 2 of the two-pass pipeline:
 *   Pass 1 (tailor): selects which principles apply, restates request, scores complexity
 *   Pass 2 (consolidator): reads full bodies of applicable principles, merges into one
 *                           coherent directive block prepended to the user message
 *
 * Falls back to assembleTailoredPrinciples() if the LLM call fails.
 */
export async function consolidatePrinciples(opts: {
  llm: ILLMClient;
  tailorResult: TailorResult;
  userId: string;
  deviceId?: string;
}): Promise<string> {
  const { llm, tailorResult, userId, deviceId } = opts;
  const { tailored, principles, restatedRequest, complexity } = tailorResult;

  // If tailor didn't run or nothing applies, use fast fallback
  if (Object.keys(tailored).length === 0) {
    return assembleTailoredPrinciples(tailorResult);
  }

  // Collect applicable principle bodies (full content, not summaries)
  const applicableSections: string[] = [];
  for (const p of principles) {
    if (tailored[p.id] !== null && tailored[p.id] !== undefined) {
      applicableSections.push(`### ${p.id}\n\n${p.body}`);
    } else if (p.always) {
      applicableSections.push(`### ${p.id} (always-on)\n\n${p.body}`);
    }
  }

  try {
    const { selectedModel, client } = await resolveModelAndClient(
      llm,
      { explicitRole: "assistant" },
      deviceId,
    );

    const consolidatorPrompt = await loadPrompt("dot/pre-dot/prompts/consolidator.md", {
      RestatedRequest: restatedRequest || "(no restated request)",
      Complexity: String(complexity ?? "unknown"),
      ApplicablePrinciples: applicableSections.join("\n\n---\n\n"),
    });

    log.info("Calling consolidator LLM", {
      model: selectedModel.model,
      principleCount: applicableSections.length,
    });

    const response = await client.chat(
      [{ role: "user", content: consolidatorPrompt }],
      {
        model: selectedModel.model,
        maxTokens: 1500,
        temperature: 0.2,
      },
    );

    const consolidated = response.content.trim();

    // Fire-and-forget: send consolidated output to local agent for persistence
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const relevantModels = tailorResult.relevantModels || [];
    const manufacturedHistory = tailorResult.manufacturedHistory || [];
    const topicSegments = tailorResult.topicSegments || [];
    const tailorSection = [
      `## Tailor Result\n`,
      `**Relevant Models:** ${relevantModels.length > 0 ? relevantModels.join(", ") : "(none)"}`,
      `**Manufactured History:** ${manufacturedHistory.length} turns`,
      ...manufacturedHistory.map((t: any) => `  - [${t.role}] ${(t.content || "").slice(0, 200)}`),
      `**Topic Segments:** ${topicSegments.length > 0 ? topicSegments.length + " segments" : "(single-topic)"}`,
      ...topicSegments.map((s: any) => `  - model=${s.modelSlug || "null"} text="${(s.text || "").slice(0, 150)}"`),
    ].join("\n");

    sendRunLog(userId, {
      stage: "write_log",
      subfolder: "principals-log",
      filename: `${ts}.md`,
      content: `# Governing Principles\n\n${consolidated}\n\n---\n\n${tailorSection}\n\n---\n\n**Request:** ${restatedRequest || "(none)"}\n**Complexity:** ${complexity}\n**Principles applied:** ${applicableSections.length}`,
    });

    log.info("Consolidator complete", {
      model: response.model,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      outputLength: consolidated.length,
    });

    if (!consolidated || consolidated.length < 50) {
      log.warn("Consolidator produced empty/short output, falling back");
      return assembleTailoredPrinciples(tailorResult);
    }

    return "\n\n---\n\n## Situation-Specific Guidance\n\n" + consolidated;
  } catch (err) {
    log.error("Consolidator LLM call failed, falling back to assembled principles", { error: err });
    return assembleTailoredPrinciples(tailorResult);
  }
}
