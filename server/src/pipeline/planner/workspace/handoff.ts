/**
 * Handoff Brief & Final Response Builder
 *
 * Builds structured handoff briefs for queue continuation and
 * merges step outputs into a final user-facing response.
 */

import type { StepResult } from "../types.js";

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
// FINAL RESPONSE BUILDER
// ============================================

/**
 * Build a single response string from all completed step results.
 * For single-step plans, returns the step output directly.
 * For multi-step plans, returns the last step's output if substantial,
 * otherwise concatenates all step outputs.
 */
export function buildFinalResponse(stepResults: StepResult[]): string {
  if (stepResults.length === 1) {
    return stepResults[0].output;
  }

  const parts: string[] = [];
  for (const sr of stepResults) {
    if (sr.output && sr.output.trim()) {
      parts.push(sr.output);
    }
  }

  // Use the last step's output as the primary response (usually the
  // review/synthesis step), with earlier steps as supporting context
  // if the last step is thin.
  const lastOutput = stepResults[stepResults.length - 1];
  if (lastOutput.output.length > 500) {
    return lastOutput.output;
  }

  return parts.join("\n\n---\n\n");
}
