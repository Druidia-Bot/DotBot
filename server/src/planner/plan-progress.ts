/**
 * Plan Progress — Workspace I/O for plan.json and step output files.
 *
 * Handles writing plan progress and step outputs to the agent's workspace.
 * Extracted from step-executor.ts for separation of concerns.
 */

import { createComponentLogger } from "../logging.js";
import { writeWorkspaceFile } from "../pipeline/workspace-io.js";
import type { StepPlan, Step, StepResult, ToolCallEntry } from "./types.js";

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
// HANDOFF BRIEF (for queue continuation)
// ============================================

/**
 * Build a structured handoff brief from a completed agent's plan.json.
 * Used by queue-executor to give the successor agent context about
 * what was accomplished and where to find outputs.
 *
 * @param planJson - Parsed plan.json content from the previous agent
 */
export function buildHandoffBrief(planJson: Record<string, any>): string {
  const lines: string[] = ["## Previous Agent Handoff"];

  // Approach
  if (planJson.approach) {
    lines.push(`**Approach:** ${planJson.approach}`);
  }

  // Steps
  const steps: any[] = planJson.steps || [];
  const progress = planJson.progress || {};
  const completedIds = new Set(progress.completedStepIds || []);

  if (steps.length > 0) {
    lines.push("");
    lines.push("### Completed Steps");
    for (const step of steps) {
      const status = completedIds.has(step.id) ? "✓" : "✗ incomplete";
      lines.push(`- **${step.title}** (${step.id}): ${status}`);
      if (step.expectedOutput) {
        lines.push(`  Expected: ${step.expectedOutput}`);
      }
    }
  }

  // Tool calls from the last step (if agent died mid-step)
  const toolCalls: any[] = progress.currentStepToolCalls || [];
  if (toolCalls.length > 0 && progress.currentStepId) {
    lines.push("");
    lines.push(`### In-Progress Step: ${progress.currentStepId}`);
    lines.push(`Tool calls completed before interruption:`);
    for (const tc of toolCalls) {
      const pathNote = tc.outputPath ? ` → saved to ${tc.outputPath}` : "";
      lines.push(`- ${tc.success ? "✓" : "✗"} \`${tc.toolId}\`${pathNote}`);
    }
  }

  // Terminal states
  if (progress.completedAt) {
    lines.push(`\n**Status:** Completed at ${progress.completedAt}`);
  } else if (progress.failedAt) {
    lines.push(`\n**Status:** Failed at ${progress.failedAt}`);
  } else if (progress.stoppedAt) {
    lines.push(`\n**Status:** Stopped by user at ${progress.stoppedAt}`);
  }

  lines.push("");
  lines.push("Check the workspace `logs/` folder for detailed step outputs and `research/` for saved data.");

  return lines.join("\n");
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
