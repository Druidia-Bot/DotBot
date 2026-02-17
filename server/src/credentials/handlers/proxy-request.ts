/**
 * Credential Proxy Request Handler
 *
 * Handles WebSocket messages for decrypting credentials and proxying HTTP calls.
 */

import { nanoid } from "nanoid";
import type { WSMessage } from "../../types.js";
import { devices, sendMessage } from "#ws/devices.js";
import { executeProxyRequest } from "../proxy.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("credentials");

/**
 * Handle a credential_proxy_request from the local agent.
 * Decrypts the credential blob, makes the HTTP call, returns the response.
 */
export async function handleCredentialProxyRequest(
  deviceId: string,
  message: WSMessage,
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  const { encrypted_blob, request, credential_placement, request_id } = message.payload;

  if (!encrypted_blob || !request || !credential_placement) {
    sendMessage(device.ws, {
      type: "credential_proxy_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        request_id: request_id || message.id,
        success: false,
        error: "Missing encrypted_blob, request, or credential_placement",
      },
    });
    return;
  }

  try {
    log.debug("Executing proxy request", {
      url: request.url,
      method: request.method,
      keyHeader: credential_placement.header,
    });

    const response = await executeProxyRequest(encrypted_blob, request, credential_placement);

    sendMessage(device.ws, {
      type: "credential_proxy_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        request_id: request_id || message.id,
        success: true,
        status: response.status,
        headers: response.headers,
        body: response.body,
      },
    });
  } catch (err: any) {
    log.error("Proxy request failed", { error: err.message });

    sendMessage(device.ws, {
      type: "credential_proxy_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        request_id: request_id || message.id,
        success: false,
        error: `Credential proxy failed: ${err.message}`,
      },
    });
  }
}
