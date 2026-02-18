/**
 * Heartbeat WS Handler — Thin Transport Layer
 *
 * Receives heartbeat_request WS messages, delegates to the heartbeat
 * business logic module, and sends the response back over WebSocket.
 *
 * Same pattern as handlers/prompt.ts → pipeline/pipeline.ts.
 *
 * Business logic: services/heartbeat/heartbeat.ts
 * Scheduler helpers: services/heartbeat/scheduler.ts
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { devices, sendMessage, broadcastToUser } from "../devices.js";
import { runHeartbeat } from "../../services/heartbeat/index.js";
import { scanForDeadAgents, resumeOrphanedAgents } from "#pipeline/agent-recovery.js";
import type { WSMessage, HeartbeatResult } from "../../types.js";

export type { ScheduledTaskCounts } from "../../services/heartbeat/index.js";

const log = createComponentLogger("ws.heartbeat");

export async function handleHeartbeatRequest(
  deviceId: string,
  message: WSMessage,
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  const startTime = Date.now();

  try {
    const result = await runHeartbeat({
      deviceId,
      userId: device.session.userId,
      checklist: message.payload.checklist,
      currentTime: message.payload.currentTime,
      timezone: message.payload.timezone,
      idleDurationMs: message.payload.idleDurationMs,
      consecutiveFailures: message.payload.consecutiveFailures,
    });

    sendMessage(device.ws, {
      type: "heartbeat_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        result,
      },
    });

    log.debug("Heartbeat response sent", {
      status: result.status,
      durationMs: result.durationMs,
      model: result.model,
    });

    // Proactive dead agent scan — runs after heartbeat response, non-blocking
    scanForDeadAgents(deviceId).then(async (deadAgents) => {
      if (deadAgents.length === 0) return;

      const userId = device.session.userId;
      const failed = deadAgents.filter(d => !d.resumable);
      const resumable = deadAgents.filter(d => d.resumable);

      // Notify about non-resumable (failed) agents
      for (const agent of failed) {
        const progress = agent.completedSteps > 0
          ? `It completed ${agent.completedSteps} of ${agent.completedSteps + agent.remainingSteps} steps before being interrupted.`
          : "It was interrupted before completing any steps.";

        broadcastToUser(userId, {
          type: "dispatch_followup",
          id: nanoid(),
          timestamp: Date.now(),
          payload: {
            response: `⚠️ A previously running task (\`${agent.agentId}\`) was interrupted and cannot be automatically resumed. ${progress} The workspace is preserved at \`${agent.workspacePath}\` — you can ask me to review it.`,
            agentId: agent.agentId,
            success: false,
            workspacePath: agent.workspacePath,
            interrupted: true,
          },
        });
      }

      // Auto-resume resumable agents
      if (resumable.length > 0) {
        for (const agent of resumable) {
          broadcastToUser(userId, {
            type: "dispatch_followup",
            id: nanoid(),
            timestamp: Date.now(),
            payload: {
              response: `🔄 Restarting interrupted task (\`${agent.agentId}\`) — it had ${agent.completedSteps} of ${agent.completedSteps + agent.remainingSteps} steps done. Picking up where it left off.`,
              agentId: agent.agentId,
              success: true,
              workspacePath: agent.workspacePath,
              interrupted: true,
              resuming: true,
            },
          });
        }

        const { createClientForSelection } = await import("#llm/factory.js");
        const { selectModel } = await import("#llm/selection/model-selector.js");
        const modelConfig = selectModel({ explicitRole: "workhorse" });
        const llm = createClientForSelection(modelConfig, deviceId);

        resumeOrphanedAgents(resumable, llm, userId, deviceId).catch(err => {
          log.error("Failed to resume orphaned agents", { error: err });
        });
      }

      log.info("Dead agent scan processed", {
        failed: failed.length,
        resuming: resumable.length,
      });
    }).catch(err => {
      log.debug("Dead agent scan failed", { error: err });
    });
  } catch (error) {
    log.error("Heartbeat request failed", { error });

    const errorResult: HeartbeatResult = {
      status: "error",
      content: error instanceof Error ? error.message : "Unknown error",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      model: "none",
      toolsAvailable: false,
    };

    sendMessage(device.ws, {
      type: "heartbeat_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        result: errorResult,
      },
    });
  }
}
