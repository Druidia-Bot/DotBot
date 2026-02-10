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
import { getSession, consumeSession } from "./sessions.js";
import { encryptCredential } from "./crypto.js";
import { devices, sendMessage } from "../ws/devices.js";
import { nanoid } from "nanoid";
import { createComponentLogger } from "../logging.js";

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
// ROUTE REGISTRATION
// ============================================

export function registerCredentialRoutes(app: Hono): void {

  // ----------------------------------------
  // GET /credentials/enter/:token
  // Serve the secure credential entry form
  // ----------------------------------------
  app.get("/credentials/enter/:token", async (c) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip)) {
      return c.html(errorPage("Too many attempts. Please try again later."), 429, cspHeaders());
    }

    const token = c.req.param("token");
    const session = getSession(token);

    if (!session) {
      recordFailedAttempt(ip);
      return c.html(expiredPage(), 410, cspHeaders());
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

    return c.html(entryPage(session.title, session.prompt, session.keyName, token, session.allowedDomain, qrSvg), 200, cspHeaders());
  });

  // ----------------------------------------
  // POST /credentials/submit
  // Receive credential from form, encrypt, notify client
  // ----------------------------------------
  app.post("/credentials/submit", async (c) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip)) {
      return c.html(errorPage("Too many attempts. Please try again later."), 429, cspHeaders());
    }

    // CSRF protection: the one-time session token (unguessable, consumed on use)
    // is sufficient. No origin/referer check — it breaks cross-device submission
    // when the phone accesses via QR code (localhost vs LAN IP mismatch).

    const body = await c.req.parseBody();
    const token = body["token"] as string;
    const value = body["value"] as string;

    if (!token || !value) {
      return c.html(errorPage("Missing token or value."), 400, cspHeaders());
    }

    const session = getSession(token);
    if (!session) {
      return c.html(expiredPage(), 410, cspHeaders());
    }

    // Consume the session immediately (one-time use)
    consumeSession(token);

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
    }

    return c.html(successPage(session.keyName), 200, cspHeaders());
  });
}

// ============================================
// HTML TEMPLATES
// ============================================

/**
 * CSP headers for all credential pages.
 * Strict policy: no external resources, no eval, inline styles/scripts only.
 */
function cspHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
}

