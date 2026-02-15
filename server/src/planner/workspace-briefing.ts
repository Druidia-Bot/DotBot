/**
 * Workspace Briefing — Context Injection
 *
 * Generates the workspace-awareness section injected into each step's
 * system prompt. Tells the agent what's in its workspace, where to save
 * research artifacts, and how to prioritize local data over re-fetching.
 *
 * Prompt text lives in .md templates with |* Field *| placeholders,
 * loaded at runtime via loadPrompt.
 */

import { createComponentLogger } from "../logging.js";
import { loadPrompt } from "../prompt-template.js";
import { sendExecutionCommand } from "../ws/device-bridge.js";
import type { Step, StepResult } from "./types.js";

const log = createComponentLogger("workspace-briefing");

// ============================================
// WORKSPACE FILE LISTING
// ============================================

/**
 * List workspace contents via the local agent. Returns a formatted
 * file listing string suitable for injection into prompts.
 */
export async function listWorkspaceFiles(
  deviceId: string,
  workspacePath: string,
): Promise<string> {
  try {
    const output = await sendExecutionCommand(deviceId, {
      id: `ws_briefing_tree_${Date.now()}`,
      type: "tool_execute",
      payload: {
        toolId: "directory.tree",
        toolArgs: { path: workspacePath, max_depth: 2 },
      },
      dryRun: false,
      timeout: 10_000,
      sandboxed: false,
      requiresApproval: false,
    });
    return output || "(empty workspace)";
  } catch {
    log.debug("Failed to list workspace files, using fallback");
    return "(could not read workspace)";
  }
}

// ============================================
// SYSTEM PROMPT INJECTION
// ============================================

/**
 * Build the workspace-awareness section for a step's system prompt.
 * This tells the agent about its workspace, what's already there,
 * and the protocol for saving/reading data.
 */
export async function buildWorkspaceBriefing(
  workspacePath: string,
  workspaceFiles: string,
  currentStep: Step,
  completedSteps: StepResult[],
  remainingSteps: Step[],
): Promise<string> {
  const completedSummary = completedSteps.length > 0
    ? completedSteps.map(sr =>
      `- ✓ **${sr.step.title}** (${sr.step.id}): ${sr.success ? "completed" : "failed"}`
    ).join("\n")
    : "(this is the first step)";

  const remainingSummary = remainingSteps.length > 0
    ? remainingSteps.map(s => `- ${s.title} (${s.id})`).join("\n")
    : "(this is the last step)";

  const externalDataNote = currentStep.requiresExternalData
    ? "\n**Note:** This step requires external data. Fetch what you need and save it to the workspace."
    : "";

  return loadPrompt("planner/workspace-briefing.md", {
    "Workspace Path": workspacePath,
    "Workspace Files": workspaceFiles,
    "Step Title": currentStep.title,
    "Step ID": currentStep.id,
    "Step Description": currentStep.description,
    "Expected Output": currentStep.expectedOutput,
    "External Data Note": externalDataNote,
    "Completed Summary": completedSummary,
    "Remaining Summary": remainingSummary,
  });
}

/**
 * Build the user message for a step execution. This is what the agent
 * receives as its task instruction.
 */
export async function buildStepUserMessage(
  restatedRequest: string,
  currentStep: Step,
  completedSteps: StepResult[],
): Promise<string> {
  const toolHints = currentStep.toolHints.length > 0
    ? `**Suggested tools:** ${currentStep.toolHints.join(", ")}`
    : "";

  let previousResults = "";
  if (completedSteps.length > 0) {
    const parts: string[] = ["## Previous Step Results"];
    for (const sr of completedSteps.slice(-3)) {
      parts.push(`### ${sr.step.title} (${sr.success ? "✓" : "✗"})`);
      parts.push(sr.output.slice(0, 2000));
      parts.push("");
    }
    previousResults = parts.join("\n");
  }

  return loadPrompt("planner/step-user-message.md", {
    "Step Title": currentStep.title,
    "Step Description": currentStep.description,
    "Expected Output": currentStep.expectedOutput,
    "Tool Hints": toolHints,
    "Previous Step Results": previousResults,
    "Restated Request": restatedRequest,
  });
}
