/**
 * Replan Step — Post-Step Adaptive Replanning
 *
 * After each step completes, drains user signals and re-plans
 * remaining steps based on what happened. Skipped for simple tasks
 * or the last step.
 */

import { createComponentLogger } from "#logging.js";
import { sendAgentLifecycle } from "#ws/device-bridge.js";
import { drainSignals, pushSignal } from "#pipeline/agent-signals.js";
import { replan } from "../planning/replan.js";
import { listWorkspaceFiles } from "../workspace/workspace-briefing.js";
import type { ILLMClient } from "#llm/types.js";
import type { ToolManifestEntry } from "#tools/types.js";
import type { Step, StepPlan, StepResult } from "../types.js";

const log = createComponentLogger("replan-step");

export interface ReplanStepDeps {
  llm: ILLMClient;
  deviceId: string;
  agentId: string;
  workspacePath: string;
  plan: StepPlan;
  stepResult: StepResult;
  completedSteps: StepResult[];
  remainingSteps: Step[];
  toolManifest: ToolManifestEntry[];
}

/**
 * Re-plans remaining steps after a completed step.
 * Returns the (possibly updated) remaining steps.
 */
export async function replanAfterStep(deps: ReplanStepDeps): Promise<Step[]> {
  const {
    llm, deviceId, agentId, workspacePath,
    plan, stepResult, completedSteps, remainingSteps, toolManifest,
  } = deps;

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
      {
        signals: signals.length > 0 ? signals : undefined,
        toolManifest,
        completedStepCount: completedSteps.length,
      },
    );

    if (replanResult.changed) {
      log.info("Plan updated after step", {
        stepId: stepResult.step.id,
        reasoning: replanResult.reasoning,
        newStepCount: replanResult.remainingSteps.length,
      });
      return replanResult.remainingSteps;
    }
  } catch (err) {
    log.warn("Replan failed — continuing with existing plan", { error: err });
    // Re-push drained signals so they're picked up at the next step boundary
    if (signals.length > 0) {
      for (const sig of signals) pushSignal(agentId, sig);
      log.info("Re-pushed signals after replan failure", { count: signals.length });
    }
  }

  return remainingSteps;
}
