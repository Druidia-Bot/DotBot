/**
 * Agent Recovery — Dead Agent Detection + Resumption
 *
 * Detects agents that died mid-execution (registered as "running" in model
 * assignments but not active in agent-signals registry) and provides
 * infrastructure to resume them from the last completed step in plan.json.
 *
 * Three paths:
 * 1. On-demand: checkAgentRouting() detects stale "running" status when
 *    processing a new user message. Updates status to "failed" so the
 *    routing LLM sees accurate state.
 * 2. Proactive: scanForDeadAgents() called from heartbeat handler,
 *    lists workspace directories, reads agent_persona.json, detects
 *    "running" agents with no active executor.
 * 3. Resume: resumeOrphanedAgents() takes scan results and re-enters
 *    the pipeline for agents that have remaining steps.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { isAgentRegistered } from "./agent-signals.js";
import {
  readPersonaJson,
  writePersonaJson,
  readPlanJson,
} from "./workspace/persona.js";
import { listWorkspaceDir } from "./workspace/io.js";
import { sendAgentLifecycle } from "#ws/device-bridge.js";
import type { AgentStatus } from "./recruiter/output.js";
import type { ILLMClient } from "#llm/types.js";

export { readPlanJson as readPlanFromWorkspace, readPersonaJson as readPersonaFromWorkspace } from "./workspace/persona.js";
export type { PlanProgress } from "./workspace/persona.js";

const log = createComponentLogger("agent-recovery");

const WORKSPACE_BASE = "~/.bot/agent-workspaces";

// ============================================
// DEAD AGENT DETECTION
// ============================================

export interface AgentAssignmentInfo {
  agentId: string;
  status: AgentStatus;
  workspacePath: string;
}

/**
 * Check if an agent assignment is stale — model says "running" but no
 * active executor is registered. Returns true if the agent is dead.
 */
export function isAgentDead(agent: AgentAssignmentInfo): boolean {
  if (agent.status !== "running") return false;
  return !isAgentRegistered(agent.agentId);
}

// ============================================
// PROACTIVE DEAD AGENT SCANNING
// ============================================

export interface DeadAgentInfo {
  agentId: string;
  workspacePath: string;
  completedSteps: number;
  remainingSteps: number;
  restatedRequest?: string;
  resumable: boolean;
}

/**
 * Scan all agent workspaces for dead agents. A dead agent has
 * status "running" in agent_persona.json but is NOT registered
 * in agent-signals (no active executor).
 *
 * Resumable agents (remaining steps > 0 and have a restated request)
 * are marked "interrupted" on disk. Non-resumable agents are marked "failed".
 *
 * Called from the heartbeat handler after the normal heartbeat check.
 * Cheap: only filesystem reads + in-memory registry checks.
 */
