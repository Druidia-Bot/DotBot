/**
 * Agent Recovery — Dead Agent Detection + Resumption
 *
 * Detects agents that died mid-execution (registered as "running" in model
 * assignments but not active in agent-signals registry) and provides
 * infrastructure to resume them from the last completed step in plan.json.
 *
 * Two detection paths:
 * 1. On-demand: checkAgentRouting() detects stale "running" status when
 *    processing a new user message. Updates status to "failed" so the
 *    routing LLM sees accurate state.
 * 2. Proactive: scanForDeadAgents() called from heartbeat handler,
 *    lists workspace directories, reads agent_persona.json, detects
 *    "running" agents with no active executor, marks them "failed".
 */

import { createComponentLogger } from "#logging.js";
import { isAgentRegistered } from "./agent-signals.js";
import {
  readPersonaJson,
  writePersonaJson,
  readPlanJson,
} from "./workspace/persona.js";
import { listWorkspaceDir } from "./workspace/io.js";
import type { AgentStatus } from "./recruiter/output.js";

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
}

/**
 * Scan all agent workspaces for dead agents. A dead agent has
 * status "running" in agent_persona.json but is NOT registered
 * in agent-signals (no active executor). Updates status to "failed"
 * on disk and returns info about each dead agent found.
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
    if (!persona?.agentId || persona.status !== "running") continue;
    if (isAgentRegistered(persona.agentId)) continue;

    // Dead agent found — update status on disk
    log.warn("Dead agent detected during scan", {
      agentId: persona.agentId,
      workspacePath,
    });

    persona.status = "failed";
    persona.completedAt = new Date().toISOString();

    try {
      await writePersonaJson(deviceId, workspacePath, persona);
    } catch (err) {
      log.warn("Failed to update dead agent status on disk", {
        agentId: persona.agentId,
        error: err,
      });
    }

    // Read plan.json for progress info
    let completedSteps = 0;
    let remainingSteps = 0;
    const plan = await readPlanJson(deviceId, workspacePath);
    if (plan) {
      completedSteps = plan.progress?.completedStepIds?.length ?? 0;
      remainingSteps = plan.progress?.remainingStepIds?.length ?? 0;
    }

    dead.push({
      agentId: persona.agentId,
      workspacePath,
      completedSteps,
      remainingSteps,
    });
  }

  if (dead.length > 0) {
    log.info("Dead agent scan complete", {
      deadCount: dead.length,
      agents: dead.map(d => d.agentId),
    });
  }

  return dead;
}
