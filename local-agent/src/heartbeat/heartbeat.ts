/**
 * Heartbeat — Periodic Awareness Loop
 * 
 * Runs every 5 minutes when the system is idle. Reads the user's
 * ~/.bot/HEARTBEAT.md prompt and sends it verbatim to the server for
 * execution by the personal-assistant persona (with tool access).
 * The user writes natural-language instructions in that file — whatever
 * they write IS the prompt. Notifies the user only when something is
 * genuinely urgent.
 * 
 * Complements the sleep cycle (30 min deep consolidation) — the
 * heartbeat is a quick awareness scan, not deep research.
 * 
 * Response contract:
 * - HEARTBEAT_OK → nothing urgent, suppress notification
 * - Anything else → urgent alert, display to user
 */

import { nanoid } from "nanoid";
import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import type { HeartbeatResult } from "../types.js";

// ============================================
// CONFIGURATION
// ============================================

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const HEARTBEAT_OK = "HEARTBEAT_OK";
const HEARTBEAT_TIMEOUT_MS = 30_000;  // 30 seconds — if server doesn't respond, give up
const HEARTBEAT_MD_PATH = path.join(homedir(), ".bot", "HEARTBEAT.md");
const HEARTBEAT_LOG_PATH = path.join(homedir(), ".bot", "heartbeat-log.jsonl");
const MAX_LOG_ENTRIES = 500; // Trim log when it exceeds this

const DEFAULT_CHECKLIST = `# Heartbeat Checklist

## Always Check
- Check if any reminders are due now

## Urgent Criteria
Only notify me if:
- A reminder I explicitly set for this time
- A task I flagged as P0 is overdue

If nothing needs attention`;

// ============================================
// STATE
// ============================================

let sendToServer: ((message: any) => Promise<any>) | null = null;
let running = false;
let onAlert: ((content: string) => void) | null = null;
let onOk: ((content: string) => void) | null = null;
let consecutiveFailures = 0;
let lastHeartbeatAt = 0; // Timestamp of last heartbeat attempt (for backoff timing)
const MAX_BACKOFF_MS = 30 * 60 * 1000; // Cap backoff at 30 minutes
let fileWatcher: import("fs").FSWatcher | null = null;
let fileWatcherDebounce: NodeJS.Timeout | null = null;

interface HeartbeatConfig {
  intervalMs: number;
  activeHours?: { start: string; end: string };
  enabled: boolean;
}

let config: HeartbeatConfig = {
  intervalMs: DEFAULT_INTERVAL_MS,
  activeHours: undefined,
  enabled: true,
};

// ============================================
// LIFECYCLE
// ============================================

/**
 * Initialize heartbeat configuration and callbacks.
 * Does NOT start a timer — the periodic manager handles scheduling.
 * Call this once on startup before registering with the periodic manager.
 */
export function initHeartbeat(
  sender: (message: any) => Promise<any>,
  callbacks?: {
    onAlert?: (content: string) => void;
    onOk?: (content: string) => void;
  },
  overrides?: Partial<HeartbeatConfig>
): void {
  sendToServer = sender;
  consecutiveFailures = 0;
  lastHeartbeatAt = 0;
  onAlert = callbacks?.onAlert ?? null;
  onOk = callbacks?.onOk ?? null;
  config = {
    intervalMs: DEFAULT_INTERVAL_MS,
    activeHours: undefined,
    enabled: true,
    ...overrides,
  };

  // Watch HEARTBEAT.md for user edits (#10: file-watch feedback)
  startFileWatcher();
}

/**
 * Backward-compatible wrapper — calls initHeartbeat.
 * @deprecated Use initHeartbeat() + periodic manager instead.
 */
export function startHeartbeat(
  sender: (message: any) => Promise<any>,
  callbacks?: {
    onAlert?: (content: string) => void;
    onOk?: (content: string) => void;
  },
  overrides?: Partial<HeartbeatConfig>
): void {
  initHeartbeat(sender, callbacks, overrides);
}

export function stopHeartbeat(): void {
  stopFileWatcher();
  running = false;
  sendToServer = null;
  console.log("[Heartbeat] Stopped");
}

/**
 * @deprecated Use periodic manager's notifyActivity() instead.
 */
export function notifyHeartbeatActivity(): void {
  // No-op — idle tracking now lives in the periodic manager
}

/**
 * Returns true if the heartbeat is currently running a check.
 */
export function isHeartbeatRunning(): boolean {
  return running;
}

/**
 * Get the configured interval (ms) for the heartbeat.
 * Used by the periodic manager to set the task interval.
 */
