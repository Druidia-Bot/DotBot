/**
 * Task Watchdog — External Monitor for Background Agent Tasks
 *
 * Scans running tasks on a 30s interval and escalates if stuck:
 *   Phase 1 (3min inactive): Nudge via injection
 *   Phase 2 (5min inactive): Abort + investigate via LLM
 *   Phase 3 (10min total + already investigated): Kill
 *
 * Blocked tasks are skipped — they're waiting for user input, not stuck.
 */

import { createComponentLogger } from "../logging.js";
import type { ILLMClient } from "../llm/providers.js";
import { LocalLLMClient, isLocalModelReady } from "../llm/local-llm.js";
import type { AgentTask } from "./agent-tasks.js";

const log = createComponentLogger("watchdog");

// Module-level LLM shared by watchdog investigator + blocked task evaluator
let watchdogLLM: ILLMClient | null = null;

// Cached local LLM client — reused across calls
let localLLMClient: ILLMClient | null = null;

/** Provide an LLM client for the watchdog and blocked-task evaluator. */
export function setWatchdogLLM(llm: ILLMClient): void {
  watchdogLLM = llm;
}

/** Get the watchdog LLM (cloud — used for investigator which needs more reasoning). */
export function getWatchdogLLM(): ILLMClient | null {
  return watchdogLLM;
}

/**
 * Get the best LLM for lightweight routing tasks (e.g. blocked task evaluation).
 * Prefers local model (fast, free, no network) → falls back to cloud watchdog LLM.
 */
export function getRouterLLM(): ILLMClient | null {
  if (isLocalModelReady()) {
    if (!localLLMClient) localLLMClient = new LocalLLMClient();
    return localLLMClient;
  }
  return watchdogLLM;
}

// Thresholds for the escalation ladder (milliseconds)
const SCAN_INTERVAL_MS = 30_000;    // Check every 30s
const NUDGE_INACTIVITY_MS = 180_000;  // 3min no activity → nudge
const ABORT_INACTIVITY_MS = 300_000;  // 5min no activity → abort + investigate
const KILL_TOTAL_MS = 600_000;        // 10min total task time → kill

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** Getter type — returns all tasks (the watchdog filters by status). */
export type TasksGetter = () => AgentTask[];

// Stored getter — set on first ensureWatchdog call
let getAllTasks: TasksGetter | null = null;

/** Start the watchdog if not already running. Auto-stops when no tasks remain. */
export function ensureWatchdog(getTasks?: TasksGetter): void {
  if (getTasks) getAllTasks = getTasks;
  if (watchdogTimer) return;

  log.info("Starting task watchdog (30s scan interval)");
  watchdogTimer = setInterval(scanTasks, SCAN_INTERVAL_MS);
  if (watchdogTimer.unref) watchdogTimer.unref();
}

/** Stop the watchdog when no tasks are running. */
function stopWatchdogIfIdle(): void {
  if (!watchdogTimer || !getAllTasks) return;

  const anyRunning = getAllTasks().some(t => t.status === "running");
  if (!anyRunning) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    log.info("Stopped task watchdog (no active tasks)");
  }
}

