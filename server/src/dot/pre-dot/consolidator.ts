/**
 * Consolidator — Pre-Dot Pipeline
 *
 * Receives always-on rules + task-selected principles from the selector,
 * then merges them into a single unified briefing via LLM.
 *
 * Falls back to raw concatenation if the LLM call fails.
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { sendRunLog } from "../../ws/bridge/notifications.js";
import { loadPrompt } from "../../prompt-template.js";
import type { ILLMClient } from "#llm/types.js";
import type { PrincipleFile, TailorResult } from "./types.js";

const log = createComponentLogger("dot.consolidator");

/**
 * Consolidate rules + selected principles into a single unified briefing via LLM.
 *
 * The consolidator receives:
 *   - Always-on rules (type: "rule") — core behavioral rules
 *   - Task-selected principles (type: "principle") — chosen by the selector
 *
 * It merges all of them into one coherent, situation-specific directive block
 * that gets prepended to the user message for Dot.
 *
 * Falls back to raw concatenation if the LLM call fails.
 */
export async function consolidatePrinciples(opts: {
  llm: ILLMClient;
  rules: PrincipleFile[];
  selectedPrinciples: PrincipleFile[];
  tailorResult: TailorResult;
  userId: string;
  deviceId?: string;
}): Promise<string> {
  const { llm, rules, selectedPrinciples, tailorResult, userId, deviceId } = opts;
  const { restatedRequest, complexity } = tailorResult;

  // Build sections: rules first, then selected principles
  const applicableSections: string[] = [];
  for (const r of rules) {
    applicableSections.push(`### ${r.id} (rule)\n\n${r.body}`);
  }
  for (const p of selectedPrinciples) {
    applicableSections.push(`### ${p.id}\n\n${p.body}`);
  }

  // If nothing to consolidate, return empty
  if (applicableSections.length === 0) {
    return "";
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
    sendRunLog(userId, {
      stage: "write_log",
      subfolder: "principals-log",
      filename: `${ts}.md`,
      content: `# Governing Principles\n\n${consolidated}\n\n---\n\n**Request:** ${restatedRequest || "(none)"}\n**Complexity:** ${complexity}\n**Rules:** ${rules.length}\n**Principles:** ${selectedPrinciples.map(p => p.id).join(", ") || "(none)"}`,
    });

    log.info("Consolidator complete", {
      model: response.model,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      outputLength: consolidated.length,
    });

    if (!consolidated || consolidated.length < 50) {
      log.warn("Consolidator produced empty/short output, falling back to raw concatenation");
      return fallbackConcatenate(rules, selectedPrinciples);
    }

    return "\n\n---\n\n## Situation-Specific Guidance\n\n" + consolidated;
  } catch (err) {
    log.error("Consolidator LLM call failed, falling back to raw concatenation", { error: err });
    return fallbackConcatenate(rules, selectedPrinciples);
  }
}

/**
 * Fallback: concatenate rule + principle bodies without LLM rewriting.
 * Used when the consolidator LLM call fails or produces insufficient output.
 */
function fallbackConcatenate(rules: PrincipleFile[], principles: PrincipleFile[]): string {
  const sections: string[] = [];
  for (const r of rules) {
    sections.push(`## ${r.id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}\n\n${r.body}`);
  }
  for (const p of principles) {
    sections.push(`## ${p.id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}\n\n${p.body}`);
  }
  if (sections.length === 0) return "";
  return "\n\n---\n\n## Situation-Specific Guidance\n\n" + sections.join("\n\n---\n\n");
}