export function getHeartbeatIntervalMs(): number {
  return config.intervalMs;
}

/**
 * Returns whether the heartbeat is enabled.
 */
export function isHeartbeatEnabled(): boolean {
  return config.enabled;
}

// ============================================
// HEARTBEAT EXECUTION (called by periodic manager)
// ============================================

/**
 * Gate function for the periodic manager.
 * Returns false if the heartbeat should be skipped this cycle.
 */
export function canRunHeartbeat(): boolean {
  if (!config.enabled) return false;
  if (running) return false;

  // Active hours check
  if (config.activeHours && !isWithinActiveHours(config.activeHours)) return false;

  // Backoff gate: on consecutive failures, skip runs to avoid hammering a struggling server
  if (consecutiveFailures > 0) {
    const backoffMs = Math.min(config.intervalMs * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MS);
    const timeSinceLastAttempt = Date.now() - lastHeartbeatAt;
    if (timeSinceLastAttempt < backoffMs) return false;
  }

  return true;
}

/**
 * Execute a single heartbeat check.
 * Called by the periodic manager — idle detection and overlap prevention
 * are handled by the manager, not here.
 * @param idleDurationMs — how long the system has been idle (from manager)
 */
export async function executeHeartbeat(idleDurationMs: number): Promise<void> {
  running = true;
  lastHeartbeatAt = Date.now();
  try {
    const success = await runHeartbeat(idleDurationMs);
    if (success) {
      if (consecutiveFailures > 0) {
        console.log(`[Heartbeat] Recovered after ${consecutiveFailures} consecutive failures`);
      }
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      const nextBackoff = Math.min(config.intervalMs * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MS);
      console.log(`[Heartbeat] Failure #${consecutiveFailures} — next attempt in ${Math.round(nextBackoff / 1000)}s`);
    }
  } catch (err) {
    consecutiveFailures++;
    const nextBackoff = Math.min(config.intervalMs * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MS);
    console.log(`[Heartbeat] Failure #${consecutiveFailures} — next attempt in ${Math.round(nextBackoff / 1000)}s`);
  } finally {
    running = false;
  }
}

async function runHeartbeat(idleDurationMs: number = 0): Promise<boolean> {
  if (!sendToServer) {
    console.log("[Heartbeat] No server connection — skipping");
    return false;
  }

  // Read the user's heartbeat checklist
  let checklist: string;
  try {
    checklist = await fs.readFile(HEARTBEAT_MD_PATH, "utf-8");
  } catch {
    // No HEARTBEAT.md — create default and use it
    try {
      await fs.mkdir(path.dirname(HEARTBEAT_MD_PATH), { recursive: true });
      await fs.writeFile(HEARTBEAT_MD_PATH, DEFAULT_CHECKLIST, "utf-8");
      console.log("[Heartbeat] Created default ~/.bot/HEARTBEAT.md");
    } catch { /* best effort */ }
    checklist = DEFAULT_CHECKLIST;
  }

  // Skip if checklist is effectively empty (only headings, no items)
  const stripped = checklist.replace(/^#.*$/gm, "").trim();
  if (!stripped) {
    console.log("[Heartbeat] HEARTBEAT.md is empty — skipping");
    return true; // Not a server failure — don't count toward backoff
  }

  // Append onboarding status if incomplete
  let onboardingSection = "";
  try {
    const onboardingPath = path.join(homedir(), ".bot", "onboarding.json");
    const raw = await fs.readFile(onboardingPath, "utf-8");
    const state = JSON.parse(raw);
    if (!state.completedAt) {
      const incomplete = Object.entries(state.steps)
        .filter(([, s]: [string, any]) => s.status === "pending" || s.status === "skipped")
        .map(([id, s]: [string, any]) => `  - ${id} (${s.status})`);
      if (incomplete.length > 0) {
        onboardingSection = `\n\n## Onboarding Status\nThe following onboarding steps are incomplete:\n${incomplete.join("\n")}\nIf the user seems idle, gently suggest completing one of these.`;
      }
    }
  } catch { /* no onboarding.json or parse error — skip */ }

  // Send heartbeat request to server with context (#6: context injection)
  const serverCall = sendToServer({
    type: "heartbeat_request",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      checklist: checklist + onboardingSection,
      currentTime: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      idleDurationMs,
      consecutiveFailures,
    },
  });

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), HEARTBEAT_TIMEOUT_MS)
  );

  const response = await Promise.race([serverCall, timeout]);

  if (response === null) {
    console.log("[Heartbeat] Server request timed out");
    await appendOutcomeLog({ status: "error", content: "timeout", checkedAt: new Date().toISOString(), durationMs: HEARTBEAT_TIMEOUT_MS, model: "none", toolsAvailable: false });
    return false;
  }

  // Structured response (#11): server sends { result: HeartbeatResult }
  const result: HeartbeatResult | undefined = response?.result;

  if (!result) {
    // Backward compat: if server sends old-style { content: string }
    if (response?.content) {
      const content = response.content.trim();
      if (!content) {
        console.log("[Heartbeat] Empty response from server");
        return false;
      }
      if (isHeartbeatOk(content)) {
        const remaining = content.replace(HEARTBEAT_OK, "").trim();
        console.log(`[Heartbeat] OK${remaining ? ` — ${remaining}` : ""}`);
        if (onOk) onOk(remaining || "nothing to report");
        return true;
      }
      console.log(`\n[Heartbeat Alert] ${content}`);
      if (onAlert) onAlert(content);
      return true;
    }
    console.log("[Heartbeat] No response from server");
    return false;
  }

  // Log outcome (#7: outcome history log)
  await appendOutcomeLog(result);

  if (result.status === "error") {
    console.log(`[Heartbeat] Server error: ${result.content}`);
    return false;
  }

  if (result.status === "ok") {
    const taskInfo = result.scheduledTasks?.due
      ? `, ${result.scheduledTasks.due} due task(s)`
      : "";
    console.log(`[Heartbeat] OK — ${result.content} (${result.durationMs}ms, ${result.model}${taskInfo})`);
    if (onOk) onOk(result.content);
    return true;
  }

  // status === "alert"
  console.log(`\n[Heartbeat Alert] ${result.content}`);
  if (onAlert) onAlert(result.content);
  return true;
}

