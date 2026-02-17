/**
 * WebSocket Client — Connection management, send/receive, reconnect logic.
 *
 * Owns the WS connection state. Exports `send()` and `sendAndWaitForResponse()`
 * for use by other modules. The `connect()` function wires up message handling
 * via a callback injected at init time.
 */

import WebSocket from "ws";
import { nanoid } from "nanoid";
import type { WSMessage } from "../types.js";
import { SERVER_URL } from "./config.js";

// ============================================
// STATE
// ============================================

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let failingSinceMs = 0;
let messageHandler: ((message: WSMessage) => Promise<void>) | null = null;
let onConnectedCallback: (() => void) | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let missedPongs = 0;

const MAX_RECONNECT_ATTEMPTS = 50;
const BASE_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const CIRCUIT_BREAKER_MS = 60 * 60 * 1000; // 1 hour
const KEEPALIVE_INTERVAL_MS = 20_000; // 20s — fast enough to catch Starlink micro-dropouts
const MAX_MISSED_PONGS = 2; // 2 missed pongs (~40s) = zombie, force reconnect

// Pending server responses for async request/response (sleep cycle condense, resolve loop)
const pendingServerResponses = new Map<string, { resolve: (value: any) => void; reject: (err: any) => void }>();
const PENDING_TIMEOUT_MS = 120_000; // 2 minutes for LLM processing

// ============================================
// INITIALIZATION
// ============================================

/**
 * Set the message handler and post-connect callback before calling connect().
 */
export function initWsClient(opts: {
  onMessage: (message: WSMessage) => Promise<void>;
  onConnected: () => void;
}): void {
  messageHandler = opts.onMessage;
  onConnectedCallback = opts.onConnected;
}

// ============================================
// CONNECTION
// ============================================

export function connect(): void {
  console.log(`[Agent] Connecting to ${SERVER_URL}...`);

  ws = new WebSocket(SERVER_URL);
  const thisWs = ws; // Capture instance — stale close events must not trigger reconnect

  ws.on("open", () => {
    console.log("[Agent] Connected! Authenticating...");
    reconnectAttempts = 0;
    failingSinceMs = 0;
    missedPongs = 0;
    onConnectedCallback?.();
  });

  ws.on("message", async (data) => {
    try {
      const message: WSMessage = JSON.parse(data.toString());
      await messageHandler?.(message);
    } catch (error) {
      console.error("[Agent] Failed to parse message:", error);
    }
  });

  ws.on("close", () => {
    // Guard: if a newer connect() replaced ws, this is a stale close event
    // from the old WebSocket being closed by the server — don't reconnect.
    if (thisWs !== ws) {
      console.log("[Agent] Stale WebSocket closed (already reconnected) — ignoring");
      return;
    }
    console.log("[Agent] Disconnected");
    flushPendingResponses();
    scheduleReconnect();
  });

  ws.on("error", (error) => {
    console.error("[Agent] WebSocket error:", error);
  });
}

function scheduleReconnect(): void {
  if (!failingSinceMs) failingSinceMs = Date.now();
  const failingDuration = Date.now() - failingSinceMs;

  // Circuit breaker: after 1 hour of continuous failures, exit permanently (code 1)
  if (failingDuration > CIRCUIT_BREAKER_MS) {
    console.error(`[Agent] Server unreachable for over 1 hour. Exiting permanently (not restarting).`);
    console.error(`[Agent] Check server status and restart the agent manually.`);
    process.exit(1);
  }

  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    // Exponential backoff with jitter: base * 2^n + random(0..base), capped at 60s
    const exponential = BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
    const jitter = Math.random() * BASE_RECONNECT_DELAY_MS;
    const delay = Math.min(exponential + jitter, MAX_RECONNECT_DELAY_MS);
    console.log(`[Agent] Reconnecting in ${(delay/1000).toFixed(0)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, failing for ${Math.round(failingDuration/1000)}s)...`);
    setTimeout(connect, delay);
  } else {
    // Exit with restart signal so the launcher restarts us with a clean slate
    console.error(`[Agent] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Exiting with restart signal.`);
    process.exit(42);
  }
}

// ============================================
// SEND
// ============================================

export function send(message: WSMessage): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Send a message to the server and wait for a matching response.
 * Used by the sleep cycle to do request/response over WebSocket.
 * The response is matched by requestId in the payload.
 */
export function sendAndWaitForResponse(message: WSMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const requestId = message.id;
    pendingServerResponses.set(requestId, { resolve, reject });

    // Timeout — don't wait forever
    const timer = setTimeout(() => {
      if (pendingServerResponses.has(requestId)) {
        pendingServerResponses.delete(requestId);
        resolve(null); // Resolve with null on timeout, don't crash the cycle
      }
    }, PENDING_TIMEOUT_MS);

    // Clean up timer when resolved
    const original = pendingServerResponses.get(requestId)!;
    pendingServerResponses.set(requestId, {
      resolve: (value: any) => {
        clearTimeout(timer);
        original.resolve(value);
      },
      reject: (err: any) => {
        clearTimeout(timer);
        original.reject(err);
      },
    });

    send(message);
  });
}

// ============================================
// PENDING RESPONSE ROUTING
// ============================================

/**
 * Handle a response from the server that matches a pending request.
 * Routes condense_response and resolve_loop_response back to the sleep cycle.
 */
export function handlePendingResponse(message: WSMessage): void {
  const requestId = message.payload?.requestId;
  if (!requestId) return;

  const pending = pendingServerResponses.get(requestId);
  if (pending) {
    pendingServerResponses.delete(requestId);
    pending.resolve(message.payload);
  }
}

/**
 * Flush all pending server responses on disconnect.
 * Resolves them with null so callers (sleep cycle, etc.) fail fast
 * instead of hanging until the 2-minute timeout.
 */
function flushPendingResponses(): void {
  if (pendingServerResponses.size === 0) return;
  console.log(`[Agent] Flushing ${pendingServerResponses.size} pending server response(s) after disconnect`);
  for (const [id, pending] of pendingServerResponses) {
    pending.resolve(null);
  }
  pendingServerResponses.clear();
}

// ============================================
// KEEPALIVE PING
// ============================================

export function startKeepalivePing(): void {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  missedPongs = 0;

  keepaliveTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      if (missedPongs >= MAX_MISSED_PONGS) {
        console.warn(`[Agent] ${missedPongs} pongs missed — zombie connection, forcing reconnect`);
        missedPongs = 0;
        ws.close(4000, "Zombie connection — missed pongs");
        return;
      }
      missedPongs++;
      send({
        type: "ping",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {}
      });
    }
  }, KEEPALIVE_INTERVAL_MS);
}

/**
 * Called by the message router when a pong is received.
 */
export function handlePong(): void {
  missedPongs = 0;
}

// ============================================
// ACCESSORS
// ============================================

export function getWs(): WebSocket | null {
  return ws;
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}
