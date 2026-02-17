/**
 * Credential Resolve Handler
 *
 * Handles WebSocket messages for decrypting credential blobs and returning
 * plaintext values to the local agent. Used for gateway credentials (e.g. Discord bot token).
 *
 * SECURITY:
 * - Hardcoded allowlist: only DISCORD_BOT_TOKEN can be resolved
 * - One resolve per credential per WS connection (no repeated extraction)
 * - Domain enforcement via decryptCredential()
 * - Audit logged
 */

import { nanoid } from "nanoid";
import type { WSMessage } from "../../types.js";
import { devices, sendMessage } from "#ws/devices.js";
import { decryptCredential, getBlobDomain } from "../crypto.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("credentials");

const RESOLVABLE_CREDENTIALS = new Set(["DISCORD_BOT_TOKEN"]);

const resolvedThisConnection = new Map<string, Set<string>>();

// ============================================
// HANDLER
// ============================================

/**
 * Handle a credential_resolve_request from the local agent.
 * Decrypts the credential blob and returns the plaintext value.
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

// ============================================
// RESOLVE TRACKING CLEANUP
// ============================================

/**
 * Clean up resolve tracking when a device disconnects.
 * Called from server.ts on WebSocket close.
 */
export function cleanupResolveTracking(deviceId: string): void {
  resolvedThisConnection.delete(deviceId);
}

/**
 * Clear resolve tracking for a specific credential on a specific device.
 * Called when credential_stored fires — the old resolved value is stale,
 * so the agent must be allowed to re-resolve the updated credential.
 */
export function clearResolveForCredential(deviceId: string, credentialName: string): void {
  const deviceResolved = resolvedThisConnection.get(deviceId);
  if (deviceResolved) {
    deviceResolved.delete(credentialName);
  }
}
