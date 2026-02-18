/**
 * Re-Planner — Adaptive Planning After Each Step
 *
 * After each step completes, evaluates whether the remaining plan
 * needs adjustment based on what was learned, failures, or user signals.
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { loadPrompt, loadSchema } from "../../../prompt-template.js";
import { generateMinimalCatalog } from "#tools/catalog.js";
import type { ILLMClient } from "#llm/types.js";
import type { ToolManifestEntry } from "#tools/types.js";
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
  options?: {
    signals?: string[];
    toolManifest?: ToolManifestEntry[];
    completedStepCount?: number;
  },
): Promise<ReplanResult> {
  const { signals, toolManifest, completedStepCount = 0 } = options ?? {};

  // Critique checkpoint: first replan (step 1) and every 3 steps thereafter (4, 7, 10, ...)
  const CRITIQUE_INTERVAL = 3;
  const isCritiqueCheckpoint = completedStepCount === 1 ||
    (completedStepCount > 1 && (completedStepCount - 1) % CRITIQUE_INTERVAL === 0);
  log.info("Re-evaluating plan", {
    completedStep: completedStep.step.id,
    remainingCount: remainingSteps.length,
    signalCount: signals?.length ?? 0,
  });

  const [replanSchema] = await Promise.all([
    loadSchema("pipeline/planner/prompts/replanner.schema.json"),
  ]);

  const signalsText = signals && signals.length > 0
    ? `The user sent the following instructions while work was in progress. Incorporate them into the remaining steps:\n${signals.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : "(none)";

  const toolCatalog = toolManifest ? generateMinimalCatalog(toolManifest) : "(tool catalog not available)";

  const critiqueNudge = isCritiqueCheckpoint
    ? `\n\n**IMPORTANT — Review checkpoint (step ${completedStepCount}).** Before continuing, critically evaluate the remaining plan: Is anything missing? Are the tool assignments thorough? Are there gaps, redundant steps, or a better ordering? Has the work so far revealed a better approach? Err on the side of improving the plan now rather than discovering problems later. Set \`changed: true\` if you find ANY improvements.`
    : "";

  const prompt = await loadPrompt("pipeline/planner/prompts/replanner.md", {
    "Original Plan": formatPlanForPrompt(originalPlan),
    "Step Title": completedStep.step.title,
    "Step ID": completedStep.step.id,
    "Step Output": completedStep.output.slice(0, 4000),
    "Step Status": completedStep.success ? "Completed successfully" : `Failed: ${completedStep.escalationReason || "unknown error"}`,
    "Remaining Steps": formatStepsForPrompt(remainingSteps),
    "Workspace Files": workspaceFiles,
    "User Signals": signalsText,
    "Tool Catalog": toolCatalog,
    "Critique Nudge": critiqueNudge,
  });

  // Use architect for complex replans, recovery situations, or critique checkpoints
  const needsDeepReasoning =
    isCritiqueCheckpoint ||
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
    if (step.toolIds.length > 0) lines.push(`Tools: ${step.toolIds.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatStepsForPrompt(steps: Step[]): string {
  if (steps.length === 0) return "(no remaining steps)";
  return steps.map(s => {
    const tools = s.toolIds.length > 0 ? ` [tools: ${s.toolIds.join(", ")}]` : "";
    return `- **${s.id}: ${s.title}** — ${s.description} (expected: ${s.expectedOutput})${tools}`;
  }).join("\n");
}
