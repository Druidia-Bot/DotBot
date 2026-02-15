/**
 * Queue Executor — Runs queued tasks in the same workspace after an agent completes.
 *
 * When an agent finishes and has queued tasks (from QUEUE routing decisions),
 * this module spawns a new agent in the same workspace with a fresh
 * recruiter → planner → executor cycle.
 *
 * Extracted from pipeline.ts for separation of concerns.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../logging.js";
import { sendExecutionCommand, sendRunLog, sendAgentLifecycle } from "../ws/device-bridge.js";
import { readPlanJson } from "./workspace-io.js";
import { buildHandoffBrief } from "../planner/plan-progress.js";
import type { QueueExecutionOptions } from "./types.js";

const log = createComponentLogger("queue-executor");

export async function executeQueuedTasks(
  opts: QueueExecutionOptions,
): Promise<{ agentId: string; finalResponse: string; success: boolean } | null> {
  const {
    llm, userId, deviceId, messageId, previousAgentId,
    workspacePath, toolManifest, intakeResult, queuedTasks,
  } = opts;

  const newAgentId = `agent_${nanoid(12)}`;
  const combinedRequest = queuedTasks.map(t => t.request).join("\n\n");

  log.info("Executing queued tasks", {
    newAgentId,
    previousAgentId,
    taskCount: queuedTasks.length,
    combinedRequest: combinedRequest.slice(0, 200),
  });

  sendAgentLifecycle(deviceId, {
    event: "queue_started",
    agentId: newAgentId,
    message: `Queued task started (${queuedTasks.length} task${queuedTasks.length > 1 ? "s" : ""})`,
    detail: combinedRequest.substring(0, 120),
  });

  // Build structured handoff from previous agent's plan.json
  let handoffContext = "(queued continuation — see workspace files for prior context)";
  try {
    const prevPlan = await readPlanJson(deviceId, workspacePath);
    if (prevPlan) {
      handoffContext = buildHandoffBrief(prevPlan);
      log.info("Built handoff brief from previous agent", {
        previousAgentId,
        completedSteps: prevPlan.progress?.completedStepIds?.length ?? 0,
      });
    }
  } catch (err) {
    log.warn("Failed to build handoff brief, using fallback", { error: err });
  }

  // Delete stale intake_knowledge.md (was built for the previous request)
  try {
    await sendExecutionCommand(deviceId, {
      id: `ws_${newAgentId}_delete_intake_${nanoid(6)}`,
      type: "tool_execute",
      payload: {
        toolId: "filesystem.delete_file",
        toolArgs: { path: `${workspacePath}/intake_knowledge.md` },
      },
      dryRun: false,
      timeout: 5_000,
      sandboxed: false,
      requiresApproval: false,
    });
  } catch (err) {
    log.warn("Failed to delete stale intake_knowledge.md", { error: err });
  }

  // Run recruiter with combined queued requests + structured handoff
  try {
    const { runRecruiter } = await import("../recruiter/recruiter.js");
    const recruiterResult = await runRecruiter(llm, {
      agentId: newAgentId,
      deviceId,
      workspacePath,
      intakeResult,
      restatedRequest: combinedRequest,
      intakeKnowledgebase: handoffContext,
      toolManifest,
      previousAgentId,
    });

    sendRunLog(userId, {
      stage: "queue-recruiter",
      messageId,
      agentId: newAgentId,
      previousAgentId,
      taskCount: queuedTasks.length,
      timestamp: new Date().toISOString(),
    });

    const { createPlan } = await import("../planner/planner.js");
    const { executeSteps } = await import("../planner/step-executor.js");

    const plan = await createPlan(llm, {
      agentId: newAgentId,
      deviceId,
      workspacePath,
      restatedRequest: combinedRequest,
      intakeKnowledgebase: handoffContext,
      intakeResult,
      recruiterResult,
    });

    sendRunLog(userId, {
      stage: "queue-planner",
      messageId,
      agentId: newAgentId,
      stepCount: plan.steps.length,
      steps: plan.steps.map(s => ({ id: s.id, title: s.title })),
      timestamp: new Date().toISOString(),
    });

    const executionResult = await executeSteps(plan, {
      llm,
      deviceId,
      agentId: newAgentId,
      workspacePath,
      customPrompt: recruiterResult.customPrompt,
      selectedToolIds: recruiterResult.tools,
      modelRole: recruiterResult.modelRole,
      restatedRequest: combinedRequest,
      toolManifest,
      skipReplan: plan.isSimpleTask,
    });

    sendRunLog(userId, {
      stage: "queue-execution-complete",
      messageId,
      agentId: newAgentId,
      success: executionResult.success,
      stepsCompleted: executionResult.stepResults.length,
      timestamp: new Date().toISOString(),
    });

    return {
      agentId: newAgentId,
      finalResponse: executionResult.finalResponse,
      success: executionResult.success,
    };
  } catch (err) {
    log.error("Queue execution failed", { newAgentId, previousAgentId, error: err });
    return null;
  }
}
