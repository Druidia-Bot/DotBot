/**
 * Handler: agent.status
 *
 * Real-time visibility into running agents with orphan recovery.
 * Supports:
 *  - read_plan: read plan.json + agent_persona.json for a specific agent
 *  - resume_agent: directly resume a specific agent regardless of disk status
 *  - scan_orphaned: scan all workspaces for orphaned agents and auto-resume
 *  - agent_id: check if a specific agent is running
 *  - (no args): list all running agents
 */

import { getRegisteredAgentIds, isAgentRegistered, hasQueuedTasks } from "#pipeline/agent-signals.js";
import { scanForDeadAgents, resumeOrphanedAgents } from "#pipeline/agent-recovery.js";
import {
  readPlanJson,
  readPersonaJson,
  writePersonaJson,
} from "#pipeline/workspace/persona.js";
import { WORKSPACE_BASE } from "#pipeline/workspace/types.js";
import { getDeviceForUser } from "#ws/devices.js";
import { sendAgentLifecycle } from "#ws/device-bridge.js";
import { createComponentLogger } from "#logging.js";
import { nanoid } from "nanoid";
import type { ToolHandler, ToolContext } from "#tool-loop/types.js";

const log = createComponentLogger("dot.tools.agent-status");

/** Derive workspace path from agent ID. */
function workspaceFor(agentId: string): string {
  return `${WORKSPACE_BASE}/${agentId}`;
}

