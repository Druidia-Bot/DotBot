/**
 * Credential Entry Routes
 * 
 * HTTP routes for the secure credential entry page.
 * These are regular Hono routes — separate from WebSocket.
 * 
 * GET  /credentials/enter/:token  — Serve the entry form
 * POST /credentials/submit        — Receive credential, encrypt, send blob to client via WS
 */

import type { Hono } from "hono";
import QRCode from "qrcode";
import { getSession, getAndConsumeSession } from "./sessions.js";
import { encryptCredential } from "./crypto.js";
import { clearResolveForCredential } from "./handlers/index.js";
import { devices, sendMessage } from "#ws/devices.js";
import { nanoid } from "nanoid";
import { createComponentLogger } from "#logging.js";
import { validateDeviceSession } from "../auth/device-sessions.js";
import {
  renderEntryPage,
  renderSuccessPage,
  renderExpiredPage,
  renderErrorPage,
  renderSessionUnauthedPage,
  renderSessionAuthedPage,
} from "./templates/index.js";

const log = createComponentLogger("credentials.routes");

// ============================================
// RATE LIMITING
// ============================================

const RATE_LIMIT_MAX = 5;                   // Max failed attempts per IP
const RATE_LIMIT_WINDOW_MS = 15 * 60_000;   // 15-minute window

interface RateEntry {
  count: number;
  firstAttempt: number;
}

const rateLimitMap = new Map<string, RateEntry>();

function isRateLimited(ip: string): boolean {
  const entry = rateLimitMap.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.delete(ip);
    return false;
  }
  return entry.count >= RATE_LIMIT_MAX;
}

function recordFailedAttempt(ip: string): void {
  const entry = rateLimitMap.get(ip);
  if (!entry || Date.now() - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, firstAttempt: Date.now() });
  } else {
    entry.count++;
  }
}

/** @internal For testing only */
export function _clearRateLimits(): void {
  rateLimitMap.clear();
}

// ============================================
// CSP HEADERS
// ============================================

function cspHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline' https://cdn.tailwindcss.com; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
}

// ============================================
// ROUTE REGISTRATION
// ============================================

export function registerCredentialRoutes(app: Hono): void {

  // ----------------------------------------
  // GET /credentials/session
  // Device session landing page (cookie-based auth)
  // ----------------------------------------
  app.get("/credentials/session", (c) => {
    const cookieHeader = c.req.header("cookie") || "";
    const cookies = Object.fromEntries(
      cookieHeader.split(";").map((c) => {
        const [key, ...val] = c.trim().split("=");
        return [key, val.join("=")];
      })
    );

    const sessionId = cookies["dotbot_device_session"];
    if (!sessionId) {
      return c.html(renderSessionUnauthedPage(), 200, cspHeaders());
    }

    const session = validateDeviceSession(sessionId);
    if (!session.valid) {
      return c.html(renderSessionUnauthedPage(), 200, cspHeaders());
    }

    return c.html(
      renderSessionAuthedPage(session.deviceId || "unknown", session.userId || "unknown"),
      200,
      cspHeaders(),
    );
  });

  // ----------------------------------------
  // GET /credentials/enter/:token
  // Serve the secure credential entry form
  // ----------------------------------------
  app.get("/credentials/enter/:token", async (c) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip)) {
      return c.html(renderErrorPage("Too many attempts. Please try again later."), 429, cspHeaders());
    }

    const token = c.req.param("token");
    const session = getSession(token);

    if (!session) {
      recordFailedAttempt(ip);
      return c.html(renderExpiredPage(), 410, cspHeaders());
    }

    // Generate QR code for this page so user can open it on their phone
    const proto = c.req.header("x-forwarded-proto") || "http";
    const host = c.req.header("host") || "localhost:3000";
    const pageUrl = `${proto}://${host}/credentials/enter/${token}`;
    let qrSvg = "";
    try {
      qrSvg = await QRCode.toString(pageUrl, {
        type: "svg",
        margin: 1,
        width: 160,
        color: { dark: "#a78bfa", light: "#00000000" },
      });
    } catch {
      log.warn("Failed to generate QR code for credential entry page");
    }

    return c.html(
      renderEntryPage({
        title: session.title,
        prompt: session.prompt,
        keyName: session.keyName,
        token,
        allowedDomain: session.allowedDomain,
        qrSvg,
      }),
      200,
      cspHeaders(),
    );
  });

  // ----------------------------------------
  // POST /credentials/submit
  // Receive credential from form, encrypt, notify client
  // ----------------------------------------
  app.post("/credentials/submit", async (c) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip)) {
      return c.html(renderErrorPage("Too many attempts. Please try again later."), 429, cspHeaders());
    }

    // CSRF protection: the one-time session token (unguessable, consumed on use)
    // is sufficient. No origin/referer check — it breaks cross-device submission
    // when the phone accesses via QR code (localhost vs LAN IP mismatch).

    const body = await c.req.parseBody();
    const token = body["token"] as string;
    const value = body["value"] as string;

    if (!token || !value) {
      return c.html(renderErrorPage("Missing token or value."), 400, cspHeaders());
    }

    // Atomically get and consume the session (M-06 fix: prevents TOCTOU race)
    const session = getAndConsumeSession(token);
    if (!session) {
      return c.html(renderExpiredPage(), 410, cspHeaders());
    }

    // Encrypt the credential with the server key for this user
    // Domain is baked into the key derivation — credential is cryptographically bound to it
    const encryptedBlob = encryptCredential(session.userId, value, session.allowedDomain);

    // Send the encrypted blob to the client via WebSocket
    const device = devices.get(session.deviceId);
    if (device) {
      sendMessage(device.ws, {
        type: "credential_stored",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          key_name: session.keyName,
          encrypted_blob: encryptedBlob,
        },
      });

      // Clear resolve tracking so the agent can re-resolve the updated credential
      // (e.g., Discord gateway needs to re-resolve the new bot token)
      clearResolveForCredential(session.deviceId, session.keyName);
    }

    return c.html(renderSuccessPage(session.keyName), 200, cspHeaders());
  });
}