// ============================================
// HELPERS
// ============================================

function isHeartbeatOk(content: string): boolean {
  return content.includes(HEARTBEAT_OK);
}

async function appendOutcomeLog(result: HeartbeatResult): Promise<void> {
  try {
    const entry = JSON.stringify({ ...result, loggedAt: new Date().toISOString() }) + "\n";
    await fs.appendFile(HEARTBEAT_LOG_PATH, entry, "utf-8");
  } catch {
    // Best effort — don't let logging failure break the heartbeat
  }
}

export async function trimOutcomeLog(): Promise<void> {
  try {
    const raw = await fs.readFile(HEARTBEAT_LOG_PATH, "utf-8");
    const lines = raw.trim().split("\n");
    if (lines.length > MAX_LOG_ENTRIES) {
      const trimmed = lines.slice(lines.length - MAX_LOG_ENTRIES).join("\n") + "\n";
      await fs.writeFile(HEARTBEAT_LOG_PATH, trimmed, "utf-8");
      console.log(`[Heartbeat] Trimmed log from ${lines.length} to ${MAX_LOG_ENTRIES} entries`);
    }
  } catch {
    // File doesn't exist yet — nothing to trim
  }
}

// ============================================
// FILE WATCHER (#10)
// ============================================

function startFileWatcher(): void {
  stopFileWatcher(); // Idempotent
  try {
    const { watch } = require("fs");
    fileWatcher = watch(HEARTBEAT_MD_PATH, () => {
      // Debounce: editors save multiple times in quick succession
      if (fileWatcherDebounce) clearTimeout(fileWatcherDebounce);
      fileWatcherDebounce = setTimeout(async () => {
        try {
          const content = await fs.readFile(HEARTBEAT_MD_PATH, "utf-8");
          const items = content.split("\n").filter(l => l.trim().startsWith("- ")).length;
          console.log(`[Heartbeat] Checklist updated — ${items} item${items !== 1 ? "s" : ""} detected`);
        } catch {
          console.log("[Heartbeat] Checklist file changed (could not read)");
        }
      }, 500);
    });
  } catch {
    // File doesn't exist yet or watch not supported — non-critical
  }
}

function stopFileWatcher(): void {
  if (fileWatcherDebounce) { clearTimeout(fileWatcherDebounce); fileWatcherDebounce = null; }
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

function isWithinActiveHours(hours: { start: string; end: string }): boolean {
  const now = new Date();
  const startParts = hours.start.split(":").map(Number);
  const endParts = hours.end.split(":").map(Number);

  // Validate format — if malformed, don't restrict (run always) and warn once
  if (startParts.some(isNaN) || endParts.some(isNaN) || startParts.length < 1 || endParts.length < 1) {
    console.warn("[Heartbeat] Invalid active hours format — expected HH:MM, got:", hours);
    return true;
  }

  const [startH, startM = 0] = startParts;
  const [endH, endM = 0] = endParts;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}
