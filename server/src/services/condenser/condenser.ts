/**
 * Condenser — Orchestrator
 *
 * Called by the local agent's sleep cycle. Receives a thread + model context,
 * uses an LLM to analyze the conversation, and returns structured instructions
 * that the local agent applies programmatically.
 *
 * The LLM NEVER rewrites full models — it only returns atomic operations:
 * add_belief, remove_belief, close_loop, archive_thread, etc.
 *
 * Follows the standard prompt pattern:
 * - condenser.md             — prompt template with |* Field *| placeholders
 * - condenser.schema.json    — JSON schema sent to LLM for structured output
 * - loop-resolver.md         — resolver prompt template
 * - loop-resolver.schema.json — resolver response schema
 */

import { createLLMClient } from "#llm/factory.js";
import { selectModel } from "#llm/selection/model-selector.js";
import { loadPrompt, loadSchema } from "../../prompt-template.js";
import { createComponentLogger } from "#logging.js";
import type { CondenserOptions, CondenserRequest, CondenserResult } from "./types.js";

export type { CondenserOptions, CondenserRequest, CondenserResult } from "./types.js";

const log = createComponentLogger("condenser");

// ── Formatters ──────────────────────────────────────────────────────

function formatModelIndex(
  index: CondenserRequest["modelIndex"],
): string {
  if (!index.length) return "No existing models.";
  return index
    .map(m => `- ${m.slug}: "${m.name}" (${m.category}) [${m.keywords.join(", ")}]`)
    .join("\n");
}

function formatRelevantModels(models: any[]): string {
  if (models.length === 0) return "No relevant models loaded.";

  return models.map(m => {
    const beliefs = (m.beliefs || [])
      .map((b: any) => `${b.attribute}=${JSON.stringify(b.value)} (confidence: ${b.confidence})`)
      .join(", ") || "none";
    const loops = (m.openLoops || [])
      .filter((l: any) => l.status !== "resolved")
      .map((l: any) => `[${l.id}] ${l.description}`)
      .join(", ") || "none";
    const constraints = (m.constraints || [])
      .filter((c: any) => c.active)
      .map((c: any) => `[${c.type}] ${c.description}`)
      .join(", ") || "none";

    return [
      `### ${m.name} (${m.slug})`,
      `Category: ${m.category}`,
      `Beliefs: ${beliefs}`,
      `Open Loops: ${loops}`,
      `Constraints: ${constraints}`,
    ].join("\n");
  }).join("\n\n");
}

function formatThread(thread: any, messages: any[]): string {
  const conversationStr = messages
    .map((m: any) => `[${m.role || "unknown"}]: ${m.content}`)
    .join("\n");

  return `"${thread.topic || "Untitled"}" (ID: ${thread.id})\n${messages.length} messages:\n${conversationStr}`;
}

function filterNewMessages(thread: any, lastCycleAt?: string): any[] {
  let messages = thread.messages || [];
  if (lastCycleAt) {
    const cutoff = new Date(lastCycleAt).getTime();
    messages = messages.filter((m: any) => {
      const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
      return ts > cutoff;
    });
  }
  return messages;
}

// ── Parse ───────────────────────────────────────────────────────────

function parseCondenserResponse(content: string): CondenserResult {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { instructions: [], reasoning: "Condenser returned no JSON." };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      instructions: parsed.instructions || [],
      reasoning: parsed.reasoning || "",
    };
  } catch (e) {
    return { instructions: [], reasoning: `Parse error: ${e}` };
  }
}

// ── Entry Point ─────────────────────────────────────────────────────

export async function runCondenser(
  request: CondenserRequest,
  options: CondenserOptions,
): Promise<CondenserResult> {
  const llm = createLLMClient({ apiKey: options.apiKey, provider: options.provider || "deepseek" });
  const modelConfig = selectModel({ explicitRole: "workhorse" });

  const messages = filterNewMessages(request.thread, request.lastCycleAt);
  if (messages.length === 0) {
    return { instructions: [], reasoning: "No new messages since last cycle." };
  }

  const [prompt, condenserSchema] = await Promise.all([
    loadPrompt("condenser/condenser.md", {
      Identity: request.identity || "Name: Dot\nRole: AI Assistant",
      Thread: formatThread(request.thread, messages),
      ModelIndex: formatModelIndex(request.modelIndex),
      RelevantModels: formatRelevantModels(request.relevantModels),
    }),
    loadSchema("condenser/condenser.schema.json"),
  ]);

  log.info("Running condenser", {
    threadId: request.thread.id,
    messageCount: messages.length,
    modelCount: request.modelIndex.length,
  });

  const response = await llm.chat(
    [{ role: "user", content: prompt }],
    {
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
      temperature: 0.3,
      responseFormat: "json_object",
      responseSchema: { name: "memory_condenser", schema: condenserSchema },
    },
  );

  return parseCondenserResponse(response.content);
}
