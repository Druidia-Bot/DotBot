/**
 * Dot — Root-Level Conversational Assistant
 *
 * Dot is the user-facing assistant that sits at the root of every interaction.
 * She converses naturally, handles quick tasks with her own tools, and dispatches
 * complex work to the full pipeline when needed.
 *
 * Flow:
 *   1. prepareDot()  — (pre-dot/) build context, tailor principles, resolve prompt
 *   2. (caller saves resolvedPrompt to thread)
 *   3. runDot()       — build system prompt, run tool loop, return response
 *
 * Intake classification only runs when Dot dispatches to the pipeline.
 * Dot uses the workhorse LLM role for her tool loop.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { buildDotSystemPrompt } from "./system-prompt.js";
import { buildSingleTopicMessages, buildSegmentMessages } from "./message-builder.js";
import { runToolLoop } from "#tool-loop/loop.js";
import { sendRunLog, sendSaveToThread } from "#ws/device-bridge.js";
import { broadcastToUser } from "#ws/devices.js";
import { runPipeline } from "#pipeline/pipeline.js";
import { buildDotTools } from "./tools/index.js";
import type { PipelineResult } from "#pipeline/pipeline.js";
import type { DotInternalContext } from "./pre-dot/index.js";
import type { DotOptions, DotPreparedContext, DotResult } from "./types.js";
import type { ToolContext } from "#tool-loop/types.js";

const log = createComponentLogger("dot");

const DOT_MAX_ITERATIONS = 10;
const DOT_MAX_TOKENS = 4096;

// ============================================
// MAIN ENTRY
// ============================================

/**
 * Runs Dot's tool loop using the prepared context from `prepareDot()`.
 *
 * The caller should save the resolved prompt to the conversation thread
 * between `prepareDot()` and this call.
 */
