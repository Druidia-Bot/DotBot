/**
 * Routing Decisions — Handle individual routing outcomes.
 *
 * Each decision (MODIFY, QUEUE, STOP, CONTINUE) gets its own handler.
 * Shared logic (hold-status check, lifecycle notifications) is centralized here.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../../logging.js";
import { pushSignal, queueTask, abortAgent, releaseRoutingLock, isAgentRegistered } from "../agent-signals.js";
import { persistQueueEntry, updatePersonaStatus, appendToPersonaRequests } from "../workspace-io.js";
import { sendAgentLifecycle } from "../../ws/device-bridge.js";
import type { CandidateAgent } from "./router.js";
import type { AgentRoutingResult } from "../types.js";

const log = createComponentLogger("routing-decisions");

/** Statuses where the agent is alive but paused — don't restart, keep queued */
const HOLD_STATUSES = ["blocked", "waiting_on_human"];

/**
 * Check if a candidate should trigger an immediate workspace continuation
 * instead of a normal MODIFY/QUEUE. Returns true if the agent is not running
 * and not in a hold state (blocked/waiting_on_human).
 */
function shouldContinueInWorkspace(candidate: CandidateAgent): boolean {
  if (!candidate) return false;
  if (HOLD_STATUSES.includes(candidate.status)) return false;
  return !isAgentRegistered(candidate.agentId);
}

// ============================================
// CONTINUE — Reuse workspace for non-running agent
// ============================================

function buildContinueResult(
  deviceId: string,
  candidate: CandidateAgent,
  originalDecision: string,
): AgentRoutingResult {
  log.info(`${originalDecision.toUpperCase()} target is not running — continuing in same workspace`, {
    agentId: candidate.agentId,
    status: candidate.status,
    workspacePath: candidate.workspacePath,
  });
  sendAgentLifecycle(deviceId, {
    event: "routing_continue",
    agentId: candidate.agentId,
    message: "Starting your request in the existing workspace",
    detail: `Agent was ${candidate.status} — reusing workspace`,
  });
  releaseRoutingLock(deviceId);
  return {
    decision: "continue",
    targetAgentId: candidate.agentId,
    workspacePath: candidate.workspacePath,
    reasoning: `${originalDecision.toUpperCase()} target ${candidate.agentId} is ${candidate.status} — starting immediately in same workspace`,
    ackMessage: `Got it — starting your request in the existing workspace.`,
  };
}

// ============================================
// MODIFY — Push signal to running agent
// ============================================

export function handleModify(
  deviceId: string,
  userMessage: string,
  routing: AgentRoutingResult,
  candidates: CandidateAgent[],
): AgentRoutingResult {
  const target = candidates.find(c => c.agentId === routing.targetAgentId);

  // Non-running, non-blocked → continue in same workspace
  if (target && shouldContinueInWorkspace(target)) {
    return buildContinueResult(deviceId, target, "modify");
  }

  // Agent is running — normal MODIFY: push signal
  pushSignal(routing.targetAgentId!, userMessage);
  if (target?.workspacePath) {
    appendToPersonaRequests(deviceId, target.workspacePath, [userMessage]).catch(() => {});
  }

  sendAgentLifecycle(deviceId, {
    event: "routing_modify",
    agentId: routing.targetAgentId!,
    message: "Your instruction was sent to the running agent",
    detail: `Routing decided MODIFY — ${routing.reasoning}`,
  });
  releaseRoutingLock(deviceId, routing.targetAgentId!, target?.workspacePath);
  return {
    ...routing,
    ackMessage: `Got it — I've sent your instruction to the agent working on this. It'll incorporate your changes at the next step.`,
  };
}

// ============================================
// QUEUE — Add task behind running agent
// ============================================

export function handleQueue(
  deviceId: string,
  userMessage: string,
  routing: AgentRoutingResult,
  candidates: CandidateAgent[],
): AgentRoutingResult {
  const target = candidates.find(c => c.agentId === routing.targetAgentId);

  // Non-running, non-blocked → continue in same workspace
  if (target && shouldContinueInWorkspace(target)) {
    return buildContinueResult(deviceId, target, "queue");
  }

  // Agent is running — normal QUEUE: add to task queue
  const taskEntry = {
    id: `qtask_${nanoid(8)}`,
    request: userMessage,
    addedAt: new Date().toISOString(),
  };
  queueTask(routing.targetAgentId!, taskEntry);

  if (target?.workspacePath) {
    persistQueueEntry(deviceId, target.workspacePath, taskEntry).catch(() => {});
  }

  sendAgentLifecycle(deviceId, {
    event: "routing_queue",
    agentId: routing.targetAgentId!,
    message: "Your request was queued behind the current task",
    detail: `Routing decided QUEUE — ${routing.reasoning}`,
  });
  releaseRoutingLock(deviceId, routing.targetAgentId!, target?.workspacePath);
  return {
    ...routing,
    ackMessage: `Queued — this will run after the current task finishes in that workspace.`,
  };
}

// ============================================
// STOP — Abort running agent
// ============================================

export function handleStop(
  deviceId: string,
  routing: AgentRoutingResult,
  candidates: CandidateAgent[],
): AgentRoutingResult {
  abortAgent(routing.targetAgentId!);

  const target = candidates.find(c => c.agentId === routing.targetAgentId);
  if (target?.workspacePath) {
    updatePersonaStatus(deviceId, target.workspacePath, "stopped").catch(() => {});
  }

  sendAgentLifecycle(deviceId, {
    event: "routing_stop",
    agentId: routing.targetAgentId!,
    message: "Agent is being stopped",
    detail: `Routing decided STOP — ${routing.reasoning}`,
  });
  releaseRoutingLock(deviceId);
  return {
    ...routing,
    ackMessage: `Stopping the agent. Any completed work is saved in the workspace.`,
  };
}
