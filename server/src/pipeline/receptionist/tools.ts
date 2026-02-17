/**
 * Receptionist — Tool Definitions & Loop Wrapper
 *
 * Defines which tools the receptionist has access to and wires the generic
 * tool loop with the standard handler registry.
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { loadPrompt } from "../../prompt-template.js";
import { memoryTools, coreToolsToNative, getCoreToolById } from "#tools/core-registry.js";
import { runToolLoop, getMemoryHandlers, getKnowledgeHandlers } from "#tool-loop/index.js";
import type { ILLMClient, LLMMessage, ToolDefinition } from "#llm/types.js";
import type { EnhancedPromptRequest } from "../../types/agent.js";
import type { ClassifyResult } from "../intake/intake.js";
import type { LoopResult } from "./types.js";

const log = createComponentLogger("receptionist.tools");

const MAX_ITERATIONS = 15;
const HISTORY_TOKEN_BUDGET = 8000;
const CHARS_PER_TOKEN = 4;

// ============================================
// TOOLS NEEDED
// ============================================

const RECEPTIONIST_TOOLS: ToolDefinition[] = coreToolsToNative([
  ...memoryTools,
  getCoreToolById("knowledge.search")!,
]);

// ============================================
// PROMPT FIELDS
// ============================================

export function buildReceptionistPromptFields(
  intakeResult: ClassifyResult,
  request: EnhancedPromptRequest,
  relevantModelSummaries: string,
  relatedConversationsText: string,
): Record<string, string> {
  return {
    "Intake Result": JSON.stringify(intakeResult, null, 2),
    "Relevant Memory Models": relevantModelSummaries,
    "Memory Models": request.memoryIndex && request.memoryIndex.length > 0
      ? request.memoryIndex
          .map((m: any) => `- "${m.name}" [${m.slug}] (${m.category}): ${m.description || "no description"}`)
          .join("\n")
      : "(No related memory models)",
    "Related Conversations": relatedConversationsText,
  };
}

// ============================================
// MESSAGE ASSEMBLY
// ============================================

export function buildReceptionistMessages(
  systemPrompt: string,
  conversationHistory: { role: "user" | "assistant"; content: string }[],
  userPrompt: string,
): LLMMessage[] {
  const trimmed = trimToTokenBudget(conversationHistory, HISTORY_TOKEN_BUDGET);

  if (trimmed.length < conversationHistory.length) {
    log.info("Trimmed conversation history to fit token budget", {
      original: conversationHistory.length,
      kept: trimmed.length,
      budgetTokens: HISTORY_TOKEN_BUDGET,
    });
  }

  return [
    { role: "system", content: systemPrompt },
    ...trimmed.map((h) => ({
      role: h.role as "user" | "assistant",
      content: h.content,
    })),
    { role: "user", content: userPrompt },
  ];
}

/**
 * Walk backwards from the newest message, keeping messages until the
 * cumulative estimated token count exceeds the budget. Returns the
 * most recent messages that fit, in chronological order.
 */
function trimToTokenBudget(
  messages: { role: string; content: string }[],
  budgetTokens: number,
): { role: string; content: string }[] {
  let remaining = budgetTokens;
  let cutoff = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = Math.ceil(messages[i].content.length / CHARS_PER_TOKEN);
    if (remaining - tokens < 0) break;
    remaining -= tokens;
    cutoff = i;
  }

  return messages.slice(cutoff);
}

// ============================================
// HANDLER REGISTRY
// ============================================

export function buildReceptionistHandlers(): Map<string, import("#tool-loop/types.js").ToolHandler> {
  const handlers = getMemoryHandlers();
  for (const [id, handler] of getKnowledgeHandlers()) {
    handlers.set(id, handler);
  }
  return handlers;
}

// ============================================
// SHARED STATE
// ============================================

export function createReceptionistState(userPrompt: string): Record<string, any> {
  return {
    userPrompt,
    resurfacedModels: [] as string[],
    newModelsCreated: [] as string[],
    savedToModels: [] as string[],
    knowledgeGathered: [] as { query: string; content: string }[],
    knowledgeSearchCount: 0,
  };
}

// ============================================
// RECEPTIONIST LOOP (orchestrator)
// ============================================

export async function runReceptionistLoop(
  llm: ILLMClient,
  request: EnhancedPromptRequest,
  intakeResult: ClassifyResult,
  conversationHistory: { role: "user" | "assistant"; content: string }[],
  relevantModelSummaries: string,
  relatedConversationsText: string,
  deviceId: string,
): Promise<LoopResult> {
  const { selectedModel: modelConfig, client } = await resolveModelAndClient(
    llm, { explicitRole: "intake" }
  );

  const fields = buildReceptionistPromptFields(intakeResult, request, relevantModelSummaries, relatedConversationsText);
  const systemPrompt = await loadPrompt("pipeline/receptionist/receptionist.md", fields);
  const messages = buildReceptionistMessages(systemPrompt, conversationHistory, request.prompt);
  const handlers = buildReceptionistHandlers();
  const state = createReceptionistState(request.prompt);

  log.info("Starting receptionist tool loop", {
    systemLength: systemPrompt.length,
    historyMessages: conversationHistory.length,
    model: modelConfig.model,
  });

  const result = await runToolLoop({
    client,
    model: modelConfig.model,
    maxTokens: modelConfig.maxTokens,
    messages,
    tools: RECEPTIONIST_TOOLS,
    handlers,
    maxIterations: MAX_ITERATIONS,
    temperature: 0.1,
    context: { deviceId, state },
  });

  log.info("Receptionist loop finished", { iterations: result.iterations });

  return {
    resurfacedModels: state.resurfacedModels as string[],
    newModelsCreated: state.newModelsCreated as string[],
    savedToModels: state.savedToModels as string[],
    knowledgeGathered: state.knowledgeGathered as { query: string; content: string }[],
    knowledgeSearchCount: (state.knowledgeSearchCount as number) || 0,
  };
}
