/**
 * Planner — Task Decomposition
 *
 * Takes the intake context and recruter result, calls the LLM
 * to break the task into high-level steps. Simple tasks get a single
 * step (no planning overhead). Complex tasks get 2-8 ordered steps.
 */

import { createComponentLogger } from "../logging.js";
import { resolveModelAndClient } from "../llm/resolve.js";
import { loadPrompt, loadSchema } from "../prompt-template.js";
import { generateMinimalCatalog } from "../tools/catalog.js";
import { requestTools } from "../ws/device-bridge.js";
import type { ILLMClient } from "../llm/types.js";
import type { ToolManifestEntry } from "../agents/tools.js";
import type { PlannerInput, StepPlan, Step, ReplanResult, StepResult } from "./types.js";

const log = createComponentLogger("planner");

// ============================================
// PLAN CREATION
// ============================================

export async function createPlan(
  llm: ILLMClient,
  input: PlannerInput,
): Promise<StepPlan> {
  const { restatedRequest, intakeKnowledgebase, recruiterResult } = input;

  log.info("Creating step plan", { agentId: input.agentId, request: restatedRequest.slice(0, 100) });

  const [plannerSchema, toolManifest] = await Promise.all([
    loadSchema("planner/planner.schema.json"),
    fetchManifest(input.deviceId),
  ]);

  const toolSummary = generateMinimalCatalog(toolManifest);

  const prompt = await loadPrompt("planner/planner.md", {
    "Intake Knowledgebase": intakeKnowledgebase || "(none gathered)",
    "Restated Request": restatedRequest,
    "Tool Summary": toolSummary,
  });

  const { selectedModel: modelConfig, client } = await resolveModelAndClient(
    llm,
    { explicitRole: "intake" },
  );

  const response = await client.chat(
    [{ role: "user", content: prompt }],
    {
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
      temperature: 0.2,
      responseFormat: "json_object",
      responseSchema: { name: "task_planner", schema: plannerSchema },
    },
  );

  log.info("Planner LLM response", {
    model: response.model,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  });

  let plan: StepPlan;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in planner response");
    plan = JSON.parse(jsonMatch[0]) as StepPlan;
  } catch (e) {
    log.error("Failed to parse planner response", { error: e, raw: response.content.substring(0, 500) });
    plan = {
      approach: "Single-step fallback — planner parse failure",
      isSimpleTask: true,
      steps: [{
        id: "step-1",
        title: "Execute task",
        description: restatedRequest,
        expectedOutput: "Task completed",
        toolHints: recruiterResult.tools.slice(0, 10),
        requiresExternalData: false,
        dependsOn: [],
      }],
    };
  }

  log.info("Plan created", {
    agentId: input.agentId,
    isSimple: plan.isSimpleTask,
    stepCount: plan.steps.length,
    steps: plan.steps.map(s => s.title),
  });

  return plan;
}

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
    loadSchema("planner/replanner.schema.json"),
  ]);

  const signalsText = signals && signals.length > 0
    ? `The user sent the following instructions while work was in progress. Incorporate them into the remaining steps:\n${signals.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : "(none)";

  const prompt = await loadPrompt("planner/replanner.md", {
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
// HELPERS
// ============================================

async function fetchManifest(deviceId: string): Promise<ToolManifestEntry[]> {
  try {
    const result = await requestTools(deviceId);
    if (result && Array.isArray(result.tools)) {
      const { PREMIUM_TOOLS } = await import("../credits/premium-manifest.js");
      const { IMAGEGEN_TOOLS } = await import("../imagegen/manifest.js");
      return [...result.tools, ...PREMIUM_TOOLS, ...IMAGEGEN_TOOLS];
    }
  } catch {
    // Fall through
  }
  return [];
}

function formatPlanForPrompt(plan: StepPlan): string {
  const lines = [`**Approach:** ${plan.approach}`, `**Simple task:** ${plan.isSimpleTask}`, ""];
  for (const step of plan.steps) {
    lines.push(`### ${step.id}: ${step.title}`);
    lines.push(step.description);
    lines.push(`Expected output: ${step.expectedOutput}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatStepsForPrompt(steps: Step[]): string {
  if (steps.length === 0) return "(no remaining steps)";
  return steps.map(s =>
    `- **${s.id}: ${s.title}** — ${s.description} (expected: ${s.expectedOutput})`
  ).join("\n");
}
