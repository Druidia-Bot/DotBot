/**
 * Pipeline — Orchestrator - Spawned Agents
 *
 * The single pipeline function that runs the full chain for each user message:
 *   Context Builder → Intake → Receptionist → Recruiter → Planner → Step Executor
 *
 * Pure business logic — no WebSocket or transport concerns.
 * Called by the WS prompt handler and the HTTP test endpoint.
 *
 * Sub-modules (same directory):
 *   types.ts           — PipelineOptions, PipelineResult, constants
 *   routing/            — agent routing subfolder:
 *     handler.ts        — checkAgentRouting orchestrator
 *     candidates.ts     — candidate collection from memory models
 *     decisions.ts      — MODIFY/QUEUE/STOP/CONTINUE decision handlers
 *     router.ts         — routing LLM call (prompt + schema + validation)
 *   queue-executor.ts   — executeQueuedTasks (queued continuation in same workspace)
 *   agent-signals.ts    — signal queue, abort, routing lock, task queue
 *   agent-recovery.ts   — dead agent detection + proactive scanning
 *   workspace-io.ts     — all workspace file I/O helpers
 */

import { createComponentLogger } from "#logging.js";
import { buildRequestContext } from "./context/context-builder.js";
import { executeClassifyPipeline } from "./intake/intake.js";
import { drainTaskQueue } from "./agent-signals.js";
import { checkAgentRouting } from "./routing/handler.js";
import { executeQueuedTasks } from "./queue-executor.js";
import { updatePersonaStatus, readPersonaJson } from "./workspace/persona.js";
import { updateAgentAssignmentStatus } from "./receptionist/agent-exec.js";
import {
  sendRunLog,
  sendSaveToThread,
} from "#ws/device-bridge.js";

import type { PipelineOptions, PipelineResult } from "./types.js";
export type { PipelineOptions, PipelineResult } from "./types.js";

const log = createComponentLogger("pipeline");

// ============================================
// MAIN ENTRY
// ============================================

