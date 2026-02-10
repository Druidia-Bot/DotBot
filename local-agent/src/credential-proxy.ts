/**
 * Credential Proxy — Client-Side
 * 
 * Routes authenticated HTTP requests through the server.
 * The server decrypts the credential and makes the API call on our behalf.
 * The plaintext credential NEVER exists on the client.
 * 
 * Usage:
 *   const response = await credentialProxyFetch("/users/@me", "DISCORD_BOT_TOKEN", {
 *     baseUrl: "https://discord.com/api/v10",
 *     placement: { header: "Authorization", prefix: "Bot " },
 *   });
 */

import { nanoid } from "nanoid";
import { vaultGetBlob, isServerEncrypted } from "./credential-vault.js";

// ============================================
// TYPES
// ============================================

export interface ProxyFetchOptions {
  baseUrl: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  files?: Array<{
    fieldName: string;
    filename: string;
    contentType: string;
    data: string; // base64-encoded
  }>;
  placement: {
    header: string;
    prefix: string;
  };
}

export interface ProxyFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ============================================
// WS SENDER (set by index.ts after connection)
// ============================================

type WSSender = (message: any) => void;

let wsSend: WSSender | null = null;

/**
 * Initialize the credential proxy with the WS send function.
 * Called once after WS connection is established.
 */
export function initCredentialProxy(send: WSSender): void {
  wsSend = send;
}

// ============================================
// PENDING RESPONSES
// ============================================

const pendingProxyResponses = new Map<string, {
  resolve: (value: ProxyFetchResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const PROXY_TIMEOUT_MS = 45_000; // 45 seconds (30s server-side + buffer)

/**
 * Handle a credential_proxy_response from the server.
 * Called by index.ts when it receives this message type.
 */
export function handleProxyResponse(payload: any): void {
  const requestId = payload.request_id;
  if (!requestId) return;

  const pending = pendingProxyResponses.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingProxyResponses.delete(requestId);

  if (!payload.success) {
    pending.reject(new Error(payload.error || "Credential proxy request failed"));
    return;
  }

  pending.resolve({
    ok: payload.status >= 200 && payload.status < 300,
    status: payload.status,
    headers: payload.headers || {},
    body: payload.body || "",
  });
}

// ============================================
// PROXY FETCH
// ============================================

/**
 * Make an authenticated HTTP request through the server proxy.
 * The credential is decrypted server-side — never in plaintext on client.
 * 
 * @param path - URL path (appended to baseUrl)
 * @param credentialName - Vault key name (e.g., "DISCORD_BOT_TOKEN")
 * @param options - Request options including baseUrl and credential placement
 * @returns Proxy fetch result with status, headers, body
 * @throws If credential not found, not server-encrypted, or proxy fails
 */
export async function credentialProxyFetch(
  path: string,
  credentialName: string,
  options: ProxyFetchOptions,
): Promise<ProxyFetchResult> {
  if (!wsSend) {
    throw new Error("Credential proxy not initialized — WS connection not established");
  }

  // Get the encrypted blob from vault
  const blob = await vaultGetBlob(credentialName);
  if (!blob) {
    throw new Error(`Credential "${credentialName}" not found in vault`);
  }

  // Must be server-encrypted to use proxy
  if (!blob.startsWith("srv:")) {
    throw new Error(`Credential "${credentialName}" is not server-encrypted — cannot use proxy. Re-enter via secrets.prompt_user.`);
  }

  const requestId = nanoid();
  const url = options.baseUrl + path;

  // Send proxy request via WS
  const message = {
    type: "credential_proxy_request",
    id: requestId,
    timestamp: Date.now(),
    payload: {
      request_id: requestId,
      encrypted_blob: blob,
      request: {
        url,
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body,
        ...(options.files && options.files.length > 0 && { files: options.files }),
      },
      credential_placement: options.placement,
    },
  };

  // Wait for response using promise + timeout
  return new Promise<ProxyFetchResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingProxyResponses.delete(requestId);
      reject(new Error("Credential proxy request timed out (45s)"));
    }, PROXY_TIMEOUT_MS);

    pendingProxyResponses.set(requestId, { resolve, reject, timer });
    wsSend!(message);
  });
}



// ============================================
// CREDENTIAL RESOLVE (for Discord Gateway)
// ============================================

