/**
 * Invite Page Routes
 * 
 * Public HTTP routes that serve a branded install page for new users.
 * An admin shares a link like https://myserver.com/invite/dbot-XXXX-XXXX-XXXX-XXXX
 * and the recipient sees a page with a one-liner install command pre-filled.
 * 
 * GET  /invite/:token          — Branded HTML page with install instructions
 * GET  /invite/:token/install  — PowerShell bootstrap script (piped to iex)
 */

import type { Hono } from "hono";
import { peekToken } from "./invite-tokens.js";
import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("auth.invite-page");

const DEFAULT_REPO_URL = "https://github.com/Druidia-Bot/DotBot.git";
const TOKEN_FORMAT = /^dbot-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60_000;

interface RateEntry {
  count: number;
  firstAttempt: number;
}

const rateLimitMap = new Map<string, RateEntry>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60_000);
if (cleanupTimer.unref) cleanupTimer.unref();

function isRateLimited(ip: string): boolean {
  const entry = rateLimitMap.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.delete(ip);
    return false;
  }
  return entry.count >= RATE_LIMIT_MAX;
}

function recordAttempt(ip: string): void {
  const entry = rateLimitMap.get(ip);
  if (!entry || Date.now() - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, firstAttempt: Date.now() });
  } else {
    entry.count++;
  }
}

// ============================================
// HELPERS
// ============================================

function deriveWsUrl(publicUrl: string, wsPort: string): string {
  try {
    const parsed = new URL(publicUrl);
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "0.0.0.0";
    if (isLocal) {
      return `ws://${parsed.hostname}:${wsPort}`;
    }
    return `wss://${parsed.hostname}/ws`;
  } catch {
    return `ws://localhost:${wsPort}`;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  };
}

// ============================================
// ROUTE REGISTRATION
// ============================================

export function registerInviteRoutes(app: Hono, config: { publicUrl: string; wsPort: string }): void {
  const wsUrl = deriveWsUrl(config.publicUrl, config.wsPort);
  const repoUrl = process.env.REPO_URL || DEFAULT_REPO_URL;

  // ----------------------------------------
  // GET /invite/:token
  // Branded install page with one-liner command
  // ----------------------------------------
  app.get("/invite/:token", (c) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip)) {
      return c.html(invalidTokenPage(), 429, securityHeaders());
    }

    const token = c.req.param("token");
    if (!TOKEN_FORMAT.test(token)) {
      recordAttempt(ip);
      return c.html(invalidTokenPage(), 404, securityHeaders());
    }

    const peek = peekToken(token);
    if (!peek.valid) {
      recordAttempt(ip);
      log.warn("Invalid invite page visit", { token: token.substring(0, 9) + "..." });
      return c.html(invalidTokenPage(), 404, securityHeaders());
    }

    const proto = c.req.header("x-forwarded-proto") || "http";
    const host = c.req.header("host") || "localhost:3000";
    const baseUrl = `${proto}://${host}`;

    log.info("Invite page served", { token: token.substring(0, 9) + "..." });
    return c.html(invitePage(token, wsUrl, baseUrl, peek.expiresAt), 200, securityHeaders());
  });

  // ----------------------------------------
  // GET /invite/:token/install
  // PowerShell bootstrap script — user runs: irm <url> | iex
  // ----------------------------------------
  app.get("/invite/:token/install", (c) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    if (isRateLimited(ip)) {
      return c.text('Write-Host "  [X] Too many attempts. Try again later." -ForegroundColor Red\n', 429);
    }

    const token = c.req.param("token");
    if (!TOKEN_FORMAT.test(token)) {
      recordAttempt(ip);
      return c.text('Write-Host "  [X] Invalid invite token format." -ForegroundColor Red\n', 404);
    }

    const peek = peekToken(token);
    if (!peek.valid) {
      recordAttempt(ip);
      return c.text(
        'Write-Host "  [X] This invite token is invalid or expired." -ForegroundColor Red\nWrite-Host "  Ask your admin for a new invite link." -ForegroundColor Gray\n',
        404
      );
    }

    const script = bootstrapScript(wsUrl, token, repoUrl);
    return c.text(script, 200, { "Content-Type": "text/plain; charset=utf-8" });
  });
}

// ============================================
// BOOTSTRAP SCRIPT
// ============================================

function bootstrapScript(wsUrl: string, token: string, repoUrl: string): string {
  return `#Requires -Version 5.1
# DotBot Bootstrap — auto-generated install script
# This downloads the full installer and runs it with your server details pre-filled.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$installScript = Join-Path $env:TEMP "dotbot-install.ps1"

Write-Host ""
Write-Host "  =====================================================" -ForegroundColor Cyan
Write-Host "      DotBot Installer Bootstrap                        " -ForegroundColor Cyan
Write-Host "  =====================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Downloading installer..." -ForegroundColor Gray

try {
    # Download the full installer from the repository
    $rawUrl = "${repoUrl}" -replace '\\.git$','' -replace 'github\\.com','raw.githubusercontent.com'
    $rawUrl = "$rawUrl/main/install.ps1"
    Invoke-WebRequest -Uri $rawUrl -OutFile $installScript -UseBasicParsing
} catch {
    Write-Host "  [X] Failed to download installer: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Trying alternate URL..." -ForegroundColor Yellow
    try {
        $altUrl = "${repoUrl}" -replace '\\.git$',''
        $altUrl = "$altUrl/raw/main/install.ps1"
        Invoke-WebRequest -Uri $altUrl -OutFile $installScript -UseBasicParsing
    } catch {
        Write-Host "  [X] Download failed. Check your internet connection and try again." -ForegroundColor Red
        exit 1
    }
}

Write-Host "  [OK] Installer downloaded" -ForegroundColor Green
Write-Host "  Starting installation with pre-filled server details..." -ForegroundColor Gray
Write-Host ""

powershell -ExecutionPolicy Bypass -File $installScript -Mode agent -ServerUrl "${wsUrl}" -InviteToken "${token}" -RepoUrl "${repoUrl}"
`;
}

