/**
 * Self-Recovery System
 * 
 * Gives the agent self-awareness about its own execution state and the
 * ability to recover from failures automatically.
 * 
 * Components:
 * - RunJournal: Event log that accumulates during a run
 * - diagnoseError: Pattern-matches errors to recovery strategies
 * - attemptRecovery: Executes recovery with full journal context
 * - buildFailureReport: Human-readable explanation when all recovery fails
 * 
 * Recovery flow:
 * 1. Normal execution fails → error caught
 * 2. Journal contains full trace of what happened
 * 3. diagnoseError categorizes the failure
 * 4. Recovery strategy executed (retry simple, degrade, fallback)
 * 5. If recovery needs LLM, journal is injected as context
 * 6. If all recovery fails, user gets detailed report (never generic)
 */

import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("self-recovery");

// ============================================
// RUN JOURNAL
// ============================================

export interface JournalEntry {
  timestamp: number;
  phase: string;
  event: string;
  details?: Record<string, any>;
  error?: string;
}

/**
 * Accumulates events during a single agent run.
 * Lightweight — just pushes to an array. No I/O.
 */
export class RunJournal {
  private entries: JournalEntry[] = [];
  private startTime: number = Date.now();

  log(phase: string, event: string, details?: Record<string, any>): void {
    this.entries.push({ timestamp: Date.now(), phase, event, details });
  }

  logError(phase: string, error: Error | string, details?: Record<string, any>): void {
    const msg = error instanceof Error ? error.message : error;
    this.entries.push({
      timestamp: Date.now(),
      phase,
      event: "ERROR",
      error: msg,
      details,
    });
    log.warn(`Journal error [${phase}]`, { error: msg, details });
  }

  /** Compact string for injecting into LLM recovery prompts */
  toContextString(): string {
    if (this.entries.length === 0) return "(no journal entries)";

    return this.entries.map(e => {
      const elapsed = e.timestamp - this.startTime;
      const prefix = `[+${elapsed}ms][${e.phase}]`;
      const err = e.error ? ` ERROR: ${e.error}` : "";
      const det = e.details ? ` ${JSON.stringify(e.details)}` : "";
      return `${prefix} ${e.event}${err}${det}`;
    }).join("\n");
  }

  /** Get just the error entries */
  getErrors(): JournalEntry[] {
    return this.entries.filter(e => e.error);
  }

  hasErrors(): boolean {
    return this.entries.some(e => e.error);
  }

  /** Get the last error message */
  getLastError(): string | undefined {
    const errors = this.getErrors();
    return errors.length > 0 ? errors[errors.length - 1].error : undefined;
  }

  /** Total elapsed time */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /** How many entries */
  get length(): number {
    return this.entries.length;
  }

  /** Serialize the full journal for persistence / transmission */
  toJSON(): { startTime: number; elapsedMs: number; entries: JournalEntry[] } {
    return {
      startTime: this.startTime,
      elapsedMs: this.getElapsedMs(),
      entries: [...this.entries],
    };
  }
}

// ============================================
// ERROR DIAGNOSIS
// ============================================

export type ErrorCategory =
  | "llm_rate_limit"
  | "llm_auth"
  | "llm_error"
  | "llm_parse_failure"
  | "agent_disconnected"
  | "persona_missing"
  | "tool_failure"
  | "timeout"
  | "unknown";

export type RecoveryStrategyType =
  | "retry_simple"          // Skip receptionist, use writer persona, no tools
  | "retry_after_delay"     // Wait briefly, then retry full pipeline
  | "degrade_no_tools"      // Respond conversationally without tool access
  | "fallback_direct"       // Return a direct response without any LLM call
  | "give_up";              // Not recoverable — report to user

export interface RecoveryDiagnosis {
  category: ErrorCategory;
  recoverable: boolean;
  strategy: RecoveryStrategyType;
  delayMs: number;
  userHint: string;          // Short hint for the user about what happened
  technicalDetail: string;   // Full error for logging
}

/**
 * Diagnose an error using pattern matching. No LLM call needed — this must
 * be reliable even when the LLM is down.
 */
