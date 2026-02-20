/**
 * Step Runner — Single Step Execution
 *
 * Executes one step of the plan:
 *   1. Resolves the model (with tiered escalation support)
 *   2. Builds workspace-aware system prompt + user message
 *   3. Runs the tool loop
 *   4. Builds and returns the StepResult
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { sendTaskProgress } from "#ws/device-bridge.js";
import { runToolLoop } from "#tool-loop/loop.js";
import { ESCALATE_TOOL_ID } from "#tool-loop/handlers/synthetic-tools.js";
import { getAbortSignal } from "#pipeline/agent-signals.js";
import { updatePlanProgress, buildToolCallEntry } from "../workspace/plan-progress.js";
import {
  listWorkspaceFiles,
  buildWorkspaceBriefing,
  buildStepUserMessage,
} from "../workspace/workspace-briefing.js";
import { buildStepContext } from "./step-context.js";
import { buildStepToolSet } from "./step-tools.js";
import type { ILLMClient } from "#llm/types.js";
import type { LLMMessage } from "#llm/types.js";
import type { ToolManifestEntry } from "#tools/types.js";
import type {
  Step,
  StepPlan,
  StepResult,
  StepExecutorOptions,
  ToolCallEntry,
} from "../types.js";

const log = createComponentLogger("step-runner");

const STEP_MAX_ITERATIONS = 30;

export interface RunStepDeps {
  llm: ILLMClient;
  userId: string;
  deviceId: string;
  agentId: string;
  workspacePath: string;
  customPrompt: string;
  modelRole: string;
  restatedRequest: string;
  toolManifest: ToolManifestEntry[];
  plan: StepPlan;
  completedSteps: StepResult[];
  remainingSteps: Step[];
  currentStep: Step;
}

export async function runStep(deps: RunStepDeps): Promise<StepResult> {
  const {
    llm, userId, deviceId, agentId, workspacePath, customPrompt,
    modelRole, restatedRequest, toolManifest,
    plan, completedSteps, remainingSteps, currentStep,
  } = deps;

  // Get current workspace contents
  const workspaceFiles = await listWorkspaceFiles(deviceId, workspacePath);

  // Build workspace-aware system prompt
  const workspaceBriefing = await buildWorkspaceBriefing(
    workspacePath,
    workspaceFiles,
    currentStep,
    completedSteps,
    remainingSteps,
  );
  const systemPrompt = `${customPrompt}\n${workspaceBriefing}`;

  // Build the step's user message
  const userMessage = await buildStepUserMessage(restatedRequest, currentStep, completedSteps);

  // Resolve model
  const { selectedModel, client } = await resolveModelAndClient(llm, {
    explicitRole: modelRole as any,
  });

  // Build message array for the tool loop
  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  // Fresh context per step
  const ctx = buildStepContext({
    deviceId, userId, workspacePath,
    stepId: currentStep.id, restatedRequest, client,
  });

  // Build per-step tool set
  const { tools: nativeTools, handlers } = buildStepToolSet(currentStep, toolManifest, workspacePath);

  // Accumulator for real-time tool call tracking in plan.json
  const liveToolCalls: ToolCallEntry[] = [];

  // Tiered model escalation: workhorse@6, architect@10 (skipped if already on architect/gui_fast)
  const skipEscalation = modelRole === "architect" || modelRole === "gui_fast";

  // Run the tool loop
  const loopResult = await runToolLoop({
    client,
    model: selectedModel.model,
    maxTokens: selectedModel.maxTokens,
    temperature: selectedModel.temperature,
    messages,
    tools: nativeTools,
    handlers,
    maxIterations: STEP_MAX_ITERATIONS,
    stopTool: ESCALATE_TOOL_ID,
    context: ctx,
    getAbortSignal: () => getAbortSignal(agentId),
    onModelEscalate: skipEscalation ? undefined : async (iteration) => {
      if (iteration >= 10) {
        const { selectedModel: upgraded, client: upgradedClient } = await resolveModelAndClient(llm, { explicitRole: "architect" });
        return { client: upgradedClient, model: upgraded.model, maxTokens: upgraded.maxTokens, tier: "architect" };
      }
      if (iteration >= 6 && modelRole !== "workhorse") {
        const { selectedModel: upgraded, client: upgradedClient } = await resolveModelAndClient(llm, { explicitRole: "workhorse" });
        return { client: upgradedClient, model: upgraded.model, maxTokens: upgraded.maxTokens, tier: "workhorse" };
      }
      return null;
    },
    onToolResult: (toolId, result, success) => {
      liveToolCalls.push(buildToolCallEntry(toolId, result, success));
      // Fire-and-forget: flush to plan.json so recovery can see progress
      updatePlanProgress(deviceId, agentId, workspacePath, plan, completedSteps, remainingSteps, {
        currentStepId: currentStep.id,
        currentStepToolCalls: liveToolCalls,
      }).catch(err => log.debug("Failed to flush tool call to plan.json", { error: err }));

      // Send tool result to Discord #logs via task_progress
      const snippet = result?.substring(0, 150) || "";
      sendTaskProgress(deviceId, {
        eventType: "tool_result",
        status: success ? "ok" : "error",
        message: `${toolId}: ${snippet}`,
        success,
      });
    },
  });

  // Extract tracked tool calls from context state
  const toolCallsMade = (ctx.state.toolCallsMade || []) as StepResult["toolCallsMade"];
  const escalated = loopResult.stoppedByTool;
  const escalationReason = escalated ? loopResult.stopToolArgs?.reason : undefined;

  return {
    step: currentStep,
    success: !escalated && loopResult.iterations < STEP_MAX_ITERATIONS,
    output: loopResult.finalContent,
    toolCallsMade,
    iterations: loopResult.iterations,
    filesCreated: [],
    escalated,
    escalationReason,
  };
}
