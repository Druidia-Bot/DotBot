/**
 * Routing Candidates — Collect and enrich agent candidates from memory models.
 *
 * Queries matched models for agent assignments, detects dead agents,
 * and enriches candidates with step progress from plan.json.
 */

import { createComponentLogger } from "../../logging.js";
import { isAgentDead, readPlanFromWorkspace } from "../agent-recovery.js";
import { sendMemoryRequest } from "../../ws/device-bridge.js";
import type { CandidateAgent } from "./router.js";

const log = createComponentLogger("routing-candidates");

/**
 * Collect candidate agents from memory models matched by intake.
 * Excludes failed agents. Detects dead agents (model says "running"
 * but no active executor) and marks them failed.
 */
export async function collectCandidates(
  deviceId: string,
  relevantMemories: any[],
): Promise<CandidateAgent[]> {
  const modelSlugs = relevantMemories
    .filter((m: any) => m.name && m.confidence >= 0.3)
    .map((m: any) => m.name as string);

  if (modelSlugs.length === 0) return [];

  const candidates: CandidateAgent[] = [];

  for (const slug of modelSlugs) {
    try {
      const model = await sendMemoryRequest(deviceId, {
        action: "get_model",
        modelSlug: slug,
      } as any);

      if (model?.agents && Array.isArray(model.agents)) {
        for (const agent of model.agents) {
          // Only exclude failed agents — other statuses (completed, stopped, etc.)
          // are valid candidates because their workspace can be reused within the 24h live period.
          if (agent.agentId && agent.status !== "failed") {
            if (!candidates.some(c => c.agentId === agent.agentId)) {
              candidates.push({
                agentId: agent.agentId,
                restatedRequests: [agent.prompt || "(unknown task)"],
                status: agent.status || "queued",
                workspacePath: agent.workspacePath || "",
                createdAt: agent.createdAt || "",
              });
            }
          }
        }
      }
    } catch (err) {
      log.warn("Failed to query model for agents", { slug, error: err });
    }
  }

  // Detect dead agents: model says "running" but no active executor
  for (const candidate of candidates) {
    if (isAgentDead({ agentId: candidate.agentId, status: candidate.status as any, workspacePath: candidate.workspacePath })) {
      log.warn("Detected dead agent — marking as failed", { agentId: candidate.agentId });
      candidate.status = "failed";
    }
  }

  return candidates;
}

/**
 * Enrich candidates with step progress from plan.json (best-effort).
 * Non-blocking — candidates without plan.json still work.
 */
export async function enrichCandidatesWithSteps(
  deviceId: string,
  candidates: CandidateAgent[],
): Promise<void> {
  await Promise.all(candidates.map(async (candidate) => {
    if (!candidate.workspacePath) return;
    try {
      const plan = await readPlanFromWorkspace(deviceId, candidate.workspacePath);
      if (plan?.steps) {
        const completedIds = new Set(plan.progress?.completedStepIds || []);
        const currentId = plan.progress?.currentStepId;
        candidate.steps = plan.steps.map(s => ({
          id: s.id,
          title: s.title,
          status: completedIds.has(s.id) ? "completed" as const
            : s.id === currentId ? "current" as const
            : "remaining" as const,
        }));
      }
    } catch {
      // No plan.json or parse error — routing still works without steps
    }
  }));
}
