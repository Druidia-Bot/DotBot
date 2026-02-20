/**
 * Dot Loop Runner — Multi-Topic & Single-Topic Tool Loop Execution
 *
 * Handles the decision between running one tool loop (single topic)
 * or multiple loops (one per topic segment), then aggregates results.
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { runToolLoop } from "#tool-loop/loop.js";
import { buildSingleTopicMessages, buildSegmentMessages } from "./message-builder.js";
import type { ToolContext, ToolHandler } from "#tool-loop/types.js";
import type { ILLMClient } from "#llm/types.js";

const log = createComponentLogger("dot.loop");

const DOT_MAX_ITERATIONS = 15;

const DOT_WORKHORSE_AT_ITERATION = 6;
const DOT_ARCHITECT_AT_ITERATION = 10;

function buildTieredEscalation(llm: ILLMClient, deviceId: string) {
  return async (iteration: number) => {
    if (iteration >= DOT_ARCHITECT_AT_ITERATION) {
      const { selectedModel, client } = await resolveModelAndClient(llm, { explicitRole: "architect" }, deviceId);
      return { client, model: selectedModel.model, maxTokens: selectedModel.maxTokens, tier: "architect" };
    }
    if (iteration >= DOT_WORKHORSE_AT_ITERATION) {
      const { selectedModel, client } = await resolveModelAndClient(llm, { explicitRole: "workhorse" }, deviceId);
      return { client, model: selectedModel.model, maxTokens: selectedModel.maxTokens, tier: "workhorse" };
    }
    return null;
  };
}

export interface LoopRunnerOpts {
  messageId: string;
  systemPrompt: string;
  deviceId: string;
  client: any;
  selectedModel: { model: string };
  maxTokens: number;
  tools: any[];
  toolHintsById?: Record<string, { mutating?: boolean; verification?: boolean }>;
  handlers: Map<string, ToolHandler>;
  toolCtx: ToolContext;
  tailorResult: any;
  consolidatedPrinciples: string;
  resolvedPrompt: string;
  forceDispatch: boolean;
  skillNudge: string | null;
  onStream?: (text: string) => void;
  llm: ILLMClient;
}

export interface LoopRunnerResult {
  response: string;
  toolCalls: { tool: string; success: boolean; result?: string }[];
  iterations: number;
  maxIterationsReached: boolean;
}

export async function runDotToolLoop(opts: LoopRunnerOpts): Promise<LoopRunnerResult> {
  const {
    messageId, systemPrompt, deviceId, client, selectedModel, maxTokens,
    tools, toolHintsById, handlers, toolCtx,
    tailorResult, consolidatedPrinciples, resolvedPrompt,
    forceDispatch, skillNudge, onStream,
  } = opts;

  const topicSegments = tailorResult.topicSegments || [];
  const usePerTopicLoop = topicSegments.length >= 2;

  if (usePerTopicLoop) {
    return runMultiTopicLoop({
      messageId, systemPrompt, deviceId, client, selectedModel, maxTokens,
      tools, toolHintsById, handlers, toolCtx,
      tailorResult, consolidatedPrinciples, resolvedPrompt, forceDispatch, skillNudge, onStream,
      llm: opts.llm,
      topicSegments,
    });
  }

  return runSingleTopicLoop({
    messageId, systemPrompt, deviceId, client, selectedModel, maxTokens,
    tools, toolHintsById, handlers, toolCtx,
    tailorResult, consolidatedPrinciples, resolvedPrompt,
    forceDispatch, skillNudge, onStream,
    llm: opts.llm,
  });
}

// ============================================
// MULTI-TOPIC
// ============================================

async function runMultiTopicLoop(opts: LoopRunnerOpts & { topicSegments: any[] }): Promise<LoopRunnerResult> {
  const {
    messageId, systemPrompt, deviceId, client, selectedModel, maxTokens,
    tools, toolHintsById, handlers, toolCtx,
    tailorResult, consolidatedPrinciples, forceDispatch, skillNudge, onStream,
    topicSegments,
  } = opts;

  log.info("Per-topic loop activated", {
    messageId,
    segmentCount: topicSegments.length,
    segments: topicSegments.map((s: { modelSlug: string | null; text: string }) => ({ model: s.modelSlug, textLen: s.text.length })),
  });

  const segmentResponses: string[] = [];
  let totalToolCalls: { tool: string; success: boolean; result?: string }[] = [];
  let totalIterations = 0;

  for (let i = 0; i < topicSegments.length; i++) {
    const segment = topicSegments[i];

    const segmentMessages = await buildSegmentMessages({
      systemPrompt,
      deviceId,
      segment,
      tailorResult,
      consolidatedPrinciples,
      forceDispatch,
      skillNudge: i === 0 ? skillNudge : null,
    });

    log.info(`Running topic segment ${i + 1}/${topicSegments.length}`, {
      messageId,
      modelSlug: segment.modelSlug,
      textPreview: segment.text.slice(0, 100),
    });

    const loopResult = await runToolLoop({
      client,
      model: selectedModel.model,
      maxTokens,
      messages: segmentMessages,
      tools,
      toolHintsById,
      handlers,
      maxIterations: DOT_MAX_ITERATIONS,
      temperature: 0.3,
      context: toolCtx,
      personaId: "dot",
      onModelEscalate: buildTieredEscalation(opts.llm, opts.deviceId),
      onStream: onStream
        ? (_personaId: string, chunk: string, _done: boolean) => onStream(chunk)
        : undefined,
      onToolCall: (tool: string, args: Record<string, any>) => {
        log.info("Dot tool call (segment)", { tool, argKeys: Object.keys(args), segment: i + 1 });
      },
      onToolResult: (tool: string, _result: string, success: boolean) => {
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

  return {
    response: segmentResponses.join("\n\n---\n\n") || "(Dot had nothing to say)",
    toolCalls: totalToolCalls,
    iterations: totalIterations,
    maxIterationsReached: false,
  };
}

// ============================================
// SINGLE-TOPIC
// ============================================

async function runSingleTopicLoop(opts: Omit<LoopRunnerOpts, "topicSegments">): Promise<LoopRunnerResult> {
  const {
    messageId, systemPrompt, deviceId, client, selectedModel, maxTokens,
    tools, toolHintsById, handlers, toolCtx,
    tailorResult, consolidatedPrinciples, resolvedPrompt,
    forceDispatch, skillNudge, onStream,
  } = opts;

  const messages = await buildSingleTopicMessages({
    systemPrompt,
    deviceId,
    tailorResult,
    consolidatedPrinciples,
    resolvedPrompt,
    forceDispatch,
    skillNudge,
  });

  log.info("Starting Dot tool loop", {
    messageId,
    toolCount: tools.length,
    model: selectedModel.model,
  });

  const loopResult = await runToolLoop({
    client,
    model: selectedModel.model,
    maxTokens,
    messages,
    tools,
    toolHintsById,
    handlers,
    maxIterations: DOT_MAX_ITERATIONS,
    temperature: 0.3,
    context: toolCtx,
    personaId: "dot",
    onModelEscalate: buildTieredEscalation(opts.llm, opts.deviceId),
    onStream: onStream
      ? (_personaId: string, chunk: string, _done: boolean) => onStream(chunk)
      : undefined,
    onToolCall: (tool: string, args: Record<string, any>) => {
      log.info("Dot tool call", { tool, argKeys: Object.keys(args) });
    },
    onToolResult: (tool: string, _result: string, success: boolean) => {
      log.info("Dot tool result", { tool, success });
    },
  });

  return {
    response: loopResult.finalContent || "(Dot had nothing to say)",
    toolCalls: loopResult.toolCallsMade,
    iterations: loopResult.iterations,
    maxIterationsReached: !loopResult.completed,
  };
}
