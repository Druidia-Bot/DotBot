/**
 * Step Executor — Sequential Step Execution with Workspace Awareness
 *
 * Thin orchestrator that iterates through the planner's steps.
 * Each step is executed by step-runner.ts, then optionally re-planned
 * by replan-step.ts.
 *
 * Decomposed modules:
 *   step-context.ts  — per-step ToolContext builder (server-side executor wiring)
 *   step-tools.ts    — per-step tool set builder (manifest filtering, escape hatches)
 *   step-runner.ts   — single step execution (model, messages, tool loop, result)
 *   replan-step.ts   — post-step adaptive replanning with signal handling
 *
 * Workspace modules:
 *   workspace/plan-progress.ts       — updatePlanProgress, saveStepOutput
 *   workspace/workspace-briefing.ts  — workspace context injection
 *   workspace/handoff.ts             — handoff brief + final response builder
 */

import { createComponentLogger } from "#logging.js";
import { sendAgentLifecycle } from "#ws/device-bridge.js";
import { registerAgent, unregisterAgent, getAbortSignal } from "#pipeline/agent-signals.js";
import { mutatePersonaJson } from "#pipeline/workspace/persona.js";
import { updatePlanProgress, saveStepOutput } from "../workspace/plan-progress.js";
import { buildFinalResponse } from "../workspace/handoff.js";
import { runStep } from "./step-runner.js";
import { replanAfterStep } from "./replan-step.js";
import type {
  StepPlan,
  StepResult,
  StepExecutorOptions,
  PlannerExecutionResult,
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
    modelRole, restatedRequest, toolManifest,
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

    // ── Execute the step ──
    const stepResult = await runStep({
      llm, userId, deviceId, agentId, workspacePath, customPrompt,
      modelRole, restatedRequest, toolManifest,
      plan, completedSteps, remainingSteps, currentStep,
    });

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
      toolCalls: stepResult.toolCallsMade.length,
      escalated: stepResult.escalated,
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

    // ── Re-plan remaining steps (skip for simple tasks or last step) ──
    if (!options.skipReplan && !plan.isSimpleTask && remainingSteps.length > 0) {
      remainingSteps = await replanAfterStep({
        llm, deviceId, agentId, workspacePath,
        plan, stepResult, completedSteps, remainingSteps, toolManifest,
      });
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