const pendingResolveResponses = new Map<string, {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const RESOLVE_TIMEOUT_MS = 15_000; // 15 seconds

/**
 * Resolve a credential to its plaintext value via the server.
 * Used ONLY for Discord Gateway IDENTIFY — the server enforces an allowlist.
 * The plaintext value should be held in memory only, never logged or persisted.
 */
export async function resolveCredential(
  credentialName: string,
  purpose: string,
): Promise<string> {
  if (!wsSend) {
    throw new Error("Credential proxy not initialized — WS connection not established");
  }

  const blob = await vaultGetBlob(credentialName);
  if (!blob) {
    throw new Error(`Credential "${credentialName}" not found in vault`);
  }

  if (!blob.startsWith("srv:")) {
    throw new Error(`Credential "${credentialName}" is not server-encrypted — cannot resolve`);
  }

  const requestId = nanoid();

  const message = {
    type: "credential_resolve_request",
    id: requestId,
    timestamp: Date.now(),
    payload: {
      credential_name: credentialName,
      encrypted_blob: blob,
      purpose,
    },
  };

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResolveResponses.delete(requestId);
      reject(new Error("Credential resolve request timed out (15s)"));
    }, RESOLVE_TIMEOUT_MS);

    pendingResolveResponses.set(requestId, { resolve, reject, timer });
    wsSend!(message);
  });
}

/**
 * Handle a credential_resolve_response from the server.
 * Called by index.ts when it receives this message type.
 */
export function handleResolveResponse(payload: any): void {
  const requestId = payload.request_id;
  if (!requestId) return;

  const pending = pendingResolveResponses.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingResolveResponses.delete(requestId);

  if (!payload.success) {
    pending.reject(new Error(payload.error || "Credential resolve failed"));
    return;
  }

  if (!payload.plaintext || typeof payload.plaintext !== "string") {
    pending.reject(new Error("Credential resolve returned empty or invalid value"));
    return;
  }

  pending.resolve(payload.plaintext);
}

// ============================================
// CREDENTIAL SESSION (for secrets.prompt_user)
// ============================================

const pendingSessionResponses = new Map<string, {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const SESSION_TIMEOUT_MS = 15_000; // 15 seconds for session creation

/**
 * Request a secure credential entry session from the server.
 * Returns the URL for the entry page.
 */
export async function requestCredentialSession(
  keyName: string,
  prompt: string,
  allowedDomain: string,
  title?: string,
): Promise<{ url: string; qrUrl: string; keyName: string; allowedDomain: string }> {
  if (!wsSend) {
    throw new Error("Credential proxy not initialized — WS connection not established");
  }
  if (!allowedDomain) {
    throw new Error("allowedDomain is required — credentials must be scoped to a specific API domain");
  }

  const requestId = nanoid();

  const message = {
    type: "credential_session_request",
    id: requestId,
    timestamp: Date.now(),
    payload: { key_name: keyName, prompt, title, allowed_domain: allowedDomain },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSessionResponses.delete(requestId);
      reject(new Error("Credential session request timed out"));
    }, SESSION_TIMEOUT_MS);

    pendingSessionResponses.set(requestId, { resolve, reject, timer });
    wsSend!(message);
  });
}

/**
 * Handle a credential_session_ready response from the server.
 */
export function handleSessionReady(payload: any): void {
  const requestId = payload.requestId;
  if (!requestId) return;

  const pending = pendingSessionResponses.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingSessionResponses.delete(requestId);

  if (!payload.success) {
    pending.reject(new Error(payload.error || "Failed to create credential session"));
    return;
  }

  pending.resolve({
    url: payload.url,
    qrUrl: payload.qr_url,
    keyName: payload.key_name,
    allowedDomain: payload.allowed_domain,
  });
}

/**
 * Pending credential storage notifications.
 * When the user submits on the web page, the server sends credential_stored.
 * The prompt_user handler waits on this.
 */
const pendingStoredCallbacks = new Map<string, {
  resolve: (blob: string) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const STORED_TIMEOUT_MS = 900_000; // 15 minutes — first-time setup (e.g., creating a Discord bot) takes time

/**
 * Wait for a credential to be stored by the server (after user submits on web page).
 */
export function waitForCredentialStored(keyName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStoredCallbacks.delete(keyName);
      reject(new Error("Credential entry timed out (15 minute limit)"));
    }, STORED_TIMEOUT_MS);

    pendingStoredCallbacks.set(keyName, { resolve, timer });
  });
}

/**
 * Handle a credential_stored message from the server.
 * Stores the blob in the vault and resolves the waiting promise.
 */
export function handleCredentialStored(payload: any): { keyName: string; blob: string } | null {
  const { key_name, encrypted_blob } = payload;
  if (!key_name || !encrypted_blob) return null;

  const pending = pendingStoredCallbacks.get(key_name);
  if (pending) {
    clearTimeout(pending.timer);
    pendingStoredCallbacks.delete(key_name);
    pending.resolve(encrypted_blob);
  }

  return { keyName: key_name, blob: encrypted_blob };
}
