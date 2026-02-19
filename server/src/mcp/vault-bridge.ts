/**
 * MCP Vault Bridge — Server-Side Credential Decryption
 *
 * Decrypts vault blobs for MCP server connections.
 * Plaintext credentials exist ONLY in server memory, never on the client.
 * The encrypted blobs are sent by the local agent alongside MCP configs.
 */

import { decryptCredential, getBlobDomain } from "../credentials/crypto.js";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("mcp-gateway");

/** In-memory store of encrypted blobs, keyed by deviceId → credentialName → blob. */
const blobStore = new Map<string, Map<string, string>>();

/**
 * Store encrypted blobs received from the local agent.
 * Called when mcp_configs message arrives with credentialBlobs.
 */
export function storeMcpBlobs(deviceId: string, blobs: Record<string, string>): void {
  let deviceBlobs = blobStore.get(deviceId);
  if (!deviceBlobs) {
    deviceBlobs = new Map();
    blobStore.set(deviceId, deviceBlobs);
  }
  for (const [name, blob] of Object.entries(blobs)) {
    deviceBlobs.set(name, blob);
  }
}

/**
 * Decrypt a vault credential for MCP server connection.
 * Returns the plaintext token or null if unavailable.
 *
 * SECURITY: The plaintext is returned to the caller (MCP manager)
 * which injects it into the transport headers. The plaintext exists
 * only in server memory — never sent over WS, never logged.
 */
export async function vaultDecryptForMcp(
  _userId: string,
  credentialName: string,
  deviceId: string,
): Promise<string | null> {
  const deviceBlobs = blobStore.get(deviceId);
  const blob = deviceBlobs?.get(credentialName);
  if (!blob) {
    log.warn("MCP credential blob not available", { credentialName });
    return null;
  }

  try {
    const domain = getBlobDomain(blob);
    const plaintext = decryptCredential(blob, domain || undefined);
    log.info("MCP credential decrypted", { credentialName, domain });
    return plaintext;
  } catch (err) {
    log.error("MCP credential decryption failed", {
      credentialName,
      error: err instanceof Error ? err.message : err,
    });
    return null;
  }
}

/**
 * Clear stored blobs for a specific device.
 */
export function clearMcpBlobs(deviceId: string): void {
  blobStore.delete(deviceId);
}
