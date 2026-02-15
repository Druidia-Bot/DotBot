/**
 * Dot — Root-Level Conversational Assistant
 *
 * Dot is the user-facing assistant that sits at the root of every interaction.
 * She converses naturally, handles quick tasks with her own tools, and dispatches
 * complex work to the full pipeline when needed.
 *
 * Flow:
 *   1. Build context (memory, history, tools, identity)
 *   2. Build Dot's system prompt (identity + memory)
 *   3. Run tool loop (Dot converses, uses tools, may dispatch)
 *   4. Return Dot's response
 *
 * Intake classification only runs when Dot dispatches to the pipeline.
 * Dot uses the workhorse LLM role for her tool loop.
 */

import { createComponentLogger } from "#logging.js";
import { buildRequestContext } from "#pipeline/context/context-builder.js";
import { fetchAllModelSpines } from "#pipeline/context/memory.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { loadPrompt } from "../prompt-template.js";
import { runToolLoop } from "#tool-loop/loop.js";
import { sendRunLog } from "#ws/device-bridge.js";
import { runPipeline } from "#pipeline/pipeline.js";
import { buildDotTools } from "./tools/index.js";
import type { DotOptions, DotResult } from "./types.js";
import type { LLMMessage } from "#llm/types.js";
import type { ToolContext } from "#tool-loop/types.js";
import type { EnhancedPromptRequest } from "../types/agent.js";

const log = createComponentLogger("dot");

const DOT_MAX_ITERATIONS = 10;
const DOT_MAX_TOKENS = 4096;

// ============================================
// MAIN ENTRY
// ============================================

export async function runDot(opts: DotOptions): Promise<DotResult> {
  const { llm, userId, deviceId, prompt, messageId, source } = opts;

  log.info("Dot handling message", { messageId, promptLength: prompt.length });

  // ── Step 1: Build context + fetch model spines in parallel ──
  const [{ enhancedRequest, toolManifest }, modelSpines] = await Promise.all([
    buildRequestContext(deviceId, userId, prompt),
    fetchAllModelSpines(deviceId),
  ]);

  // Persist run-log
  sendRunLog(userId, {
    stage: "dot-start",
    messageId,
    prompt: prompt.slice(0, 500),
    memoryModelCount: modelSpines.length,
    historyCount: enhancedRequest.recentHistory?.length || 0,
    timestamp: new Date().toISOString(),
  });

  // ── Step 2: Build Dot's system prompt (with pre-rendered model spines) ──
  const systemPrompt = await buildDotSystemPrompt(enhancedRequest, modelSpines);

  // ── Step 3: Select model (assistant — fast, non-reasoning) ──
  const { selectedModel, client } = await resolveModelAndClient(llm, { explicitRole: "assistant" }, deviceId);

  // ── Step 4: Dispatch closure ──
  let dispatchResult: DotResult["dispatch"] | undefined;

  const onDispatch = async (enrichedPrompt: string) => {
    log.info("Dot dispatching to pipeline", {
      promptLength: enrichedPrompt.length,
      messageId,
    });

    // Dot's enriched prompt becomes the pipeline's prompt — the pipeline
    // builds its own context, runs intake, receptionist, etc. from scratch.
    const pipelineResult = await runPipeline({
      llm,
      userId,
      deviceId,
      prompt: enrichedPrompt,
      messageId,
      source: "dot-dispatch",
    });

    const result = {
      agentId: pipelineResult.agentId,
      workspacePath: pipelineResult.workspacePath,
      success: pipelineResult.executionSuccess,
      executionResponse: pipelineResult.executionResponse,
    };

    dispatchResult = result;
    return result;
  };

  // ── Step 5: Build tool set ──
  const { definitions: tools, handlers } = buildDotTools(toolManifest, onDispatch);

  // ── Step 6: Build messages ──
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Inject conversation history
  if (enhancedRequest.recentHistory.length > 0) {
    for (const h of enhancedRequest.recentHistory) {
      messages.push({
        role: h.role === "user" ? "user" : "assistant",
        content: h.content,
      });
    }
  }

  // Current user message
  messages.push({ role: "user", content: prompt });

  // ── Step 7: Build tool context ──
  const ctx: ToolContext = {
    deviceId,
    state: {
      userId,
      llmClient: client,
    },
  };

  // ── Step 8: Run tool loop ──
  log.info("Starting Dot tool loop", {
    messageId,
    toolCount: tools.length,
    model: selectedModel.model,
  });

  const loopResult = await runToolLoop({
    client,
    model: selectedModel.model,
    maxTokens: DOT_MAX_TOKENS,
    messages,
    tools,
    handlers,
    maxIterations: DOT_MAX_ITERATIONS,
    temperature: 0.3,
    context: ctx,
    personaId: "dot",
    onStream: opts.onStream
      ? (_personaId, chunk, _done) => opts.onStream!(chunk)
      : undefined,
    onToolCall: (tool, args) => {
      log.info("Dot tool call", { tool, argKeys: Object.keys(args) });
    },
    onToolResult: (tool, _result, success) => {
      log.info("Dot tool result", { tool, success });
    },
  });

  const response = loopResult.finalContent || "(Dot had nothing to say)";

  // ── Step 9: Persist run-log ──
  sendRunLog(userId, {
    stage: "dot-complete",
    messageId,
    toolCallCount: loopResult.toolCallsMade.length,
    tools: loopResult.toolCallsMade.map(t => t.tool),
    dispatched: !!dispatchResult,
    iterations: loopResult.iterations,
    responseLength: response.length,
    timestamp: new Date().toISOString(),
  });

  log.info("Dot complete", {
    messageId,
    dispatched: !!dispatchResult,
    toolCalls: loopResult.toolCallsMade.length,
    responseLength: response.length,
  });

  return {
    response,
    dispatched: !!dispatchResult,
    threadId: enhancedRequest.activeThreadId || "conversation",
    dispatch: dispatchResult,
  };
}

// ============================================
// SYSTEM PROMPT BUILDER
// ============================================

const MAX_MEMORY_MODELS = 50;

async function buildDotSystemPrompt(
  request: EnhancedPromptRequest,
  modelSpines: { model: any; spine: string }[],
): Promise<string> {
  const identity = request.agentIdentity || "Name: Dot\nRole: Personal AI Assistant";

  let memoryModels: string;
  if (modelSpines.length > 0) {
    const sorted = [...modelSpines].sort((a, b) =>
      (b.model.lastUpdatedAt || b.model.createdAt || "").localeCompare(a.model.lastUpdatedAt || a.model.createdAt || "")
    );
    const capped = sorted.slice(0, MAX_MEMORY_MODELS);
    memoryModels = capped.map(s => s.spine).join("\n---\n\n");
    if (sorted.length > MAX_MEMORY_MODELS) {
      memoryModels += `\n\n*(${sorted.length - MAX_MEMORY_MODELS} older models omitted — use \`memory.search\` to find them)*`;
    }
  } else {
    memoryModels = "(No memory models available)";
  }

  const now = new Date();
  const dateTime = now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const fields: Record<string, string> = {
    "Identity": identity,
    "DateTime": dateTime,
    "MemoryModels": memoryModels,
  };

  return loadPrompt("dot/dot.md", fields);
}

