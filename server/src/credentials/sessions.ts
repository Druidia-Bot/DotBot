/**
 * Credential Entry Sessions
 * 
 * Manages one-time-use sessions for the secure credential entry page.
 * Each session has a unique token, expires after 10 minutes, and can
 * only be used once.
 * 
 * Flow:
 * 1. Local agent requests a session via WS
 * 2. Server creates session with random token
 * 3. User navigates to /credentials/enter/<token>
 * 4. User submits credential → server encrypts → sends blob to client via WS
 * 5. Session is consumed (deleted)
 */

import { randomBytes } from "crypto";

// ============================================
// TYPES
// ============================================

export interface CredentialSession {
  token: string;
  userId: string;
  deviceId: string;
  keyName: string;
  prompt: string;
  title: string;
  allowedDomain: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

// ============================================
// SESSION STORE (in-memory, ephemeral)
// ============================================

const sessions = new Map<string, CredentialSession>();

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes — first-time setup needs breathing room
const CLEANUP_INTERVAL_MS = 60 * 1000;  // Prune expired sessions every minute

// Periodic cleanup of expired sessions
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startSessionCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (now > session.expiresAt) {
        sessions.delete(token);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't prevent process exit
  if (cleanupTimer.unref) cleanupTimer.unref();
}

export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================

/**
 * Create a new credential entry session.
 * Returns the session token (used in the URL).
 */
export function createSession(opts: {
  userId: string;
  deviceId: string;
  keyName: string;
  prompt: string;
  title?: string;
  allowedDomain: string;
}): CredentialSession {
  if (!opts.allowedDomain) {
    throw new Error("allowedDomain is required — credentials must be scoped to a specific API domain");
  }
  const token = randomBytes(32).toString("hex"); // 64-char hex token
  const now = Date.now();

  const session: CredentialSession = {
    token,
    userId: opts.userId,
    deviceId: opts.deviceId,
    keyName: opts.keyName,
    prompt: opts.prompt,
    title: opts.title || "DotBot — Secure Credential Entry",
    allowedDomain: opts.allowedDomain.toLowerCase(),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    consumed: false,
  };

  sessions.set(token, session);
  return session;
}

/**
 * Get a session by token. Returns null if expired, consumed, or not found.
 */
export function getSession(token: string): CredentialSession | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.consumed) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

/**
 * Mark a session as consumed (one-time use).
 */
export function consumeSession(token: string): void {
  const session = sessions.get(token);
  if (session) {
    session.consumed = true;
    // Delete after a short delay (allow the response to complete)
    setTimeout(() => sessions.delete(token), 5000);
  }
}

/**
 * Get active (non-consumed, non-expired) session count.
 */
export function getActiveSessionCount(): number {
  const now = Date.now();
  let count = 0;
  for (const session of sessions.values()) {
    if (!session.consumed && now <= session.expiresAt) count++;
  }
  return count;
}

// ============================================
// TESTING SUPPORT
// ============================================

/** @internal Clear all sessions (for testing) */
export function _clearAllSessions(): void {
  sessions.clear();
}
