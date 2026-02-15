/**
 * Credential WS Message Handlers
 * 
 * Handles WebSocket messages for credential operations:
 * - credential_session_request → create secure entry page session
 * - credential_proxy_request → decrypt + proxy HTTP call
 */

import { nanoid } from "nanoid";
import type { WSMessage } from "../types.js";
import { devices, sendMessage } from "#ws/devices.js";
import { createSession } from "./sessions.js";
import { executeProxyRequest } from "./proxy.js";
import { decryptCredential, getBlobDomain } from "./crypto.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("credentials");

const RESOLVABLE_CREDENTIALS = new Set(["DISCORD_BOT_TOKEN"]);

const resolvedThisConnection = new Map<string, Set<string>>();

// ============================================
// SESSION REQUEST HANDLER
// ============================================

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

// ============================================
// PROXY REQUEST HANDLER
// ============================================

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

// ============================================
// CREDENTIAL RESOLVE HANDLER
// ============================================

/**
 * Handle a credential_resolve_request from the local agent.
 * Decrypts the credential blob and returns the plaintext value.
 * 
 * SECURITY:
 * - Hardcoded allowlist: only DISCORD_BOT_TOKEN can be resolved
 * - One resolve per credential per WS connection (no repeated extraction)
 * - Domain enforcement via decryptCredential()
 * - Audit logged
 */
export async function handleCredentialResolveRequest(
  deviceId: string,
  message: WSMessage,
): Promise<void> {
  const device = devices.get(deviceId);
  if (!device) return;

  const { credential_name, encrypted_blob, purpose } = message.payload;

  // Validate required fields
  if (!credential_name || !encrypted_blob || !purpose) {
    sendMessage(device.ws, {
      type: "credential_resolve_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        request_id: message.id,
        success: false,
        error: "Missing credential_name, encrypted_blob, or purpose",
      },
    });
    return;
  }

  // Allowlist check — only specific credentials can be resolved
  if (!RESOLVABLE_CREDENTIALS.has(credential_name)) {
    log.warn("Credential resolve REJECTED — not in allowlist", {
      credential_name,
      purpose,
      deviceId,
    });
    sendMessage(device.ws, {
      type: "credential_resolve_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        request_id: message.id,
        success: false,
        error: `Credential "${credential_name}" is not eligible for resolve. Only gateway credentials are allowed.`,
      },
    });
    return;
  }

  // One resolve per credential per connection — check-and-set atomically
  let deviceResolved = resolvedThisConnection.get(deviceId);
  if (!deviceResolved) {
    deviceResolved = new Set();
    resolvedThisConnection.set(deviceId, deviceResolved);
  }
  if (deviceResolved.has(credential_name)) {
    log.warn("Credential resolve REJECTED — already resolved this connection", {
      credential_name,
      deviceId,
    });
    sendMessage(device.ws, {
      type: "credential_resolve_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        request_id: message.id,
        success: false,
        error: `Credential "${credential_name}" was already resolved for this connection. Reconnect to resolve again.`,
      },
    });
    return;
  }
  // Mark as resolved BEFORE decryption to prevent concurrent duplicates
  deviceResolved.add(credential_name);

  try {
    // Decrypt — domain enforcement happens inside decryptCredential()
    const domain = getBlobDomain(encrypted_blob);
    const plaintext = decryptCredential(encrypted_blob, domain || undefined);

    log.info("Credential RESOLVED", {
      credential_name,
      purpose,
      domain,
      deviceId,
      deviceName: device.session.deviceName,
    });

    sendMessage(device.ws, {
      type: "credential_resolve_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        request_id: message.id,
        success: true,
        plaintext,
      },
    });
  } catch (err: any) {
    // Rollback — allow retry on failure
    deviceResolved.delete(credential_name);

    log.error("Credential resolve FAILED", {
      credential_name,
      error: err.message,
      deviceId,
    });

    sendMessage(device.ws, {
      type: "credential_resolve_response",
      id: nanoid(),
      timestamp: Date.now(),
      payload: {
        request_id: message.id,
        success: false,
        error: "Credential resolve failed — the encrypted blob may be corrupted or the master key may have changed",
      },
    });
  }
}

/**
 * Clean up resolve tracking when a device disconnects.
 * Called from server.ts on WebSocket close.
 */
export function cleanupResolveTracking(deviceId: string): void {
  resolvedThisConnection.delete(deviceId);
}
