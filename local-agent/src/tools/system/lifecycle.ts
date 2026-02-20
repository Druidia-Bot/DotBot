/**
 * System Tools — Lifecycle Management
 *
 * Handlers for restart, health_check, update, and version.
 */

import fs from "fs";
import { join, dirname } from "path";
import type { ToolExecResult } from "../_shared/types.js";
import { runPowershell } from "../_shared/powershell.js";
import { runPreRestartHook } from "../tool-executor.js";
import { AGENT_VERSION } from "../../core/config.js";

// ============================================
// CONSTANTS
// ============================================

const RESTART_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const RESTART_EXIT_CODE = 42;
const INSTALL_DIR = process.env.DOTBOT_INSTALL_DIR || "C:\\.bot";
const BOT_DIR = join(process.env.USERPROFILE || process.env.HOME || "", ".bot");
const LAST_RESTART_PATH = join(BOT_DIR, ".last-restart");
export const LAST_UPDATE_INFO_PATH = join(BOT_DIR, ".last-update-info");

// Health check definitions: [display name, PowerShell command]
const HEALTH_CHECKS: [string, string][] = [
  ["Node.js",          "node --version"],
  ["Git",              "git --version"],
  ["Python",           "python --version 2>&1"],
  ["Tesseract",        "tesseract --version 2>&1 | Select-Object -First 1"],
  ["~/.bot/ directory", `if (Test-Path (Join-Path $env:USERPROFILE '.bot')) { 'exists' } else { throw 'missing' }`],
  ["Memory system",    `if (Test-Path (Join-Path $env:USERPROFILE '.bot/memory/index.json')) { 'initialized' } else { 'not initialized' }`],
  ["Skills directory", `(Get-ChildItem (Join-Path $env:USERPROFILE '.bot/skills') -Directory).Count.ToString() + ' skills installed'`],
  ["Discord config",   `if ($env:DISCORD_BOT_TOKEN -or (Select-String -Path (Join-Path $env:USERPROFILE '.bot/.env') -Pattern 'DISCORD_BOT_TOKEN' -Quiet -ErrorAction SilentlyContinue)) { 'configured' } else { 'not configured' }`],
  ["Server connection", `'Connected to ' + $env:DOTBOT_SERVER`],
];

// ============================================
// RESTART
// ============================================

export async function handleRestart(args: Record<string, any>): Promise<ToolExecResult> {
  const reason = args.reason || "No reason provided";
  const userRequested = isUserRequestedRestart(args, reason);

  const cooldownResult = checkRestartCooldown(reason, userRequested);
  if (cooldownResult) return cooldownResult;

  stampRestartTime();

  console.log(`[System] Restart requested: ${reason}`);
  scheduleExit(500);
  return { success: true, output: `Restart initiated: ${reason}. The agent will restart momentarily.` };
}

// ============================================
// HEALTH CHECK
// ============================================

export async function handleHealthCheck(_args: Record<string, any>): Promise<ToolExecResult> {
  const results = await Promise.all(
    HEALTH_CHECKS.map(([name, cmd]) => runSingleCheck(name, cmd)),
  );

  const passed = results.filter(c => c.status === "pass").length;
  const failed = results.length - passed;
  const summary = results
    .map(c => `${c.status === "pass" ? "\u2713" : "\u2717"} ${c.name}: ${c.detail}`)
    .join("\n");

  return { success: true, output: `Health Check: ${passed} passed, ${failed} failed\n\n${summary}` };
}

// ============================================
// UPDATE
// ============================================

