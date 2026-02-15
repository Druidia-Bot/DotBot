/**
 * Step Executor — Sequential Step Execution with Workspace Awareness
 *
 * Iterates through the planner's steps, running a tool loop for each.
 * After each step:
 *   1. Saves step output to workspace (plan-progress.ts)
 *   2. Updates workspace file listing
 *   3. Re-plans remaining steps (adaptive planning)
 *
 * Uses the generic tool loop (tool-loop/loop.ts) with composable handlers:
 *   - Local agent proxy: forwards tool calls to the user's machine
 *   - Research wrapper: persists search/http results to workspace
 *   - Server-side handlers: memory + knowledge handled without round-trip
 *   - Escalation: synthetic tool that stops the loop when the agent is stuck
 *
 * Sub-modules:
 *   workspace/plan-progress.ts  — updatePlanProgress, saveStepOutput (workspace file I/O)
 *   workspace/workspace-briefing.ts — workspace context injection
 *   workspace/handoff.ts — handoff brief + final response builder
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { sendAgentLifecycle, sendExecutionCommand, sendTaskProgress } from "#ws/device-bridge.js";
import { manifestToNativeTools } from "#tools/manifest.js";
import { runToolLoop, buildStepExecutorHandlers } from "#tool-loop/index.js";
import {
  ESCALATE_TOOL_ID,
  escalateToolDefinition,
  escalateHandler,
} from "#tool-loop/handlers/synthetic-tools.js";
import { replan } from "../planning/replan.js";
import { updatePlanProgress, saveStepOutput, buildToolCallEntry } from "../workspace/plan-progress.js";
import { buildFinalResponse } from "../workspace/handoff.js";
import {
  listWorkspaceFiles,
  buildWorkspaceBriefing,
  buildStepUserMessage,
} from "../workspace/workspace-briefing.js";
import {
  registerAgent,
  unregisterAgent,
  pushSignal,
  drainSignals,
  getAbortSignal,
} from "#pipeline/agent-signals.js";
import { mutatePersonaJson } from "#pipeline/workspace/persona.js";
import type { ToolContext } from "#tool-loop/types.js";
import type { LLMMessage } from "#llm/types.js";
import type {
  StepPlan,
  StepResult,
  StepExecutorOptions,
  PlannerExecutionResult,
  ToolCallEntry,
} from "../types.js";

export type { StepExecutorOptions } from "../types.js";

const log = createComponentLogger("step-executor");

// ============================================
// MAIN ENTRY
// ============================================

export async function executeSteps(
  plan: StepPlan,
  options: StepExecutorOptions,
): Promise<PlannerExecutionResult> {
  const {
    llm, userId, deviceId, agentId, workspacePath, customPrompt,
    selectedToolIds, modelRole, restatedRequest, toolManifest,
  } = options;

  log.info("Starting step execution", {
    agentId,
    stepCount: plan.steps.length,
    isSimple: plan.isSimpleTask,
  });

  // Register agent for signal handling (abort + signal queue)
  // IMPORTANT: registerAgent() MUST happen BEFORE setting disk status to "running"
  // to prevent heartbeat race (scanForDeadAgents sees running+unregistered = false positive)
  registerAgent(agentId);
  await mutatePersonaJson(deviceId, workspacePath, (p) => { p.status = "running"; });

  // Write initial plan to workspace (all steps pending)
  await updatePlanProgress(deviceId, agentId, workspacePath, plan, [], [...plan.steps]);

  // Filter tool manifest to selected IDs
  const idSet = new Set(selectedToolIds);
  let filteredManifest = toolManifest.filter(t => idSet.has(t.id));
  if (filteredManifest.length === 0) {
    log.warn("No tools matched selectedToolIds, using full manifest as fallback", {
      selectedCount: selectedToolIds.length,
      manifestSize: toolManifest.length,
    });
    filteredManifest = toolManifest;
  }

  // Build handler map once — reused across all steps.
  // Layers: local-agent proxy → research persistence → server-side overrides
  const handlers = buildStepExecutorHandlers(filteredManifest, workspacePath);

  // Register escalation handler (uses stopTool mechanism)
  handlers.set(ESCALATE_TOOL_ID, escalateHandler());

  // Build native tool definitions for the LLM (manifest → ToolDefinition[])
  const nativeTools = [
    ...manifestToNativeTools(filteredManifest),
    escalateToolDefinition(),
  ];

  const completedSteps: StepResult[] = [];
  let remainingSteps = [...plan.steps];

  try {
  while (remainingSteps.length > 0) {
    // Check abort signal before each step
    if (getAbortSignal(agentId)?.aborted) {
      log.info("Agent stopped by user before step", { agentId, nextStepId: remainingSteps[0]?.id });
      await updatePlanProgress(deviceId, agentId, workspacePath, plan, completedSteps, remainingSteps, {
        stoppedAt: new Date().toISOString(),
      });
      sendAgentLifecycle(deviceId, {
        event: "agent_stopped",
        agentId,
        message: `Agent stopped at step ${completedSteps.length}/${plan.steps.length}`,
        detail: completedSteps.length > 0
          ? `Completed: ${completedSteps.map(s => s.step.title).join(", ")}`
          : "No steps completed",
      });
      break;
    }

    const currentStep = remainingSteps.shift()!;

    log.info("Executing step", {
      stepId: currentStep.id,
      title: currentStep.title,
      remaining: remainingSteps.length,
    });

    // Mark current step in plan.json
    await updatePlanProgress(deviceId, agentId, workspacePath, plan, completedSteps, remainingSteps, {
      currentStepId: currentStep.id,
    });

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

    // Fresh context per step — handlers stash side effects here.
    // llmClient is used by the research wrapper for background summarization.
    const ctx: ToolContext = {
      deviceId,
      state: {
        userPrompt: restatedRequest,
        stepId: currentStep.id,
        toolCallsMade: [],
        llmClient: client,
        // Server-side imagegen executor — curried with executeCommand bridge
        executeImageGenTool: async (toolId: string, args: Record<string, any>) => {
          const { executeImageGenTool } = await import("#tools-server/imagegen/executor.js");
          const executeCommand = async (cmd: any) => {
            const cmdId = `imgcmd_${nanoid(8)}`;
            return sendExecutionCommand(deviceId, { id: cmdId, ...cmd });
          };
          return executeImageGenTool(toolId, args, executeCommand);
        },
        // Server-side premium executor
        executePremiumTool: async (toolId: string, args: Record<string, any>) => {
          const { executePremiumTool } = await import("#tools-server/premium/executor.js");
          return executePremiumTool(userId, toolId, args);
        },
        // Server-side schedule executor
        executeScheduleTool: async (toolId: string, args: Record<string, any>) => {
          const { executeScheduleTool } = await import("#tools-server/schedule/executor.js");
          return executeScheduleTool(userId, toolId, args);
        },
      },
    };

    // Accumulator for real-time tool call tracking in plan.json
    const liveToolCalls: ToolCallEntry[] = [];

    // Run the clean tool loop
    const loopResult = await runToolLoop({
      client,
      model: selectedModel.model,
      maxTokens: selectedModel.maxTokens,
      temperature: selectedModel.temperature,
      messages,
      tools: nativeTools,
      handlers,
      maxIterations: 30,
      stopTool: ESCALATE_TOOL_ID,
      context: ctx,
      getAbortSignal: () => getAbortSignal(agentId),
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

    // Build step result
    const stepResult: StepResult = {
      step: currentStep,
      success: !escalated && loopResult.iterations < 30,
      output: loopResult.finalContent,
      toolCallsMade,
      iterations: loopResult.iterations,
      filesCreated: [],
      escalated,
      escalationReason,
    };

    completedSteps.push(stepResult);

    // Save step output + update plan progress
    await saveStepOutput(deviceId, agentId, workspacePath, currentStep, stepResult);
    await updatePlanProgress(deviceId, agentId, workspacePath, plan, completedSteps, remainingSteps, {
      failedAt: !stepResult.success ? new Date().toISOString() : undefined,
    });

    log.info("Step completed", {
      stepId: currentStep.id,
      success: stepResult.success,
      iterations: stepResult.iterations,
      toolCalls: toolCallsMade.length,
      escalated,
    });

    // Notify Discord #updates with step progress
    const stepNum = completedSteps.length;
    const totalSteps = stepNum + remainingSteps.length;
    const statusIcon = stepResult.success ? "✅" : "❌";
    sendAgentLifecycle(deviceId, {
      event: "step_complete",
      agentId,
      message: `${statusIcon} Step ${stepNum}/${totalSteps} complete: ${currentStep.title || currentStep.id}`,
      detail: stepResult.output?.substring(0, 200) || undefined,
    });

    // Re-plan remaining steps (skip for simple tasks or last step)
    if (!options.skipReplan && !plan.isSimpleTask && remainingSteps.length > 0) {
      const signals = drainSignals(agentId);
      // Signals are already persisted to agent_persona.json at push time
      // (routing/decisions.ts) — no need to re-persist here.
      if (signals.length > 0) {
        sendAgentLifecycle(deviceId, {
          event: "signal_pickup",
          agentId,
          message: `Picked up ${signals.length} instruction(s) at step ${completedSteps.length}/${plan.steps.length}`,
          detail: signals.map(s => s.substring(0, 80)).join("; "),
        });
      }

      const updatedFiles = await listWorkspaceFiles(deviceId, workspacePath);
      try {
        const replanResult = await replan(
          llm,
          plan,
          stepResult,
          remainingSteps,
          updatedFiles,
          signals.length > 0 ? signals : undefined,
        );

        if (replanResult.changed) {
          remainingSteps = replanResult.remainingSteps;
          log.info("Plan updated after step", {
            stepId: currentStep.id,
            reasoning: replanResult.reasoning,
            newStepCount: remainingSteps.length,
          });
        }
      } catch (err) {
        log.warn("Replan failed — continuing with existing plan", { error: err });
        // Re-push drained signals so they're picked up at the next step boundary
        if (signals.length > 0) {
          for (const sig of signals) pushSignal(agentId, sig);
          log.info("Re-pushed signals after replan failure", { count: signals.length });
        }
      }
    }
  }
  } finally {
    unregisterAgent(agentId);
  }

  // Build final response from all step outputs
  const finalResponse = buildFinalResponse(completedSteps);
  const totalToolCalls = completedSteps.reduce((sum, sr) => sum + sr.toolCallsMade.length, 0);
  const totalIterations = completedSteps.reduce((sum, sr) => sum + sr.iterations, 0);

  log.info("All steps completed", {
    agentId,
    stepsCompleted: completedSteps.length,
    totalToolCalls,
    totalIterations,
    allSucceeded: completedSteps.every(sr => sr.success),
  });

  return {
    plan,
    stepResults: completedSteps,
    finalResponse,
    success: completedSteps.some(sr => sr.success),
    totalToolCalls,
    totalIterations,
  };
}
