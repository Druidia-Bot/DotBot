/**
 * Routing Handler — Agent Routing Orchestrator
 *
 * Thin orchestrator that wires together:
 *   candidates.ts — candidate collection from memory models
 *   decisions.ts  — MODIFY/QUEUE/STOP/CONTINUE decision handlers
 *   router.ts     — routing LLM call
 *
 * Flow: collect candidates → acquire lock → route → apply decision → release lock
 */

import { createComponentLogger } from "#logging.js";
import { pushSignal, tryAcquireRoutingLock, releaseRoutingLock } from "../agent-signals.js";
import { appendToPersonaRequests } from "../workspace/persona.js";
import { sendAgentLifecycle } from "#ws/device-bridge.js";
import { routeToAgent } from "./router.js";
import { collectCandidates, enrichCandidatesWithSteps } from "./candidates.js";
import { handleModify, handleQueue, handleStop } from "./decisions.js";
import type { ILLMClient } from "#llm/types.js";
import type { AgentRoutingResult } from "../types.js";

const log = createComponentLogger("routing-handler");

/**
 * Check matched models for agent assignments. If any exist, fire the routing LLM
 * and handle MODIFY/QUEUE/STOP/CONTINUE decisions. Returns null if no agents found
 * or decision is NEW (caller should continue normal pipeline).
 */
export async function checkAgentRouting(
  llm: ILLMClient,
  deviceId: string,
  userMessage: string,
  relevantMemories: any[],
): Promise<AgentRoutingResult | null> {
  if (!relevantMemories || relevantMemories.length === 0) return null;

  // ── Collect candidates from matched models ──
  const candidates = await collectCandidates(deviceId, relevantMemories);
  if (candidates.length === 0) return null;

  // ── Acquire routing lock (prevent concurrent routing LLM calls) ──
  const lock = tryAcquireRoutingLock(deviceId);
  if (!lock.acquired) {
    return handleLockedRouting(deviceId, userMessage, lock);
  }

  // ── Enrich candidates with plan.json step progress ──
  await enrichCandidatesWithSteps(deviceId, candidates);

  log.info("Found candidate agents on matched models", {
    candidateCount: candidates.length,
    candidates: candidates.map(c => ({ id: c.agentId, status: c.status, steps: c.steps?.length ?? 0 })),
  });

  // ── Fire routing LLM call ──
  const routing = await routeToAgent(llm, userMessage, candidates);

  // ── Apply decision ──
  if (routing.decision === "modify" && routing.targetAgentId) {
    return handleModify(deviceId, userMessage, routing, candidates);
  }

  if (routing.decision === "queue" && routing.targetAgentId) {
    return handleQueue(deviceId, userMessage, routing, candidates);
  }

  if (routing.decision === "stop" && routing.targetAgentId) {
    return handleStop(deviceId, routing, candidates);
  }

  // decision === "new" — release lock, caller continues normal pipeline
  releaseRoutingLock(deviceId);
  return routing;
}

// ============================================
// RAPID-FIRE COALESCING (lock already held)
// ============================================

function handleLockedRouting(
  deviceId: string,
  userMessage: string,
  lock: ReturnType<typeof tryAcquireRoutingLock>,
): AgentRoutingResult | null {
  if (lock.activeAgentId) {
    pushSignal(lock.activeAgentId, userMessage);
    if (lock.activeWorkspacePath) {
      appendToPersonaRequests(deviceId, lock.activeWorkspacePath, [userMessage]).catch(() => {});
    }
    log.info("Routing lock held — coalescing as MODIFY signal", {
      deviceId,
      targetAgentId: lock.activeAgentId,
    });
    sendAgentLifecycle(deviceId, {
      event: "routing_modify",
      agentId: lock.activeAgentId,
      message: "Your instruction was sent to the running agent",
      detail: `Coalesced as MODIFY signal (rapid follow-up)`,
    });
    return {
      decision: "modify",
      targetAgentId: lock.activeAgentId,
      reasoning: "Routing lock held (rapid-fire) — coalesced as signal",
      ackMessage: "Got it — I've sent your instruction to the agent working on this.",
    };
  }

  // No active agent but lock held — skip routing, let normal pipeline handle it
  log.info("Routing lock held but no active agent — falling through to normal pipeline", { deviceId });
  return null;
}
