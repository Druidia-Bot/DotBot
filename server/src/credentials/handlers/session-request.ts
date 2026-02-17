/**
 * Credential Session Request Handler
 *
 * Handles WebSocket messages for creating secure credential entry page sessions.
 */

import { nanoid } from "nanoid";
import type { WSMessage } from "../../types.js";
import { devices, sendMessage } from "#ws/devices.js";
import { createSession } from "../sessions.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("credentials");

/**
 * Handle a credential_session_request from the local agent.
 * Creates a one-time session and returns the URL for the entry page.
 */
export function handleCredentialSessionRequest(
  deviceId: string,
  message: WSMessage,
  serverBaseUrl: string,
): void {
  const device = devices.get(deviceId);
  if (!device) return;

  const { key_name, prompt, title, allowed_domain } = message.payload;

  if (!key_name || !prompt || !allowed_domain) {
    sendMessage(device.ws, {
      type: "credential_session_ready",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        requestId: message.id,
        success: false,
        error: "key_name, prompt, and allowed_domain are required",
      },
    });
    return;
  }

  const session = createSession({
    userId: device.session.userId,
    deviceId,
    keyName: key_name,
    prompt,
    title,
    allowedDomain: allowed_domain,
  });

  const url = `${serverBaseUrl}/credentials/enter/${session.token}`;
  const qrUrl = `https://shareasqrcode.com/?urlText=${encodeURIComponent(url)}`;

  log.info("Created credential entry session", {
    keyName: key_name,
    allowedDomain: allowed_domain,
    userId: device.session.userId,
    token: session.token.substring(0, 8) + "...",
  });

  sendMessage(device.ws, {
    type: "credential_session_ready",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      requestId: message.id,
      success: true,
      url,
      qr_url: qrUrl,
      key_name,
      allowed_domain,
    },
  });
}
