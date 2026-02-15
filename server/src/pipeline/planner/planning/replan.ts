/**
 * Re-Planner — Adaptive Planning After Each Step
 *
 * After each step completes, evaluates whether the remaining plan
 * needs adjustment based on what was learned, failures, or user signals.
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { loadPrompt, loadSchema } from "../../../prompt-template.js";
import type { ILLMClient } from "#llm/types.js";
import type { StepPlan, Step, ReplanResult, StepResult } from "../types.js";

const log = createComponentLogger("planner.replan");

// ============================================
// RE-PLANNING (after each step)
// ============================================

export async function replan(
  llm: ILLMClient,
  originalPlan: StepPlan,
  completedStep: StepResult,
  remainingSteps: Step[],
  workspaceFiles: string,
  signals?: string[],
): Promise<ReplanResult> {
  log.info("Re-evaluating plan", {
    completedStep: completedStep.step.id,
    remainingCount: remainingSteps.length,
    signalCount: signals?.length ?? 0,
  });

  const [replanSchema] = await Promise.all([
    loadSchema("planner/prompts/replanner.schema.json"),
  ]);

  const signalsText = signals && signals.length > 0
    ? `The user sent the following instructions while work was in progress. Incorporate them into the remaining steps:\n${signals.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : "(none)";

  const prompt = await loadPrompt("planner/prompts/replanner.md", {
    "Original Plan": formatPlanForPrompt(originalPlan),
    "Step Title": completedStep.step.title,
    "Step ID": completedStep.step.id,
    "Step Output": completedStep.output.slice(0, 4000),
    "Step Status": completedStep.success ? "Completed successfully" : `Failed: ${completedStep.escalationReason || "unknown error"}`,
    "Remaining Steps": formatStepsForPrompt(remainingSteps),
    "Workspace Files": workspaceFiles,
    "User Signals": signalsText,
  });

  // Use architect for complex replans (high blast radius or recovery situations)
  const needsDeepReasoning =
    remainingSteps.length >= 4 ||
    completedStep.escalated === true ||
    !completedStep.success;

  const replanRole = needsDeepReasoning ? "architect" : "intake";
  log.info("Replan model selection", {
    role: replanRole,
    remainingSteps: remainingSteps.length,
    escalated: completedStep.escalated,
    success: completedStep.success,
  });

  const { selectedModel: modelConfig, client } = await resolveModelAndClient(
    llm,
    { explicitRole: replanRole as any },
  );

  const response = await client.chat(
    [{ role: "user", content: prompt }],
    {
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
      temperature: 0.1,
      responseFormat: "json_object",
      responseSchema: { name: "task_replanner", schema: replanSchema },
    },
  );

  let result: ReplanResult;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in replanner response");
    result = JSON.parse(jsonMatch[0]) as ReplanResult;
  } catch (e) {
    log.warn("Failed to parse replanner response, keeping original plan", { error: e });
    result = {
      changed: false,
      reasoning: "Replanner parse failure — keeping original plan",
      remainingSteps,
    };
  }

  if (result.changed) {
    log.info("Plan updated", {
      reasoning: result.reasoning,
      previousCount: remainingSteps.length,
      newCount: result.remainingSteps.length,
    });
  } else {
    log.info("Plan unchanged", { reasoning: result.reasoning });
  }

  return result;
}

// ============================================
// FORMAT HELPERS
// ============================================

export function formatPlanForPrompt(plan: StepPlan): string {
  const lines = [`**Approach:** ${plan.approach}`, `**Simple task:** ${plan.isSimpleTask}`, ""];
  for (const step of plan.steps) {
    lines.push(`### ${step.id}: ${step.title}`);
    lines.push(step.description);
    lines.push(`Expected output: ${step.expectedOutput}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatStepsForPrompt(steps: Step[]): string {
  if (steps.length === 0) return "(no remaining steps)";
  return steps.map(s =>
    `- **${s.id}: ${s.title}** — ${s.description} (expected: ${s.expectedOutput})`
  ).join("\n");
}
