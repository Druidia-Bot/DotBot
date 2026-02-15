/**
 * Stuck Detection
 *
 * Two-phase detection run each iteration of the tool loop:
 *
 * Phase 1 — PRE-EXECUTION (checkStuck):
 *   Tracks consecutive calls to the same tool with identical args.
 *   Detects duplicates across the entire loop. Returns force-escalate
 *   if the agent is hopelessly stuck (threshold 5).
 *
 * Phase 2 — POST-EXECUTION (recordToolResult):
 *   Records whether tool results were errors or empty. Consecutive
 *   failures on the same tool accelerate stuck detection — a tool
 *   that keeps returning errors is a stronger signal than just
 *   being called repeatedly.
 *
 * Warning generation (getStuckWarning):
 *   Called after execution to produce context-aware warnings that
 *   account for both call patterns and result patterns.
 */

import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("tool-loop.stuck");

const STUCK_WARNING_THRESHOLD = 3;
const STUCK_ESCALATE_THRESHOLD = 5;

// Result patterns that indicate a tool call was unproductive
const ERROR_PATTERNS = [
  "error:", "failed", "not found", "no results",
  "timed out", "timeout", "permission denied", "access denied",
  "404", "500", "unavailable", "does not exist",
];

// ── Types ───────────────────────────────────────────────────────────

export interface StuckState {
  /** How many times the same tool+args have been called consecutively */
  consecutiveCount: number;
  /** How many of those consecutive calls returned errors/empty results */
  consecutiveFailCount: number;
  lastToolId: string;
  lastToolArgs: string;
  /** All tool+args keys seen across the entire loop (for duplicate detection) */
  seenToolCalls: Set<string>;
}

export interface StuckCheckResult {
  /** Duplicate tool IDs detected in this batch (for loop warning) */
  duplicates: string[];
  /** True if the agent is hopelessly stuck and should be force-escalated */
  forceEscalate: boolean;
  /** Escalation reason if forceEscalate is true */
  escalationReason?: string;
  /** Canned response if force-escalated */
  escalationResponse?: string;
}

// ── State Factory ───────────────────────────────────────────────────

export function createStuckState(): StuckState {
  return {
    consecutiveCount: 0,
    consecutiveFailCount: 0,
    lastToolId: "",
    lastToolArgs: "",
    seenToolCalls: new Set(),
  };
}

// ── Phase 1: Pre-Execution Check ────────────────────────────────────

/**
 * Check for stuck/duplicate conditions BEFORE tool execution.
 * Updates consecutive call tracking and returns force-escalate if needed.
 */
export function checkStuck(
  state: StuckState,
  toolCalls: { name: string; arguments: string }[],
  personaId: string,
): StuckCheckResult {
  const result: StuckCheckResult = { duplicates: [], forceEscalate: false };

  // ── Duplicate detection (across entire loop) ──
  for (const call of toolCalls) {
    const key = `${call.name}:${call.arguments}`;
    if (state.seenToolCalls.has(key)) {
      result.duplicates.push(call.name);
    }
    state.seenToolCalls.add(key);
  }

  // ── Consecutive same-tool detection ──
  if (toolCalls.length === 1) {
    const currentToolId = toolCalls[0].name;
    const currentArgs = toolCalls[0].arguments;
    if (currentToolId === state.lastToolId && currentArgs === state.lastToolArgs) {
      state.consecutiveCount++;
    } else {
      state.consecutiveCount = 1;
      state.consecutiveFailCount = 0;
      state.lastToolId = currentToolId;
      state.lastToolArgs = currentArgs;
    }
  } else if (toolCalls.length > 1) {
    state.consecutiveCount = 0;
    state.consecutiveFailCount = 0;
    state.lastToolId = "";
    state.lastToolArgs = "";
  }

  // Force-escalate at hard threshold
  if (state.consecutiveCount >= STUCK_ESCALATE_THRESHOLD) {
    const { lastToolId, consecutiveCount, consecutiveFailCount } = state;
    const failNote = consecutiveFailCount > 0 ? ` (${consecutiveFailCount} returned errors)` : ``;

    log.warn(`Stuck detection: force-escalating after ${consecutiveCount} identical calls`, { personaId });
    result.forceEscalate = true;
    result.escalationReason =
      `Stuck: called ${lastToolId} ${consecutiveCount}x without progress${failNote}. Wrong tools for this task.`;
    result.escalationResponse =
      `I've been trying ${lastToolId} repeatedly without success. Let me get this re-routed to a better-equipped persona.`;
  }

  return result;
}

