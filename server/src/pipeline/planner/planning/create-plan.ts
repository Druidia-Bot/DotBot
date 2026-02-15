/**
 * Plan Creation — Task Decomposition
 *
 * Takes the intake context and recruiter result, calls the LLM
 * to break the task into high-level steps. Simple tasks get a single
 * step (no planning overhead). Complex tasks get 2-8 ordered steps.
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { loadPrompt, loadSchema } from "../../../prompt-template.js";
import { generateMinimalCatalog } from "#tools/catalog.js";
import { requestTools } from "#ws/device-bridge.js";
import type { ILLMClient } from "#llm/types.js";
import type { ToolManifestEntry } from "#tools/types.js";
import type { PlannerInput, StepPlan } from "../types.js";

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
    loadSchema("planner/prompts/planner.schema.json"),
    fetchManifest(input.deviceId),
  ]);

  const toolSummary = generateMinimalCatalog(toolManifest);

  const prompt = await loadPrompt("planner/prompts/planner.md", {
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
// HELPERS
// ============================================

async function fetchManifest(deviceId: string): Promise<ToolManifestEntry[]> {
  try {
    const result = await requestTools(deviceId);
    if (result && Array.isArray(result.tools)) {
      const { PREMIUM_TOOLS } = await import("#tools-server/premium/manifest.js");
      const { IMAGEGEN_TOOLS } = await import("#tools-server/imagegen/manifest.js");
      return [...result.tools, ...PREMIUM_TOOLS, ...IMAGEGEN_TOOLS];
    }
  } catch {
    // Fall through
  }
  return [];
}