export function diagnoseError(error: Error | string, journal: RunJournal): RecoveryDiagnosis {
  const msg = (error instanceof Error ? error.message : error).toLowerCase();
  const fullMsg = error instanceof Error ? error.message : error;

  // --- LLM Rate Limit ---
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
    return {
      category: "llm_rate_limit",
      recoverable: true,
      strategy: "retry_after_delay",
      delayMs: 3000,
      userHint: "The AI service is temporarily rate-limited. Retrying shortly.",
      technicalDetail: fullMsg,
    };
  }

  // --- LLM Auth ---
  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("invalid api key")) {
    return {
      category: "llm_auth",
      recoverable: false,
      strategy: "give_up",
      delayMs: 0,
      userHint: "The AI service rejected the API key. Check your .env configuration.",
      technicalDetail: fullMsg,
    };
  }

  // --- LLM 400: corrupted message sequence (tool_calls without tool results) ---
  if (msg.includes("400") && (msg.includes("tool_call") || msg.includes("tool messages"))) {
    return {
      category: "llm_parse_failure",
      recoverable: true,
      strategy: "retry_simple",
      delayMs: 0,
      userHint: "Hit a message formatting issue. Retrying with a fresh approach.",
      technicalDetail: fullMsg,
    };
  }

  // --- LLM general error (500, network, etc.) ---
  if (msg.includes("api error") || msg.includes("fetch failed") || msg.includes("econnrefused") ||
      msg.includes("enotfound") || msg.includes("network") || msg.includes("500") ||
      msg.includes("502") || msg.includes("503") || msg.includes("504")) {
    return {
      category: "llm_error",
      recoverable: true,
      strategy: "retry_after_delay",
      delayMs: 2000,
      userHint: "The AI service returned an error. Retrying with a simpler approach.",
      technicalDetail: fullMsg,
    };
  }

  // --- Receptionist parse failure ---
  if (msg.includes("no json found") || msg.includes("failed to parse")) {
    return {
      category: "llm_parse_failure",
      recoverable: true,
      strategy: "retry_simple",
      delayMs: 0,
      userHint: "Had trouble understanding the routing. Trying a direct approach.",
      technicalDetail: fullMsg,
    };
  }

  // --- Local agent disconnected ---
  if (msg.includes("no local-agent") || msg.includes("not connected") || msg.includes("no device")) {
    return {
      category: "agent_disconnected",
      recoverable: true,
      strategy: "degrade_no_tools",
      delayMs: 0,
      userHint: "Local agent isn't connected — responding without tool access.",
      technicalDetail: fullMsg,
    };
  }

  // --- Persona not found / not loaded ---
  if ((msg.includes("persona") || msg.includes("not loaded")) && (msg.includes("not found") || msg.includes("not loaded"))) {
    return {
      category: "persona_missing",
      recoverable: true,
      strategy: "retry_simple",
      delayMs: 0,
      userHint: "Couldn't find the right specialist. Using a general assistant instead.",
      technicalDetail: fullMsg,
    };
  }

  // --- Timeout ---
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted")) {
    return {
      category: "timeout",
      recoverable: true,
      strategy: "retry_simple",
      delayMs: 1000,
      userHint: "The request timed out. Trying a faster approach.",
      technicalDetail: fullMsg,
    };
  }

  // --- Unknown ---
  return {
    category: "unknown",
    recoverable: true,
    strategy: "retry_simple",
    delayMs: 0,
    userHint: "Something unexpected happened. Trying a different approach.",
    technicalDetail: fullMsg,
  };
}

// ============================================
// FAILURE REPORT
// ============================================

/**
 * Build a detailed, user-friendly failure report. This replaces the generic
 * "I encountered an error processing your request." with actual context.
 */
export function buildFailureReport(
  journal: RunJournal,
  diagnosis: RecoveryDiagnosis,
  originalPrompt: string,
  recoveryAttempts: number
): string {
  const lines: string[] = [];

  lines.push("I wasn't able to process your request. Here's what happened:\n");

  // What went wrong
  lines.push(`**Issue:** ${diagnosis.userHint}`);

  // What was tried
  if (recoveryAttempts > 0) {
    lines.push(`**Recovery attempts:** ${recoveryAttempts} — all unsuccessful`);
  }

  // Technical detail (abbreviated)
  const techDetail = diagnosis.technicalDetail.length > 200
    ? diagnosis.technicalDetail.substring(0, 200) + "..."
    : diagnosis.technicalDetail;
  lines.push(`**Technical detail:** \`${techDetail}\``);

  // Actionable suggestions based on category
  lines.push("\n**What you can do:**");
  switch (diagnosis.category) {
    case "llm_rate_limit":
      lines.push("- Wait a moment and try again (rate limits reset quickly)");
      lines.push("- If this keeps happening, check your API plan limits");
      break;
    case "llm_auth":
      lines.push("- Check your API key in the server's .env file");
      lines.push("- Make sure the key is valid and has credits");
      break;
    case "llm_error":
      lines.push("- Try again in a few seconds");
      lines.push("- Check if your LLM provider is experiencing an outage");
      break;
    case "agent_disconnected":
      lines.push("- Start the local agent (run-dev.bat or `npm run dev` in local-agent/)");
      lines.push("- Check the agent console for connection errors");
      break;
    case "persona_missing":
      lines.push("- This is likely a server bug — try restarting the server");
      break;
    case "timeout":
      lines.push("- Try a simpler request");
      lines.push("- Check your internet connection");
      break;
    default:
      lines.push("- Try again — intermittent issues often resolve themselves");
      lines.push("- Check the server console for detailed error logs");
      break;
  }

  // Execution trace (compact)
  const errors = journal.getErrors();
  if (errors.length > 0) {
    lines.push("\n**Execution trace:**");
    for (const e of errors.slice(-5)) { // last 5 errors max
      lines.push(`- [${e.phase}] ${e.error}`);
    }
  }

  return lines.join("\n");
}

// ============================================
// RECOVERY CONTEXT FOR LLM
// ============================================

/**
 * Build a system prompt addition that gives the LLM awareness of what
 * happened in previous attempts. Used when retrying with a simpler pipeline.
 */
export function buildRecoveryContext(journal: RunJournal, diagnosis: RecoveryDiagnosis): string {
  return `
## Recovery Mode

You are responding in recovery mode because the normal processing pipeline failed.
Here is what happened:

ERROR: ${diagnosis.technicalDetail}
CATEGORY: ${diagnosis.category}
HINT: ${diagnosis.userHint}

EXECUTION LOG:
${journal.toContextString()}

INSTRUCTIONS:
- Respond directly and helpfully to the user's message
- Do NOT mention the error unless it affects your ability to answer
- If the user asked for something that requires tools (file operations, commands, etc.) and tools are unavailable, explain what you would do and suggest they try again when the local agent is connected
- Keep your response natural and conversational
- Do NOT return JSON — just respond with plain text
`.trim();
}