export function agentStatusHandler(): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>) => {
    const agentId = args.agent_id as string | undefined;
    const readPlan = args.read_plan as boolean | undefined;
    const resumeAgent = args.resume_agent as boolean | undefined;
    const scanOrphaned = args.scan_orphaned as boolean | undefined;

    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);

    // ── Read plan.json + persona for a specific agent ──────────
    if (readPlan && agentId) {
      if (!deviceId) return JSON.stringify({ error: "No local agent connected — cannot read workspace." });

      const ws = workspaceFor(agentId);
      const [plan, persona] = await Promise.all([
        readPlanJson(deviceId, ws),
        readPersonaJson(deviceId, ws),
      ]);

      if (!plan && !persona) {
        return JSON.stringify({
          error: `No workspace found for ${agentId}. The workspace may not exist at ${ws}.`,
        });
      }

      const running = isAgentRegistered(agentId);

      return JSON.stringify({
        agentId,
        running,
        workspacePath: ws,
        status: persona?.status ?? "unknown",
        plan: plan ? {
          approach: plan.approach,
          totalSteps: plan.steps?.length ?? 0,
          steps: plan.steps?.map(s => ({ id: s.id, title: s.title, description: s.description })),
          completedStepIds: plan.progress?.completedStepIds ?? [],
          remainingStepIds: plan.progress?.remainingStepIds ?? [],
          currentStepId: plan.progress?.currentStepId,
          failedAt: plan.progress?.failedAt,
          stoppedAt: plan.progress?.stoppedAt,
        } : null,
        restatedRequests: persona?.restatedRequests ?? [],
        message: plan
          ? `Plan has ${plan.steps?.length ?? 0} steps. Completed: [${(plan.progress?.completedStepIds ?? []).join(", ")}]. Remaining: [${(plan.progress?.remainingStepIds ?? []).join(", ")}]. Current status on disk: ${persona?.status ?? "unknown"}.`
          : "No plan.json found — agent may not have reached the planning stage.",
      });
    }

    // ── Resume a specific agent by ID ──────────────────────────
    if (resumeAgent && agentId) {
      if (!deviceId) return JSON.stringify({ error: "No local agent connected — cannot resume agent." });

      // Check if already running
      if (isAgentRegistered(agentId)) {
        return JSON.stringify({
          agentId,
          resumed: false,
          reason: "Agent is already actively running. No action needed.",
        });
      }

      const ws = workspaceFor(agentId);
      const [plan, persona] = await Promise.all([
        readPlanJson(deviceId, ws),
        readPersonaJson(deviceId, ws),
      ]);

      if (!persona) {
        return JSON.stringify({
          agentId,
          resumed: false,
          reason: `No agent_persona.json found at ${ws}. Cannot resume.`,
        });
      }

      // Extract original request
      const requests = persona.restatedRequests as string[] | undefined;
      const restatedRequest = requests?.length ? requests.join("\n\n") : undefined;
      if (!restatedRequest) {
        return JSON.stringify({
          agentId,
          resumed: false,
          reason: "No restatedRequests found in agent_persona.json — cannot determine what to resume.",
        });
      }

      const remainingSteps = plan?.progress?.remainingStepIds?.length ?? 0;
      const completedSteps = plan?.progress?.completedStepIds?.length ?? 0;

      // Set status back to "running" so the routing system picks it up
      persona.status = "running";
      delete persona.completedAt;
      try {
        await writePersonaJson(deviceId, ws, persona);
      } catch {
        // Best-effort
      }

      log.info("Directly resuming agent by user request", {
        agentId,
        workspacePath: ws,
        completedSteps,
        remainingSteps,
        previousStatus: persona.status,
      });

      sendAgentLifecycle(deviceId, {
        event: "agent_resuming",
        agentId,
        message: `Resuming by user request (${completedSteps} steps done, ${remainingSteps} remaining)`,
      });

      try {
        const { runPipeline } = await import("#pipeline/pipeline.js");
        const { createClientForSelection } = await import("#llm/factory.js");
        const { selectModel } = await import("#llm/selection/model-selector.js");
        const modelConfig = selectModel({ explicitRole: "workhorse" });
        const llm = createClientForSelection(modelConfig, deviceId);
        const messageId = `resume_${nanoid(8)}`;

        runPipeline({
          llm,
          userId,
          deviceId,
          prompt: restatedRequest,
          messageId,
          source: "agent-recovery",
        }).then(() => {
          log.info("Resumed agent pipeline completed", { agentId });
        }).catch((err) => {
          log.error("Resumed agent pipeline failed", {
            agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        return JSON.stringify({
          agentId,
          resumed: true,
          completedSteps,
          remainingSteps,
          message: `Agent ${agentId} has been resumed. It will pick up from where it left off (${completedSteps} steps completed, ${remainingSteps} remaining).`,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("Failed to resume agent", { agentId, error: errMsg });
        return JSON.stringify({
          agentId,
          resumed: false,
          reason: `Pipeline re-entry failed: ${errMsg}`,
        });
      }
    }

    // ── Orphaned agent scan + auto-resume ──────────────────────
    if (scanOrphaned) {
      if (!deviceId) return JSON.stringify({ error: "No local agent connected — cannot scan workspaces." });

      const deadAgents = await scanForDeadAgents(deviceId);
      if (deadAgents.length === 0) {
        return JSON.stringify({
          orphanedAgents: [],
          message: "No orphaned agents found. All workspace agents are either actively running or already completed/failed.",
        });
      }

      const resumable = deadAgents.filter(d => d.resumable);
      const failed = deadAgents.filter(d => !d.resumable);

      // Auto-resume resumable agents
      if (resumable.length > 0) {
        const { createClientForSelection } = await import("#llm/factory.js");
        const { selectModel } = await import("#llm/selection/model-selector.js");
        const modelConfig = selectModel({ explicitRole: "workhorse" });
        const llm = createClientForSelection(modelConfig, deviceId);

        const results = await resumeOrphanedAgents(resumable, llm, userId, deviceId);

        return JSON.stringify({
          orphanedAgents: deadAgents.map(d => ({
            agentId: d.agentId,
            workspacePath: d.workspacePath,
            completedSteps: d.completedSteps,
            remainingSteps: d.remainingSteps,
            resumable: d.resumable,
            resumed: results.find(r => r.agentId === d.agentId)?.resumed ?? false,
          })),
          resumed: results.filter(r => r.resumed).length,
          failed: failed.length,
          message: `Found ${deadAgents.length} orphaned agent(s). Resumed ${results.filter(r => r.resumed).length}, ${failed.length} cannot be resumed (no remaining steps or missing request).`,
        });
      }

      return JSON.stringify({
        orphanedAgents: deadAgents.map(d => ({
          agentId: d.agentId,
          workspacePath: d.workspacePath,
          completedSteps: d.completedSteps,
          remainingSteps: d.remainingSteps,
          resumable: d.resumable,
        })),
        resumed: 0,
        failed: failed.length,
        message: `Found ${failed.length} orphaned agent(s) but none are resumable (no remaining steps or missing request).`,
      });
    }

    // ── Single agent check ─────────────────────────────────────
    if (agentId) {
      const running = isAgentRegistered(agentId);
      const queued = hasQueuedTasks(agentId);
      return JSON.stringify({
        agentId,
        running,
        hasQueuedTasks: queued,
        message: running
          ? `Agent ${agentId} is ACTIVELY RUNNING right now. Do not tell the user it has stalled.`
          : `Agent ${agentId} is NOT running (either completed, failed, or was never started).`,
      });
    }

    // ── List all running agents ────────────────────────────────
    const allRunning = getRegisteredAgentIds();
    if (allRunning.length === 0) {
      return JSON.stringify({
        runningAgents: [],
        message: "No agents are currently running.",
      });
    }

    return JSON.stringify({
      runningAgents: allRunning,
      message: `${allRunning.length} agent(s) currently running: ${allRunning.join(", ")}`,
    });
  };
}