export async function scanForDeadAgents(deviceId: string): Promise<DeadAgentInfo[]> {
  const dead: DeadAgentInfo[] = [];

  let dirs: string[];
  try {
    dirs = await listWorkspaceDir(deviceId, WORKSPACE_BASE);
  } catch (err) {
    log.debug("Could not list agent workspaces for dead agent scan", { error: err });
    return dead;
  }

  for (const dir of dirs) {
    // Defensive: skip entries that aren't valid directory names (e.g. error strings)
    if (!dir || dir.includes("ERROR") || dir.includes(":") || dir.length > 100) continue;

    const workspacePath = dir.startsWith(WORKSPACE_BASE)
      ? dir
      : `${WORKSPACE_BASE}/${dir}`;

    const persona = await readPersonaJson(deviceId, workspacePath);
    if (!persona?.agentId) continue;

    // Skip completed/stopped agents — those finished intentionally
    const status = persona.status as string;
    if (status === "completed" || status === "stopped") continue;

    // "running" agents that ARE registered are alive — skip them
    if (status === "running" && isAgentRegistered(persona.agentId)) continue;

    // Dead/orphaned agent: status is "running" (no executor), "interrupted", or "failed"
    log.warn("Dead agent detected during scan", {
      agentId: persona.agentId,
      workspacePath,
      diskStatus: status,
    });

    // Read plan.json for progress info
    let completedSteps = 0;
    let remainingSteps = 0;
    const plan = await readPlanJson(deviceId, workspacePath);
    if (plan) {
      completedSteps = plan.progress?.completedStepIds?.length ?? 0;
      remainingSteps = plan.progress?.remainingStepIds?.length ?? 0;
    }

    // Extract original request from persona
    const requests = persona.restatedRequests as string[] | undefined;
    const restatedRequest = requests?.length ? requests.join("\n\n") : undefined;
    const resumable = remainingSteps > 0 && !!restatedRequest;

    // Mark interrupted (resumable) or failed (not resumable) on disk — only update if still "running"
    if (status === "running") {
      persona.status = resumable ? "interrupted" : "failed";
      persona.completedAt = new Date().toISOString();
    }

    try {
      await writePersonaJson(deviceId, workspacePath, persona);
    } catch (err) {
      log.warn("Failed to update dead agent status on disk", {
        agentId: persona.agentId,
        error: err,
      });
    }

    dead.push({
      agentId: persona.agentId,
      workspacePath,
      completedSteps,
      remainingSteps,
      restatedRequest,
      resumable,
    });
  }

  if (dead.length > 0) {
    log.info("Dead agent scan complete", {
      deadCount: dead.length,
      resumable: dead.filter(d => d.resumable).length,
      failed: dead.filter(d => !d.resumable).length,
      agents: dead.map(d => d.agentId),
    });
  }

  return dead;
}

// ============================================
// ORPHANED AGENT RESUMPTION
// ============================================

export interface ResumeResult {
  agentId: string;
  resumed: boolean;
  reason?: string;
}

/**
 * Attempt to resume orphaned agents by re-entering the pipeline.
 * The routing system will see the existing workspace and issue a
 * "continue" decision, picking up from the last completed step.
 *
 * Only resumes agents flagged as resumable by scanForDeadAgents.
 * Non-resumable agents are left as "failed".
 */
export async function resumeOrphanedAgents(
  deadAgents: DeadAgentInfo[],
  llm: ILLMClient,
  userId: string,
  deviceId: string,
): Promise<ResumeResult[]> {
  const resumable = deadAgents.filter(d => d.resumable && d.restatedRequest);
  if (resumable.length === 0) return [];

  const results: ResumeResult[] = [];

  for (const agent of resumable) {
    const messageId = `resume_${nanoid(8)}`;

    log.info("Resuming orphaned agent", {
      agentId: agent.agentId,
      workspacePath: agent.workspacePath,
      completedSteps: agent.completedSteps,
      remainingSteps: agent.remainingSteps,
    });

    sendAgentLifecycle(deviceId, {
      event: "agent_resuming",
      agentId: agent.agentId,
      message: `Resuming interrupted task (${agent.completedSteps} steps done, ${agent.remainingSteps} remaining)`,
    });

    // Set status back to "running" so the routing system sees it as a live workspace
    const persona = await readPersonaJson(deviceId, agent.workspacePath);
    if (persona) {
      persona.status = "running";
      delete persona.completedAt;
      try {
        await writePersonaJson(deviceId, agent.workspacePath, persona);
      } catch {
        // Best-effort
      }
    }

    try {
      // Lazy import to avoid circular dependency
      const { runPipeline } = await import("./pipeline.js");

      // Re-enter the pipeline with the original request.
      // The routing system will detect the existing workspace and
      // issue a "continue" decision, resuming from the last step.
      runPipeline({
        llm,
        userId,
        deviceId,
        prompt: agent.restatedRequest!,
        messageId,
        source: "agent-recovery",
      }).then(() => {
        log.info("Resumed agent pipeline completed", { agentId: agent.agentId });
      }).catch((err) => {
        log.error("Resumed agent pipeline failed", {
          agentId: agent.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      results.push({ agentId: agent.agentId, resumed: true });
    } catch (err) {
      log.error("Failed to resume orphaned agent", {
        agentId: agent.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      results.push({
        agentId: agent.agentId,
        resumed: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