export async function runDot(opts: DotOptions, prepared: DotPreparedContext): Promise<DotResult> {
  const { llm, userId, deviceId, messageId, source } = opts;
  const ctx = prepared._internal as DotInternalContext;
  const {
    enhancedRequest,
    toolManifest,
    platform,
    modelSpines,
    tailorResult,
    consolidatedPrinciples,
    resolvedPrompt,
    forceDispatch,
    contextMs,
    dotStartTime,
  } = ctx;

  log.info("Dot starting tool loop", { messageId });

  // ── Build Dot's system prompt (stable identity + knowledge — no per-message content) ──
  const systemPrompt = await buildDotSystemPrompt(enhancedRequest, modelSpines, platform);

  // ── Select model (assistant — fast, non-reasoning) ──
  const { selectedModel, client } = await resolveModelAndClient(llm, { explicitRole: "assistant" }, deviceId);

  // ── Dispatch closure (fire-and-forget so Dot responds immediately) ──
  let dispatchResult: DotResult["dispatch"] | undefined;

  const onDispatch = async (enrichedPrompt: string) => {
    log.info("Dot dispatching to pipeline (async)", {
      promptLength: enrichedPrompt.length,
      messageId,
    });

    // Fire pipeline in background — don't block the tool loop
    runPipeline({
      llm,
      userId,
      deviceId,
      prompt: enrichedPrompt,
      messageId,
      source: "dot-dispatch",
    }).then(async (pipelineResult) => {
      log.info("Background pipeline completed", {
        messageId,
        agentId: pipelineResult.agentId,
        success: pipelineResult.executionSuccess,
      });
      await deliverDispatchFollowup({
        llm, userId, deviceId, messageId,
        enhancedRequest, modelSpines, platform,
        pipelineResult,
      });
    }).catch((err) => {
      log.error("Background pipeline failed", {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Return immediately so Dot can respond to the user
    dispatchResult = { success: true };
    return { success: true };
  };

  // ── Build tool set ──
  const { definitions: tools, handlers, toolHintsById } = buildDotTools(toolManifest, onDispatch);

  // ── Build tool context ──
  const toolCtx: ToolContext = {
    deviceId,
    state: {
      userId,
      llmClient: client,
    },
  };

  // ── Decide: per-topic loop vs single pass ──
  const topicSegments = tailorResult.topicSegments || [];
  const usePerTopicLoop = topicSegments.length >= 2;

  let response = "";
  let totalToolCalls: { tool: string; success: boolean; result?: string }[] = [];
  let totalIterations = 0;

  if (usePerTopicLoop) {
    // ── MULTI-TOPIC: Run a separate tool loop per topic segment ──
    log.info("Per-topic loop activated", {
      messageId,
      segmentCount: topicSegments.length,
      segments: topicSegments.map((s: { modelSlug: string | null; text: string }) => ({ model: s.modelSlug, textLen: s.text.length })),
    });

    const segmentResponses: string[] = [];

    for (let i = 0; i < topicSegments.length; i++) {
      const segment = topicSegments[i];

      const segmentMessages = await buildSegmentMessages({
        systemPrompt,
        deviceId,
        segment,
        tailorResult,
        consolidatedPrinciples,
        forceDispatch,
      });

      log.info(`Running topic segment ${i + 1}/${topicSegments.length}`, {
        messageId,
        modelSlug: segment.modelSlug,
        textPreview: segment.text.slice(0, 100),
      });

      const loopResult = await runToolLoop({
        client,
        model: selectedModel.model,
        maxTokens: DOT_MAX_TOKENS,
        messages: segmentMessages,
        tools,
        toolHintsById,
        handlers,
        maxIterations: DOT_MAX_ITERATIONS,
        temperature: 0.3,
        context: toolCtx,
        personaId: "dot",
        onStream: opts.onStream
          ? (_personaId, chunk, _done) => opts.onStream!(chunk)
          : undefined,
        onToolCall: (tool, args) => {
          log.info("Dot tool call (segment)", { tool, argKeys: Object.keys(args), segment: i + 1 });
        },
        onToolResult: (tool, _result, success) => {
          log.info("Dot tool result (segment)", { tool, success, segment: i + 1 });
        },
      });

      const segmentResponse = loopResult.finalContent || "";
      if (segmentResponse) {
        segmentResponses.push(segmentResponse);
      }
      totalToolCalls.push(...loopResult.toolCallsMade);
      totalIterations += loopResult.iterations;
    }

    response = segmentResponses.join("\n\n---\n\n") || "(Dot had nothing to say)";
  } 
  
  // ── SINGLE-TOPIC: One tool loop with combined context ──
  if(!usePerTopicLoop){    
    const messages = await buildSingleTopicMessages({
      systemPrompt,
      deviceId,
      tailorResult,
      consolidatedPrinciples,
      resolvedPrompt,
      forceDispatch,
    });

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
      toolHintsById,
      handlers,
      maxIterations: DOT_MAX_ITERATIONS,
      temperature: 0.3,
      context: toolCtx,
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

    response = loopResult.finalContent || "(Dot had nothing to say)";
    totalToolCalls = loopResult.toolCallsMade;
    totalIterations = loopResult.iterations;
  }

  const totalMs = Date.now() - dotStartTime;

  // ── Persist run-log ──
  sendRunLog(userId, {
    stage: "dot-complete",
    messageId,
    source,
    model: selectedModel.model,
    provider: selectedModel.provider,
    toolCallCount: totalToolCalls.length,
    tools: totalToolCalls.map(t => ({
      id: t.tool,
      ok: t.success,
      len: t.result?.length || 0,
    })),
    dispatched: !!dispatchResult,
    iterations: totalIterations,
    responseLength: response.length,
    responsePreview: response.slice(0, 200),
    perTopicLoop: usePerTopicLoop,
    segmentCount: usePerTopicLoop ? topicSegments.length : 1,
    contextMs,
    totalMs,
    timestamp: new Date().toISOString(),
  });

  log.info("Dot complete", {
    messageId,
    dispatched: !!dispatchResult,
    toolCalls: totalToolCalls.length,
    responseLength: response.length,
    perTopicLoop: usePerTopicLoop,
  });

  return {
    response,
    dispatched: !!dispatchResult,
    threadId: prepared.threadId,
    dispatch: dispatchResult,
  };
}

// ============================================
// DISPATCH FOLLOWUP
// ============================================

interface DispatchFollowupOpts {
  llm: import("#llm/types.js").ILLMClient;
  userId: string;
  deviceId: string;
  messageId: string;
  enhancedRequest: any;
  modelSpines: { model: any; spine: string }[];
  platform?: "windows" | "linux" | "macos" | "web";
  pipelineResult: PipelineResult;
}

async function deliverDispatchFollowup(opts: DispatchFollowupOpts): Promise<void> {
  const { llm, userId, deviceId, messageId, enhancedRequest, modelSpines, platform, pipelineResult } = opts;

  try {
    const systemPrompt = await buildDotSystemPrompt(enhancedRequest, modelSpines, platform);
    const { selectedModel, client } = await resolveModelAndClient(llm, { explicitRole: "assistant" }, deviceId);

    const summary = buildPipelineSummary(pipelineResult);

    const messages = [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content: [
          "SYSTEM: A task you previously dispatched has completed. Present the results to the user in your natural voice.",
          "Be concise but informative. Mention what was accomplished, whether it succeeded, and where output files are if applicable.",
          "If the task failed, be honest about it and suggest next steps.",
          "",
          "--- Pipeline Result ---",
          summary,
        ].join("\n"),
      },
    ];

    const response = await client.chat(messages, {
      model: selectedModel.model,
      maxTokens: DOT_MAX_TOKENS,
      temperature: 0.3,
    });

    const followupText = response.content || "(Pipeline completed but I couldn't summarize the results.)";

    log.info("Dispatch followup generated", {
      messageId,
      responseLength: followupText.length,
    });

    // Save to conversation thread
    sendSaveToThread(userId, "conversation", {
      role: "assistant",
      content: followupText,
      source: "dot",
      messageId: `followup_${messageId}`,
      dispatched: false,
    });

    // Push to user via dispatch_followup (local agent routes to Discord)
    broadcastToUser(userId, {
      type: "dispatch_followup",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        response: followupText,
        messageId,
        agentId: pipelineResult.agentId,
        success: pipelineResult.executionSuccess ?? true,
        workspacePath: pipelineResult.workspacePath,
      },
    });
  } catch (err) {
    log.error("Dispatch followup failed", {
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildPipelineSummary(result: PipelineResult): string {
  const lines: string[] = [];
  lines.push(`Success: ${result.executionSuccess ?? "unknown"}`);
  if (result.agentId) lines.push(`Agent: ${result.agentId}`);
  if (result.workspacePath) lines.push(`Workspace: ${result.workspacePath}`);
  if (result.knowledgebasePath) lines.push(`Knowledgebase: ${result.knowledgebasePath}`);
  if (result.resurfacedModels?.length) lines.push(`Resurfaced models: ${result.resurfacedModels.join(", ")}`);
  if (result.newModelsCreated?.length) lines.push(`New models created: ${result.newModelsCreated.join(", ")}`);
  if (result.knowledgeGathered) lines.push(`Knowledge gathered: ${result.knowledgeGathered} items`);
  if (result.executionResponse) {
    lines.push("");
    lines.push("--- Execution Output ---");
    lines.push(result.executionResponse.slice(0, 3000));
  }
  return lines.join("\n");
}
