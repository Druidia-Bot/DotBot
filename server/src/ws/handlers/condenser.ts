/**
 * Condenser & Loop Resolver Handlers
 *
 * Handles condense_request and resolve_loop_request messages
 * from the local agent's sleep cycle. Delegates to the condenser
 * and loop-resolver services.
 */

import { nanoid } from "nanoid";
import type { WSMessage } from "../../types.js";
import { createComponentLogger } from "#logging.js";
import { devices, sendMessage, broadcastToUser } from "../devices.js";
import { sendExecutionCommand, requestTools } from "../bridge/commands.js";

const log = createComponentLogger("ws.condenser");

export async function handleCondenseRequest(
  deviceId: string,
  message: WSMessage,
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  const { runCondenser } = await import("../../services/condenser/condenser.js");

  try {
    const result = await runCondenser(message.payload, {});

    sendMessage(device.ws, {
      type: "condense_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        threadId: message.payload.thread?.id,
        instructions: result.instructions,
        reasoning: result.reasoning,
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : JSON.stringify(error);
    log.error("Condense request failed", error);
    sendMessage(device.ws, {
      type: "condense_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        threadId: message.payload.thread?.id,
        instructions: [],
        reasoning: `Error: ${errMsg}`,
      },
    });
  }
}

export async function handleResolveLoopRequest(
  deviceId: string,
  message: WSMessage,
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  const { runLoopResolver } = await import("../../services/condenser/loop-resolver.js");

  try {
    // Fetch tool manifest so the resolver can actually execute searches
    let toolOptions: Parameters<typeof runLoopResolver>[2];
    try {
      const toolResult = await requestTools(deviceId);
      if (toolResult?.tools?.length) {
        toolOptions = {
          executeCommand: (command) => sendExecutionCommand(deviceId, command),
          toolManifest: toolResult.tools,
        };
      }
    } catch {
      log.debug("Could not fetch tools for loop resolver, falling back to LLM-only");
    }

    const result = await runLoopResolver(message.payload, {}, toolOptions);

    sendMessage(device.ws, {
      type: "resolve_loop_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        modelSlug: message.payload.modelSlug,
        loopId: message.payload.loop?.id,
        ...result,
      },
    });

    // If the loop was resolved and we should notify the user, broadcast to all their devices
    if (result.notifyUser && result.notification) {
      broadcastToUser(device.session.userId, {
        type: "user_notification",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          source: "sleep_cycle",
          title: `Loop Update: ${message.payload.modelName}`,
          message: result.notification,
          modelSlug: message.payload.modelSlug,
          loopId: message.payload.loop?.id,
        },
      });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : JSON.stringify(error);
    log.error("Resolve loop request failed", error);
    sendMessage(device.ws, {
      type: "resolve_loop_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        modelSlug: message.payload.modelSlug,
        loopId: message.payload.loop?.id,
        resolved: false,
        blockedReason: `Error: ${errMsg}`,
        notifyUser: false,
        newStatus: "blocked",
      },
    });
  }
}