/** Scan all running tasks and escalate if stuck. */
function scanTasks(): void {
  if (!getAllTasks) return;
  const now = Date.now();
  const runningTasks = getAllTasks().filter(t => t.status === "running");

  if (runningTasks.length === 0) {
    stopWatchdogIfIdle();
    return;
  }

  for (const task of runningTasks) {
    const totalElapsed = now - task.startedAt;
    const inactivity = now - task.lastActivityAt;

    // Phase 3: Total time exceeded AND already investigated → kill
    if (totalElapsed > KILL_TOTAL_MS && task.watchdogPhase >= 2 && task.watchdogPhase < 3) {
      task.watchdogPhase = 3;
      log.warn(`Watchdog KILL: task ${task.id} ("${task.name}") exceeded ${KILL_TOTAL_MS / 60_000}min total`, {
        taskId: task.id, totalElapsedMs: totalElapsed, inactivityMs: inactivity,
      });
      task.injectionQueue.push(
        `⚠️ SYSTEM: You have been running for over ${Math.round(totalElapsed / 60_000)} minutes. ` +
        `STOP ALL WORK IMMEDIATELY. Summarize what you have completed and what remains, then end your response. ` +
        `Do NOT make any more tool calls.`
      );
      task.abortController.abort();
      continue;
    }

    // Phase 2: Extended inactivity after nudge → abort + investigate
    if (inactivity > ABORT_INACTIVITY_MS && task.watchdogPhase < 2) {
      task.watchdogPhase = 2;
      log.warn(`Watchdog ABORT: task ${task.id} ("${task.name}") inactive for ${Math.round(inactivity / 1000)}s`, {
        taskId: task.id, inactivityMs: inactivity, recentActivity: task.recentActivity.slice(-3),
      });

      runInvestigator(task).then(diagnosis => {
        task.injectionQueue.push(
          `⚠️ SYSTEM WATCHDOG — Your current operation was aborted because you appeared stuck (no progress for ${Math.round(inactivity / 1000)}s).\n\n` +
          `**Investigator diagnosis:**\n${diagnosis}\n\n` +
          `Adjust your approach based on this diagnosis. If a tool is failing, try a different approach or use manual alternatives. ` +
          `Do NOT repeat the same failing operation.`
        );
      }).catch(err => {
        log.error("Investigator failed", { taskId: task.id, error: err });
        task.injectionQueue.push(
          `⚠️ SYSTEM WATCHDOG — Your current operation was aborted because you appeared stuck (no progress for ${Math.round(inactivity / 1000)}s). ` +
          `Try a different approach. If a tool keeps failing, use manual alternatives.`
        );
      });

      task.abortController.abort();
      task.abortController = new AbortController();
      continue;
    }

    // Phase 1: Initial inactivity → nudge via injection
    if (inactivity > NUDGE_INACTIVITY_MS && task.watchdogPhase < 1) {
      task.watchdogPhase = 1;
      log.info(`Watchdog NUDGE: task ${task.id} ("${task.name}") inactive for ${Math.round(inactivity / 1000)}s`, {
        taskId: task.id, inactivityMs: inactivity,
      });
      task.injectionQueue.push(
        `⚠️ SYSTEM: You have been inactive for ${Math.round(inactivity / 1000)} seconds. ` +
        `Report your current status: what step are you on, what are you waiting for, and what remains? ` +
        `If you are stuck on a tool call, try an alternative approach.`
      );
    }
  }
}

/**
 * Lightweight investigator — single fast LLM call with the task's
 * recent activity to diagnose why it's stuck.
 */
async function runInvestigator(task: AgentTask): Promise<string> {
  if (!watchdogLLM) {
    return "No investigator LLM available. The task appeared to hang — try a different approach to complete your work.";
  }

  const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
  const inactivity = Math.round((Date.now() - task.lastActivityAt) / 1000);
  const activityLog = task.recentActivity.length > 0
    ? task.recentActivity.join("\n")
    : "(no recorded activity)";

  const response = await watchdogLLM.chat(
    [
      {
        role: "system",
        content: `You are a task investigator. A background agent task appears stuck. Analyze the evidence and provide a brief diagnosis (3-5 sentences) with a specific recommended action. Be direct and actionable.`,
      },
      {
        role: "user",
        content: `Task: "${task.name}" | Persona: ${task.personaId}\nPrompt: ${task.prompt.substring(0, 300)}\nRunning: ${elapsed}s (inactive last ${inactivity}s) | Phase: ${task.watchdogPhase}\n\nRecent activity:\n${activityLog}\n\nWhat happened and what should the agent do next?`,
      },
    ],
    { maxTokens: 300, temperature: 0 }
  );

  log.info(`Investigator diagnosis for task ${task.id}`, { diagnosis: response.content.substring(0, 200) });
  return response.content.trim();
}