function entryPage(title: string, prompt: string, keyName: string, token: string, allowedDomain: string, qrSvg: string): string {
  // Escape HTML entities in user-provided strings
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f23;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .card {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 40px;
      max-width: 520px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .logo {
      text-align: center;
      margin-bottom: 24px;
    }
    .logo span {
      font-size: 28px;
      font-weight: 700;
      background: linear-gradient(135deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .badge {
      display: inline-block;
      background: #1e3a2f;
      color: #4ade80;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 20px;
      margin-top: 8px;
      letter-spacing: 0.5px;
    }
    .prompt {
      background: #16162b;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      padding: 16px;
      margin: 20px 0;
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .key-name {
      color: #a78bfa;
      font-family: 'Consolas', 'Fira Code', monospace;
      font-size: 13px;
    }
    label {
      display: block;
      font-size: 13px;
      color: #999;
      margin-bottom: 8px;
    }
    input[type="password"], input[type="text"] {
      width: 100%;
      padding: 12px 16px;
      background: #0f0f23;
      border: 1px solid #333366;
      border-radius: 8px;
      color: #e0e0e0;
      font-family: 'Consolas', 'Fira Code', monospace;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus {
      border-color: #667eea;
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 12px 0 24px 0;
      font-size: 13px;
      color: #888;
    }
    .toggle-row input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: #667eea;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .security-note {
      margin-top: 20px;
      padding: 12px;
      background: #1e1e3a;
      border-radius: 8px;
      font-size: 12px;
      color: #777;
      line-height: 1.5;
    }
    .security-note strong { color: #4ade80; }
    .domain-badge {
      text-align: center;
      margin: 12px 0;
      padding: 6px 16px;
      background: #162032;
      border: 1px solid #1e3a5f;
      border-radius: 6px;
      font-size: 13px;
      color: #7dd3fc;
    }
    .domain-badge strong { color: #38bdf8; }
    .phone-entry {
      margin-top: 20px;
      padding: 16px;
      background: #162032;
      border: 1px solid #1e3a5f;
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .phone-entry-qr {
      flex-shrink: 0;
      width: 120px;
      height: 120px;
    }
    .phone-entry-qr svg {
      width: 100%;
      height: 100%;
    }
    .phone-entry-text {
      font-size: 12px;
      color: #7dd3fc;
      line-height: 1.5;
    }
    .phone-entry-text strong {
      color: #a78bfa;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <span>DotBot</span><br>
      <span class="badge">SECURE CREDENTIAL ENTRY</span>
    </div>

    <div class="domain-badge">
      Scoped to: <strong>${esc(allowedDomain)}</strong>
    </div>

    <div class="prompt">${esc(prompt)}</div>

    <form method="POST" action="/credentials/submit" id="credForm">
      <input type="hidden" name="token" value="${esc(token)}">

      <label>Enter value for <span class="key-name">${esc(keyName)}</span></label>
      <input type="password" name="value" id="valueInput" required autocomplete="off" autofocus
             placeholder="Paste or type your credential here">

      <div class="toggle-row">
        <input type="checkbox" id="showToggle">
        <label for="showToggle" style="margin:0; cursor:pointer;">Show value</label>
      </div>

      <button type="submit" id="submitBtn">Store Securely</button>
    </form>

    <div class="security-note">
      <strong>🔒 Security:</strong> This credential is encrypted with a server-side key and
      cryptographically bound to <strong>${esc(allowedDomain)}</strong>. It can only be used
      for API calls to that domain — it cannot be exfiltrated to any other destination.
      The LLM never sees the real value.
    </div>

    ${qrSvg ? `
    <div class="phone-entry">
      <div class="phone-entry-qr">${qrSvg}</div>
      <div class="phone-entry-text">
        <strong>📱 Prefer a different device?</strong><br>
        Scan this QR code to open this page on your phone or tablet.
        This protects against keyloggers, browser extensions, or other
        software that may be monitoring this computer.
      </div>
    </div>` : ""}
  </div>

  <script>
    const input = document.getElementById('valueInput');
    const toggle = document.getElementById('showToggle');
    const form = document.getElementById('credForm');
    const btn = document.getElementById('submitBtn');

    toggle.addEventListener('change', () => {
      input.type = toggle.checked ? 'text' : 'password';
    });

    form.addEventListener('submit', () => {
      btn.disabled = true;
      btn.textContent = 'Encrypting…';
    });
  </script>
</body>
</html>`;
}

function successPage(keyName: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Credential Stored</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f23;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .card {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 40px;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .check { font-size: 48px; margin-bottom: 16px; }
    h2 { color: #4ade80; margin-bottom: 12px; }
    p { color: #999; font-size: 14px; line-height: 1.6; }
    .key-name { color: #a78bfa; font-family: 'Consolas', monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h2>Credential Stored</h2>
    <p><span class="key-name">${esc(keyName)}</span> has been encrypted and stored securely.
    You can close this tab and return to DotBot.</p>
  </div>
</body>
</html>`;
}

function expiredPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Session Expired</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f23;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .card {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 40px;
      max-width: 420px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    h2 { color: #f87171; margin-bottom: 12px; }
    p { color: #999; font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Session Expired</h2>
    <p>This credential entry link has expired or was already used.
    Return to DotBot and request a new one.</p>
  </div>
</body>
</html>`;
}

function errorPage(message: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Error</title>
  <style>
    body { font-family: sans-serif; background: #0f0f23; color: #e0e0e0;
           display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 12px;
            padding: 40px; max-width: 420px; text-align: center; }
    h2 { color: #f87171; margin-bottom: 12px; }
    p { color: #999; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Error</h2>
    <p>${esc(message)}</p>
  </div>
</body>
</html>`;
}