/**
 * The single pipeline function. Runs the full chain:
 *   context → intake → receptionist → recruiter → planner → step executor.
 * The optional `onIntakeComplete` callback lets the caller send an ack mid-pipeline.
 */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { llm, userId, deviceId, prompt, messageId, source, onIntakeComplete } = opts;

  // ── Step 1: Build context + classify ──
  const { enhancedRequest, toolManifest } = await buildRequestContext(deviceId, userId, prompt);
  const intakeResult = await executeClassifyPipeline(llm, enhancedRequest);

  log.info("Intake complete", { requestType: intakeResult.requestType, messageId });

  // ── Step 2: Persist intake run-log to client ──
  sendRunLog(userId, {
    stage: "intake",
    messageId,
    prompt: prompt.slice(0, 500),
    intakeResult,
    timestamp: new Date().toISOString(),
  });

  // ── Step 3: Save dispatched prompt to thread ──
  const threadId = enhancedRequest.activeThreadId || "conversation";
  sendSaveToThread(userId, threadId, {
    role: "user",
    content: prompt,
    source,
    messageId,
    intakeRequestType: intakeResult.requestType as string,
  }, "Conversation");

  // ── Step 4: Check for existing agents on matched models (routing) ──
  const relevantMemories = (intakeResult.relevantMemories as any[]) || [];
  const routingResult = await checkAgentRouting(llm, deviceId, prompt, relevantMemories);
  if (routingResult) {
    sendRunLog(userId, {
      stage: "agent-routing",
      messageId,
      decision: routingResult.decision,
      targetAgentId: routingResult.targetAgentId,
      reasoning: routingResult.reasoning,
      timestamp: new Date().toISOString(),
    });

    if (routingResult.decision === "continue" && routingResult.workspacePath) {
      // Agent is not running but workspace is live — start immediately in same workspace.
      // This goes straight to recruiter → planner → executor, reusing existing workspace files.
      log.info("Continue in existing workspace", {
        workspacePath: routingResult.workspacePath,
        previousAgentId: routingResult.targetAgentId,
        messageId,
      });

      if (onIntakeComplete) await onIntakeComplete(intakeResult);
      await new Promise(resolve => setTimeout(resolve, 50));

      const taskEntry = {
        id: `ctask_${messageId.substring(0, 8)}`,
        request: prompt,
        addedAt: new Date().toISOString(),
      };

      const continueResult = await executeQueuedTasks({
        llm,
        userId,
        deviceId,
        messageId,
        previousAgentId: routingResult.targetAgentId || "",
        workspacePath: routingResult.workspacePath,
        toolManifest,
        intakeResult,
        queuedTasks: [taskEntry],
      });

      return {
        intakeResult,
        agentId: continueResult?.agentId || routingResult.targetAgentId,
        workspacePath: routingResult.workspacePath,
        resurfacedModels: [],
        newModelsCreated: [],
        knowledgeGathered: 0,
        executionResponse: continueResult?.finalResponse || routingResult.ackMessage,
        executionSuccess: continueResult?.success,
      };
    }

    if (routingResult.decision !== "new") {
      // MODIFY, QUEUE, or STOP — handle and return early
      return {
        intakeResult,
        shortCircuited: true,
        agentId: routingResult.targetAgentId,
        resurfacedModels: [],
        newModelsCreated: [],
        knowledgeGathered: 0,
        executionResponse: routingResult.ackMessage,
      };
    }
    // decision === "new" — fall through to normal pipeline
  }

  // ── Step 5: Notify caller that intake is done (WS sends ack here) ──
  // Must await + yield so the ack WS frame flushes before receptionist sends tool requests
  if (onIntakeComplete) await onIntakeComplete(intakeResult);
  await new Promise(resolve => setTimeout(resolve, 50));

  // ── Step 6: Run receptionist (tool loop + workspace creation) ──
  log.info("Routing to receptionist", { messageId });

  const { runReceptionist } = await import("./receptionist/receptionist.js");
  const result = await runReceptionist(llm, userId, enhancedRequest, intakeResult);

  // Persist receptionist run-log to client
  sendRunLog(userId, {
    stage: "receptionist",
    messageId,
    agentId: result.agentId,
    workspacePath: result.workspacePath,
    resurfacedModels: result.resurfacedModels,
    newModelsCreated: result.newModelsCreated,
    knowledgeGathered: result.knowledgeGathered,
    intakeResult,
    timestamp: new Date().toISOString(),
  });

  // ── Step 8: Run recruiter (after workspace + intake files are written) ──
  const restatedRequest = (intakeResult.restatedRequest as string) || prompt;
  log.info("Routing to recruiter", { agentId: result.agentId, messageId });

  const { runRecruiter } = await import("./recruiter/recruiter.js");
  const recruiterResult = await runRecruiter(llm, {
    agentId: result.agentId,
    deviceId,
    workspacePath: result.workspacePath,
    intakeResult,
    restatedRequest,
    intakeKnowledgebase: result.intakeKnowledgebase,
  });

  sendRunLog(userId, {
    stage: "recruiter",
    messageId,
    agentId: result.agentId,
    selectedPersonas: recruiterResult.selectedPersonas,
    council: recruiterResult.council,
    modelRole: recruiterResult.modelRole,
    personaPath: recruiterResult.personaPath,
    timestamp: new Date().toISOString(),
  });

  // ── Step 8b: Mark agent as running on model assignments ──
  const allModelSlugs = [...new Set([...result.resurfacedModels, ...result.newModelsCreated])];
  if (allModelSlugs.length > 0) {
    updateAgentAssignmentStatus(deviceId, result.agentId, allModelSlugs, "running").catch(() => {});
  }

  // ── Step 9: Plan + execute ──
  log.info("Routing to planner", { agentId: result.agentId, messageId });

  const { createPlan } = await import("./planner/planning/create-plan.js");
  const { executeSteps } = await import("./planner/execution/step-executor.js");

  const plan = await createPlan(llm, {
    agentId: result.agentId,
    deviceId,
    workspacePath: result.workspacePath,
    restatedRequest,
    intakeKnowledgebase: result.intakeKnowledgebase,
    intakeResult,
    recruiterResult,
  });

  sendRunLog(userId, {
    stage: "planner",
    messageId,
    agentId: result.agentId,
    isSimpleTask: plan.isSimpleTask,
    stepCount: plan.steps.length,
    steps: plan.steps.map(s => ({ id: s.id, title: s.title })),
    timestamp: new Date().toISOString(),
  });

  const executionResult = await executeSteps(plan, {
    llm,
    userId,
    deviceId,
    agentId: result.agentId,
    workspacePath: result.workspacePath,
    customPrompt: recruiterResult.customPrompt,
    modelRole: recruiterResult.modelRole,
    restatedRequest,
    toolManifest,
    skipReplan: plan.isSimpleTask,
  });

  sendRunLog(userId, {
    stage: "execution-complete",
    messageId,
    agentId: result.agentId,
    success: executionResult.success,
    stepsCompleted: executionResult.stepResults.length,
    totalToolCalls: executionResult.totalToolCalls,
    totalIterations: executionResult.totalIterations,
    timestamp: new Date().toISOString(),
  });

  // ── Step 9b: Update agent status on model assignments + disk ──
  const finalStatus = executionResult.success ? "completed" : "failed";
  if (allModelSlugs.length > 0) {
    updateAgentAssignmentStatus(deviceId, result.agentId, allModelSlugs, finalStatus as any).catch(() => {});
  }
  updatePersonaStatus(deviceId, result.workspacePath, finalStatus).catch(() => {});

  // ── Step 10: Check queue — run queued tasks in same workspace ──
  let finalAgentId = result.agentId;
  let finalResponse = executionResult.finalResponse;
  let finalSuccess = executionResult.success;

  let queuedTasks = drainTaskQueue(result.agentId);

  // Disk fallback: if in-memory queue is empty, check agent_persona.json.
  // Covers server-restart scenario where in-memory queues were lost.
  if (queuedTasks.length === 0) {
    try {
      const persona = await readPersonaJson(deviceId, result.workspacePath);
      const diskQueue = persona?.queue as Array<{ id: string; request: string; addedAt: string }> | undefined;
      if (diskQueue && diskQueue.length > 0) {
        queuedTasks = diskQueue;
        log.info("Recovered queued tasks from disk", { agentId: result.agentId, count: diskQueue.length });
      }
    } catch {
      // Best-effort — if persona read fails, no queue to recover
    }
  }

  if (queuedTasks.length > 0 && executionResult.success) {
    log.info("Queue has pending tasks", { agentId: result.agentId, queuedCount: queuedTasks.length });

    const queueResult = await executeQueuedTasks({
      llm,
      userId,
      deviceId,
      messageId,
      previousAgentId: result.agentId,
      workspacePath: result.workspacePath,
      toolManifest,
      intakeResult,
      queuedTasks,
    });

    if (queueResult) {
      finalAgentId = queueResult.agentId;
      finalResponse = queueResult.finalResponse;
      finalSuccess = queueResult.success;
    }
  }

  return {
    intakeResult,
    agentId: finalAgentId,
    workspacePath: result.workspacePath,
    knowledgebasePath: result.knowledgebasePath,
    personaPath: recruiterResult.personaPath,
    resurfacedModels: result.resurfacedModels,
    newModelsCreated: result.newModelsCreated,
    knowledgeGathered: result.knowledgeGathered,
    executionResponse: finalResponse,
    executionSuccess: finalSuccess,
  };
}
