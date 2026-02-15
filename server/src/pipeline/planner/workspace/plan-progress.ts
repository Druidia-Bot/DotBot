/**
 * Plan Progress — Workspace I/O for plan.json and step output files.
 *
 * Handles writing plan progress and step outputs to the agent's workspace.
 */

import { createComponentLogger } from "#logging.js";
import { writeWorkspaceFile } from "#pipeline/workspace/io.js";
import type { StepPlan, Step, StepResult, ToolCallEntry } from "../types.js";

const log = createComponentLogger("plan-progress");

// ============================================
// PLAN.JSON WRITER
// ============================================

export interface PlanProgressOpts {
  currentStepId?: string;
  failedAt?: string;
  stoppedAt?: string;
  /** Live tool call log for the step currently executing */
  currentStepToolCalls?: ToolCallEntry[];
}

/**
 * Write/update plan progress to workspace. Called once at the start
 * (all steps pending) and after each step completes.
 *
 * Writes plan.json — raw plan data (machine-readable).
 * Human-readable progress is rendered on demand, not persisted.
 */
export async function updatePlanProgress(
  deviceId: string,
  agentId: string,
  workspacePath: string,
  plan: StepPlan,
  completedSteps: StepResult[],
  remainingSteps: Step[],
  opts?: PlanProgressOpts,
): Promise<void> {
  const completedIds = new Set(completedSteps.map(sr => sr.step.id));

  const jsonContent = JSON.stringify({
    ...plan,
    progress: {
      completedStepIds: [...completedIds],
      remainingStepIds: remainingSteps.map(s => s.id),
      currentStepId: opts?.currentStepId,
      currentStepToolCalls: opts?.currentStepToolCalls,
      completedAt: completedSteps.length === plan.steps.length && remainingSteps.length === 0
        ? new Date().toISOString()
        : undefined,
      failedAt: opts?.failedAt,
      stoppedAt: opts?.stoppedAt,
    },
  }, null, 2);

  try {
    await writeWorkspaceFile(deviceId, `${workspacePath}/plan.json`, jsonContent, 10_000);
  } catch (err) {
    log.warn("Failed to write plan.json", { agentId, error: err });
  }

  log.info("Plan progress updated", {
    agentId,
    completed: completedSteps.length,
    remaining: remainingSteps.length,
  });
}

// ============================================
// TOOL CALL ENTRY BUILDER
// ============================================

/** Max chars to store in resultSnippet — enough to understand what happened. */
const SNIPPET_MAX_CHARS = 200;

/** Regex to extract workspace-relative output path from research wrapper notes. */
const RESEARCH_PATH_RE = /workspace\/research\/([^\]\s]+)/;

/**
 * Extract the workspace-relative output path from a tool result string.
 * The research wrapper appends "[Full result also saved to workspace/research/...]".
 */
export function extractOutputPath(result: string): string | undefined {
  const match = RESEARCH_PATH_RE.exec(result);
  return match ? `research/${match[1]}` : undefined;
}

/**
 * Build a lightweight ToolCallEntry from a tool result callback.
 */
export function buildToolCallEntry(
  toolId: string,
  result: string,
  success: boolean,
): ToolCallEntry {
  return {
    toolId,
    timestamp: new Date().toISOString(),
    success,
    resultSnippet: result.length > SNIPPET_MAX_CHARS
      ? result.substring(0, SNIPPET_MAX_CHARS) + "…"
      : result,
    outputPath: extractOutputPath(result),
  };
}

// ============================================
// STEP OUTPUT WRITER
// ============================================

/**
 * Save a step's output to workspace as a markdown log file.
 * Written to `logs/{stepId}-output.md` in the workspace.
 */
export async function saveStepOutput(
  deviceId: string,
  agentId: string,
  workspacePath: string,
  step: Step,
  result: StepResult,
): Promise<void> {
  const content = [
    `# Step Output: ${step.title} (${step.id})`,
    `Status: ${result.success ? "completed" : "failed"}`,
    `Iterations: ${result.iterations}`,
    `Tool calls: ${result.toolCallsMade.length}`,
    "",
    "## Output",
    result.output,
  ].join("\n");

  try {
    await writeWorkspaceFile(deviceId, `${workspacePath}/logs/${step.id}-output.md`, content, 10_000);
  } catch (err) {
    log.warn("Failed to save step output", { stepId: step.id, error: err });
  }
}