export async function handleUpdate(_args: Record<string, any>): Promise<ToolExecResult> {
  const safeDir = INSTALL_DIR.replace(/'/g, "''");

  try {
    await verifyGitRepo(safeDir);
    const beforeHash = await gitShortHash(safeDir);

    console.log("[Update] git pull...");
    await gitPull(safeDir);
    console.log("[Update] git pull done — building...");
    await buildAll(safeDir);
    console.log("[Update] build done");

    const afterHash = await gitShortHash(safeDir);
    const changes = await gitChangeLog(safeDir, beforeHash);

    const output = [
      `Update complete: ${beforeHash} → ${afterHash}`,
      changes ? `\nChanges:\n${changes}` : "",
    ].filter(Boolean).join("\n");

    // Save update info so Dot can announce she's back after restart
    try {
      const versionFile = join(INSTALL_DIR, "VERSION");
      const newVersion = fs.readFileSync(versionFile, "utf-8").trim();
      fs.writeFileSync(LAST_UPDATE_INFO_PATH, JSON.stringify({
        previousVersion: AGENT_VERSION,
        newVersion,
        beforeHash,
        afterHash,
        changes: changes || "",
        updatedAt: new Date().toISOString(),
      }), "utf-8");
    } catch { /* non-fatal — Dot just won't announce */ }

    scheduleExit(3000);
    return { success: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: "", error: `Update failed: ${msg}` };
  }
}

// ============================================
// VERSION
// ============================================

export async function handleVersion(_args: Record<string, any>): Promise<ToolExecResult> {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  // Compare in-memory version (from process start) against on-disk VERSION file
  let diskVersion = "unknown";
  const versionCandidates = [
    join(INSTALL_DIR, "VERSION"),
    join(dirname(dirname(dirname(process.argv[1] || ""))), "VERSION"),
  ];
  for (const p of versionCandidates) {
    try { diskVersion = fs.readFileSync(p, "utf-8").trim(); break; } catch {}
  }

  const versionMismatch = diskVersion !== "unknown" && diskVersion !== AGENT_VERSION;

  // Check build artifact freshness
  let buildAge = "unknown";
  const distDir = join(INSTALL_DIR, "local-agent", "dist");
  try {
    const stat = fs.statSync(distDir);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageMins = Math.floor(ageMs / 60_000);
    buildAge = ageMins < 60 ? `${ageMins}m ago` : `${Math.floor(ageMins / 60)}h ${ageMins % 60}m ago`;
  } catch {}

  const lines = [
    `Version (running): ${AGENT_VERSION}`,
    `Version (on disk): ${diskVersion}`,
    `Platform: ${process.platform}`,
    `Node.js: ${process.version}`,
    `Install: ${INSTALL_DIR}`,
    `Build artifacts: ${buildAge}`,
    `Uptime: ${hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}`,
    `PID: ${process.pid}`,
  ];

  if (versionMismatch) {
    lines.push(`\n⚠️ VERSION MISMATCH: running ${AGENT_VERSION} but disk says ${diskVersion}. A restart is needed to load the updated code.`);
  }

  return { success: true, output: lines.join("\n") };
}

// ============================================
// HELPERS — Restart
// ============================================

function checkRestartCooldown(reason: string, bypassCooldown: boolean): ToolExecResult | null {
  if (bypassCooldown) {
    console.log(`[System] Restart cooldown bypassed for explicit user request. Reason: ${reason}`);
    return null;
  }

  try {
    const stat = fs.statSync(LAST_RESTART_PATH);
    const elapsed = Date.now() - stat.mtimeMs;
    if (elapsed < RESTART_COOLDOWN_MS) {
      const remainSec = Math.ceil((RESTART_COOLDOWN_MS - elapsed) / 1000);
      console.log(`[System] Restart blocked — cooldown active (${remainSec}s remaining). Reason: ${reason}`);
      return {
        success: false,
        output: `Restart blocked: the agent restarted ${Math.round(elapsed / 1000)}s ago. `
          + `Cooldown is ${RESTART_COOLDOWN_MS / 1000}s. The system is already running — `
          + `do NOT restart again. If something isn't working, diagnose the issue instead.`,
      };
    }
  } catch { /* file doesn't exist = no recent restart */ }
  return null;
}

function isUserRequestedRestart(args: Record<string, any>, reason: string): boolean {
  if (args.force === true || args.user_initiated === true) return true;

  const normalized = String(reason || "").toLowerCase();
  return normalized.includes("user request")
    || normalized.includes("requested by user")
    || normalized.includes("user asked")
    || normalized.includes("per user request")
    || normalized.includes("explicit user request");
}

function stampRestartTime(): void {
  try {
    fs.mkdirSync(dirname(LAST_RESTART_PATH), { recursive: true });
    fs.writeFileSync(LAST_RESTART_PATH, new Date().toISOString(), "utf-8");
  } catch { /* non-fatal */ }
}

function scheduleExit(delayMs: number): void {
  setTimeout(async () => {
    try {
      console.log("[System] Cancelling server tasks before restart...");
      await runPreRestartHook();
    } catch (err) {
      console.error("[System] Pre-restart hook failed (proceeding with restart):", err);
    }
    console.log(`[System] Exiting with code ${RESTART_EXIT_CODE} (restart signal)...`);
    process.exit(RESTART_EXIT_CODE);
  }, delayMs);
}

// ============================================
// HELPERS — Health Check
// ============================================

async function runSingleCheck(
  name: string,
  cmd: string,
): Promise<{ name: string; status: string; detail: string }> {
  try {
    const r = await runPowershell(cmd, 10_000);
    return { name, status: r.success ? "pass" : "fail", detail: r.output.trim() || r.error || "" };
  } catch {
    return { name, status: "fail", detail: "check timed out" };
  }
}

// ============================================
// HELPERS — Update (git + build pipeline)
// ============================================

async function verifyGitRepo(safeDir: string): Promise<void> {
  const r = await runPowershell(`Test-Path (Join-Path '${safeDir}' '.git')`, 5_000);
  if (!r.output.trim().toLowerCase().includes("true")) {
    throw new Error(`No git repository found at ${INSTALL_DIR}. Update only works for git-installed DotBot.`);
  }
}

async function gitShortHash(safeDir: string): Promise<string> {
  const r = await runPowershell(`cd '${safeDir}'; git rev-parse --short HEAD`, 5_000);
  return r.output.trim();
}

async function gitPull(safeDir: string): Promise<void> {
  // git writes progress to stderr which PowerShell treats as NativeCommandError.
  // Use $ErrorActionPreference='SilentlyContinue' and check $LASTEXITCODE for git's actual exit code.
  const r = await runPowershell(
    `$ErrorActionPreference='SilentlyContinue'; cd '${safeDir}'; $out = git pull 2>&1 | Out-String; $ec = $LASTEXITCODE; Write-Output $out; exit $ec`,
    30_000,
  );
  if (!r.success) throw new Error(`git pull failed: ${r.error}`);
}

async function buildAll(safeDir: string): Promise<void> {
  const steps: [string, string, number][] = [
    ["npm install",              `cd '${safeDir}'; npm install 2>&1`,              120_000],
    ["shared/ build",            `cd '${safeDir}'; npm run build -w shared 2>&1`,   60_000],
    ["local-agent/ build",       `cd '${safeDir}'; npm run build -w local-agent 2>&1`, 60_000],
  ];
  for (const [label, cmd, timeout] of steps) {
    console.log(`[Update]   ${label}...`);
    const r = await runPowershell(cmd, timeout);
    if (!r.success) throw new Error(`${label} failed: ${r.error}`);
  }
}

async function gitChangeLog(safeDir: string, sinceHash: string): Promise<string> {
  const r = await runPowershell(`cd '${safeDir}'; git log --oneline ${sinceHash}..HEAD 2>&1`, 5_000);
  return r.output.trim();
}