// ============================================
// HTML TEMPLATES
// ============================================

function invitePage(token: string, wsUrl: string, baseUrl: string, expiresAt?: string): string {
  const installUrl = `${baseUrl}/invite/${token}/install`;
  const oneLiner = `irm '${installUrl}' | iex`;
  const expiryStr = expiresAt ? new Date(expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Unknown";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Install DotBot</title>
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
      padding: 20px;
    }
    .card {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 16px;
      padding: 48px;
      max-width: 640px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .logo {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo span {
      font-size: 36px;
      font-weight: 700;
      background: linear-gradient(135deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .logo .sub {
      display: block;
      font-size: 14px;
      color: #888;
      margin-top: 4px;
      -webkit-text-fill-color: #888;
      background: none;
    }
    .badge {
      display: inline-block;
      background: #1e3a2f;
      color: #4ade80;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 20px;
      margin-top: 12px;
      letter-spacing: 0.5px;
    }
    .steps {
      margin: 24px 0;
    }
    .step {
      display: flex;
      gap: 16px;
      margin-bottom: 24px;
    }
    .step-num {
      flex-shrink: 0;
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
      color: white;
    }
    .step-content h3 {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 6px;
      color: #e0e0e0;
    }
    .step-content p {
      font-size: 13px;
      color: #999;
      line-height: 1.5;
    }
    .cmd-box {
      position: relative;
      background: #0f0f23;
      border: 1px solid #333366;
      border-radius: 8px;
      padding: 16px 48px 16px 16px;
      margin-top: 8px;
      font-family: 'Consolas', 'Fira Code', 'Courier New', monospace;
      font-size: 13px;
      color: #a78bfa;
      word-break: break-all;
      line-height: 1.6;
      cursor: text;
      user-select: all;
    }
    .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: #2a2a4a;
      border: 1px solid #444;
      border-radius: 6px;
      padding: 6px 12px;
      color: #ccc;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .copy-btn:hover { background: #3a3a5a; color: #fff; }
    .copy-btn.copied { background: #1e3a2f; color: #4ade80; border-color: #4ade80; }
    .info-bar {
      display: flex;
      justify-content: space-between;
      margin-top: 24px;
      padding: 12px 16px;
      background: #16162b;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      font-size: 12px;
      color: #777;
    }
    .info-bar strong { color: #999; }
    .security-note {
      margin-top: 20px;
      padding: 12px 16px;
      background: #1e1e3a;
      border-radius: 8px;
      font-size: 12px;
      color: #777;
      line-height: 1.5;
    }
    .security-note strong { color: #4ade80; }
    .alt-section {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid #2a2a4a;
    }
    .alt-section h4 {
      font-size: 13px;
      color: #888;
      margin-bottom: 12px;
    }
    .manual-steps {
      font-size: 13px;
      color: #777;
      line-height: 1.8;
    }
    .manual-steps code {
      background: #0f0f23;
      padding: 2px 8px;
      border-radius: 4px;
      font-family: 'Consolas', 'Fira Code', monospace;
      color: #a78bfa;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <span>DotBot</span>
      <span class="sub">Your AI assistant, installed in minutes</span>
      <div class="badge">INVITE</div>
    </div>

    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-content">
          <h3>Open PowerShell as Administrator</h3>
          <p>Right-click the Start menu and select <strong>"Windows Terminal (Admin)"</strong> or <strong>"PowerShell (Admin)"</strong></p>
        </div>
      </div>

      <div class="step">
        <div class="step-num">2</div>
        <div class="step-content">
          <h3>Paste this command and press Enter</h3>
          <p>This downloads and runs the installer with your server details pre-filled.</p>
          <div class="cmd-box" id="cmdBox">
            ${esc(oneLiner)}
            <button class="copy-btn" id="copyBtn" type="button">Copy</button>
          </div>
        </div>
      </div>

      <div class="step">
        <div class="step-num">3</div>
        <div class="step-content">
          <h3>Follow the on-screen prompts</h3>
          <p>The installer handles Git, Node.js, and all dependencies automatically. Takes 2-5 minutes on most machines.</p>
        </div>
      </div>
    </div>

    <div class="info-bar">
      <span><strong>Server:</strong> ${esc(wsUrl)}</span>
      <span><strong>Expires:</strong> ${esc(expiryStr)}</span>
    </div>

    <div class="security-note">
      <strong>🔒 Security:</strong> This invite token is single-use. Once your device registers,
      the token is consumed and this link stops working. The token is never stored in the installer —
      it's used once during registration and then discarded.
    </div>

    <div class="alt-section">
      <h4>Manual installation (advanced)</h4>
      <div class="manual-steps">
        Clone the repo, build, and configure manually:<br>
        Server URL: <code>${esc(wsUrl)}</code><br>
        Token: <code>${esc(token)}</code>
      </div>
    </div>
  </div>

  <script>
    const btn = document.getElementById('copyBtn');
    const box = document.getElementById('cmdBox');
    btn.addEventListener('click', function() {
      const cmd = box.textContent.replace('Copy', '').replace('Copied!', '').trim();
      navigator.clipboard.writeText(cmd).then(function() {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(function() {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      });
    });
  </script>
</body>
</html>`;
}

function invalidTokenPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invalid Invite</title>
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
    <h2>Invalid or Expired Invite</h2>
    <p>This invite link is no longer valid. It may have expired or already been used.<br><br>
    Ask your DotBot admin for a new invite link.</p>
  </div>
</body>
</html>`;
}
