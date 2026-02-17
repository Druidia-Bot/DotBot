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
import type { WSMessage, HeartbeatResult } from "../../types.js";
import { createComponentLogger } from "#logging.js";
import { devices, sendMessage } from "../devices.js";
import { runHeartbeat } from "../../services/heartbeat/index.js";
import { scanForDeadAgents } from "#pipeline/agent-recovery.js";

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
    scanForDeadAgents(deviceId).catch(err => {
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
