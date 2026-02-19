/**
 * Dispatch Followup — Pipeline Completion Delivery
 *
 * After Dot dispatches a task to the pipeline, this module handles:
 * - Building the onDispatch closure (fire-and-forget pipeline launch)
 * - Generating an LLM summary of the pipeline result
 * - Broadcasting the followup to the user (Discord + browser)
 * - Fallback delivery when the LLM summary or pipeline itself fails
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { buildDotSystemPrompt } from "./system-prompt.js";
import { sendSaveToThread } from "#ws/device-bridge.js";
import { broadcastToUser } from "#ws/devices.js";
import { runPipeline } from "#pipeline/pipeline.js";
import type { PipelineResult } from "#pipeline/pipeline.js";
import type { ILLMClient } from "#llm/types.js";
import type { DotResult } from "./types.js";

const log = createComponentLogger("dot.dispatch");

const DOT_MAX_TOKENS = 4096;

// ============================================
// TYPES
// ============================================

export interface DispatchFollowupOpts {
  llm: ILLMClient;
  userId: string;
  deviceId: string;
  messageId: string;
  enhancedRequest: any;
  modelSpines: { model: any; spine: string }[];
  platform?: "windows" | "linux" | "macos" | "web";
  pipelineResult: PipelineResult;
}

export interface OnDispatchDeps {
  llm: ILLMClient;
  userId: string;
  deviceId: string;
  messageId: string;
  enhancedRequest: any;
  modelSpines: { model: any; spine: string }[];
  platform?: "windows" | "linux" | "macos" | "web";
}

// ============================================
// ON-DISPATCH CLOSURE BUILDER
// ============================================

/**
 * Creates the fire-and-forget dispatch closure that Dot's tool handler calls.
 * Returns the closure and a getter for the dispatch result.
 */
export function buildOnDispatch(deps: OnDispatchDeps): {
  onDispatch: (enrichedPrompt: string) => Promise<{ success: boolean }>;
  getDispatchResult: () => DotResult["dispatch"] | undefined;
} {
  const { llm, userId, deviceId, messageId, enhancedRequest, modelSpines, platform } = deps;
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
      // Fallback: notify user even when the pipeline itself crashes
      broadcastToUser(userId, {
        type: "dispatch_followup",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          response: `The dispatched task encountered an error: ${err instanceof Error ? err.message : String(err)}`,
          messageId,
          success: false,
        },
      });
    });

    // Return immediately so Dot can respond to the user
    dispatchResult = { success: true };
    return { success: true };
  };

  return { onDispatch, getDispatchResult: () => dispatchResult };
}

// ============================================
// FOLLOWUP DELIVERY
// ============================================

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
    // Fallback: send raw status so the user isn't left waiting
    const status = pipelineResult.executionSuccess ? "completed successfully" : "failed";
    const fallback = `Your dispatched task ${status}.${pipelineResult.agentId ? ` (Agent: ${pipelineResult.agentId})` : ""}${pipelineResult.executionResponse ? `\n\n${pipelineResult.executionResponse.slice(0, 2000)}` : ""}`;
    try {
      broadcastToUser(userId, {
        type: "dispatch_followup",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          response: fallback,
          messageId,
          agentId: pipelineResult.agentId,
          success: pipelineResult.executionSuccess ?? false,
          workspacePath: pipelineResult.workspacePath,
        },
      });
    } catch { /* last resort — broadcastToUser itself failed */ }
  }
}

// ============================================
// SUMMARY BUILDER
// ============================================

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