// ── Phase 2: Post-Execution Result Recording ────────────────────────

/**
 * Record the outcome of a tool call. Call this AFTER each tool executes.
 * Tracks whether the result looks like an error or empty response,
 * which strengthens the stuck signal.
 */
export function recordToolResult(
  state: StuckState,
  toolId: string,
  resultContent: string,
  success: boolean,
): void {
  // Only track results for the tool we're monitoring for consecutive calls
  if (toolId !== state.lastToolId) return;

  const looksLikeFailure = !success || isUnproductiveResult(resultContent);
  if (looksLikeFailure) {
    state.consecutiveFailCount++;
  }
}

/**
 * Check if a tool result looks unproductive (error, empty, no results).
 */
function isUnproductiveResult(content: string): boolean {
  if (!content || content.trim().length === 0) return true;
  if (content.trim().length < 10) return true;

  const lower = content.toLowerCase();
  return ERROR_PATTERNS.some(p => lower.includes(p));
}

// ── Warning Generation (called after execution) ─────────────────────

/**
 * Generate a warning message based on current stuck state.
 * Call this AFTER tool execution and result recording.
 * Returns undefined if no warning is needed.
 */
export function getStuckWarning(
  state: StuckState,
  personaId: string,
): string | undefined {
  const { consecutiveCount, consecutiveFailCount, lastToolId } = state;

  // Accelerate warning if the tool keeps failing — warn at 2 instead of 3
  const effectiveCount = consecutiveFailCount >= 2
    ? consecutiveCount + 1
    : consecutiveCount;

  if (effectiveCount < STUCK_WARNING_THRESHOLD) return undefined;

  // At threshold: first principles warning
  if (consecutiveCount === STUCK_WARNING_THRESHOLD || (consecutiveCount === 2 && consecutiveFailCount >= 2)) {
    const failNote = consecutiveFailCount > 0
      ? ` It has returned errors or empty results ${consecutiveFailCount} time(s).`
      : ``;

    log.warn(`Stuck detection: warning at ${consecutiveCount} calls`, {
      personaId, toolId: lastToolId, failCount: consecutiveFailCount,
    });

    return [
      `⚠️ STUCK DETECTION: You have called ${lastToolId} ${consecutiveCount} times in a row with identical arguments.${failNote}`,
      ``,
      `Stop. Go back to first principles:`,
      `- What are you actually trying to achieve?`,
      `- Why isn't ${lastToolId} giving you what you need?`,
      `- Is there a different tool that could solve this?', 
      '- Use tools.list_tools to see the full toolbox — there may be saved or registered tools outside your current category that can help.`,
      `- Could you use tools.save_tool to create a purpose-built tool for this?`,
      ``,
      `Think about the problem differently before making another tool call.`,
    ].join("\n");
  }

  // Past threshold but below escalate: press the creative angle
  if (consecutiveCount > STUCK_WARNING_THRESHOLD && consecutiveCount < STUCK_ESCALATE_THRESHOLD) {
    log.warn(`Stuck detection: escalation warning at ${consecutiveCount} calls`, {
      personaId, toolId: lastToolId, failCount: consecutiveFailCount,
    });

    return [
      `🚨 STILL STUCK: ${lastToolId} has been called ${consecutiveCount} times now. This approach is not working.`,
      ``,
      `You MUST try something different:`,
      `1. **Create a new tool** — use tools.save_tool to build exactly what you need`,
      `2. **Escalate** — call agent.escalate to get routed to a persona with the right tools`,
      `3. **Be creative** — combine existing tools in a new way, or break the problem into smaller parts`,
      ``,
      `Do NOT call ${lastToolId} with the same arguments again. The next call will trigger automatic termination and escalation to a new agent.`,
    ].join("\n");
  }

  return undefined;
}
