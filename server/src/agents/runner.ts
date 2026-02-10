/**
 * Agent Runner
 *
 * Thin orchestrator class that coordinates:
 * - Quick classification (for the WS orchestrator)
 * - Full pipeline execution (delegates to pipeline.ts)
 * - Recovery loop (retry with degradation on failure)
 *
 * Pipeline logic lives in pipeline.ts.
 * Task tracking lives in task-tracking.ts.
 * Types live in runner-types.ts.
 */

import { nanoid } from "nanoid";
import { getPersona } from "../personas/loader.js";
import { createClientForSelection, selectModel, type ILLMClient } from "../llm/providers.js";
import { createComponentLogger } from "../logging.js";
import type { EnhancedPromptRequest } from "../types/agent.js";
import { runReceptionist } from "./intake.js";
import { executeFullPipeline } from "./pipeline.js";
import { failTrackedTask } from "./task-tracking.js";
import {
  RunJournal,
  diagnoseError,
  buildFailureReport,
  buildRecoveryContext,
  type RecoveryDiagnosis,
} from "./self-recovery.js";

// Re-export types for backward compatibility — other modules import from here
export type { AgentRunnerOptions, AgentRunResult } from "./runner-types.js";
import type { AgentRunnerOptions, AgentRunResult } from "./runner-types.js";

const log = createComponentLogger("agents");

// ============================================
// AGENT RUNNER CLASS
// ============================================

export class AgentRunner {
  private llm: ILLMClient;
  private options: AgentRunnerOptions;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    // Use model selector + resilient client so the runner gets runtime fallback
    const modelConfig = selectModel({});
    this.llm = createClientForSelection(modelConfig);
  }

  // ============================================
  // QUICK CLASSIFICATION (for orchestrator)
  // ============================================

  /**
   * Run just the receptionist to classify the request.
   * Fast (~1-2s) — used by the orchestrator to decide whether
   * to spawn a background agent loop or handle inline.
   */
  async classify(
    request: EnhancedPromptRequest,
    userId: string
  ): Promise<import("../types/agent.js").ReceptionistDecision> {
    return runReceptionist(this.llm, this.options, request, userId);
  }

  /**
   * Run the full pipeline with a pre-computed receptionist decision.
   * Skips the receptionist call since it was already done by classify().
   * Accepts an optional injectionQueue that gets threaded into the tool loop.
   */
  async runWithDecision(
    request: EnhancedPromptRequest,
    userId: string,
    decision: import("../types/agent.js").ReceptionistDecision,
    injectionQueue?: string[],
    getAbortSignal?: () => AbortSignal | undefined
  ): Promise<AgentRunResult> {
    const sessionId = `session_${nanoid(12)}`;
    const journal = new RunJournal();
    let trackedTaskId: string | undefined;

    journal.log("start", "Agent run started (with pre-computed decision)", {
      prompt: request.prompt.substring(0, 100),
      classification: decision.classification,
      persona: decision.personaId,
    });

    try {
      journal.log("pipeline", "Executing full pipeline (decision pre-computed)");
      const result = await executeFullPipeline(
        this.llm, this.options, request, userId, sessionId, journal,
        (id) => { trackedTaskId = id; },
        decision,
        injectionQueue,
        getAbortSignal
      );
      result.runLog = journal.toJSON();
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      journal.logError("pipeline", err);
      const diagnosis = diagnoseError(err, journal);

      // Clean up orphaned tracked task so its timer doesn't run forever
      if (trackedTaskId) {
        failTrackedTask(this.options, trackedTaskId, err.message);
      }

      return {
        success: false,
        response: buildFailureReport(journal, diagnosis, request.prompt, 0),
        classification: decision.classification,
        threadIds: [],
        keyPoints: [],
        error: err.message,
        runLog: journal.toJSON(),
      };
    }
  }

  // ============================================
  // MAIN ENTRY POINT — RECOVERY LOOP
  // ============================================

  /** Max recovery attempts before giving up */
  private static readonly MAX_RECOVERY_ATTEMPTS = 2;

  /**
   * Main entry point - process an enhanced prompt request.
   * 
   * Wraps execution in a recovery loop:
   * 1. Try normal pipeline (receptionist → persona → tools → council)
   * 2. On failure, diagnose error and attempt recovery
   * 3. Recovery may retry with simplified pipeline or degrade gracefully
   * 4. If all recovery fails, return detailed failure report (never generic)
   */
  async run(
    request: EnhancedPromptRequest,
    userId: string
  ): Promise<AgentRunResult> {
    const sessionId = `session_${nanoid(12)}`;
    const journal = new RunJournal();

    journal.log("start", "Agent run started", {
      prompt: request.prompt.substring(0, 100),
      hasAgent: !!request.threadIndex.threads.length || !!request.memoryIndex?.length,
    });

    log.info("Starting agent run", {
      userId,
      sessionId,
      prompt: request.prompt.substring(0, 100),
    });

    let taskId: string | undefined;
    let lastDiagnosis: RecoveryDiagnosis | undefined;
    let recoveryAttempts = 0;

    // ---- Attempt 1: Full pipeline ----
    try {
      journal.log("pipeline", "Executing full pipeline");
      const result = await executeFullPipeline(
        this.llm, this.options, request, userId, sessionId, journal,
        (id) => { taskId = id; }
      );
      result.runLog = journal.toJSON();
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      journal.logError("pipeline", err);
      lastDiagnosis = diagnoseError(err, journal);

      log.warn("Full pipeline failed — entering recovery", {
        category: lastDiagnosis.category,
        strategy: lastDiagnosis.strategy,
        error: err.message,
      });

      // Non-recoverable errors: don't retry
      if (!lastDiagnosis.recoverable) {
        failTrackedTask(this.options, taskId, err.message);
        return {
          success: false,
          response: buildFailureReport(journal, lastDiagnosis, request.prompt, 0),
          classification: "ACTION",
          threadIds: [],
          keyPoints: [],
          taskId,
          error: err.message,
          runLog: journal.toJSON(),
        };
      }
    }

    // ---- Recovery attempts ----
    while (recoveryAttempts < AgentRunner.MAX_RECOVERY_ATTEMPTS && lastDiagnosis) {
      recoveryAttempts++;
      journal.log("recovery", `Recovery attempt ${recoveryAttempts}`, {
        strategy: lastDiagnosis.strategy,
        category: lastDiagnosis.category,
      });

      // Delay if the strategy calls for it (e.g. rate limit backoff)
      if (lastDiagnosis.delayMs > 0) {
        journal.log("recovery", `Waiting ${lastDiagnosis.delayMs}ms before retry`);
        await new Promise(resolve => setTimeout(resolve, lastDiagnosis!.delayMs));
      }

      try {
        const result = await this.executeRecoveryStrategy(
          request, userId, journal, lastDiagnosis, taskId
        );
        // Recovery succeeded
        journal.log("recovery", "Recovery succeeded", { strategy: lastDiagnosis.strategy });
        result.runLog = journal.toJSON();
        return result;
      } catch (recoveryError) {
        const err = recoveryError instanceof Error ? recoveryError : new Error(String(recoveryError));
        journal.logError("recovery", err, { attempt: recoveryAttempts });
        lastDiagnosis = diagnoseError(err, journal);

        log.warn(`Recovery attempt ${recoveryAttempts} failed`, {
          category: lastDiagnosis.category,
          error: err.message,
        });

        if (!lastDiagnosis.recoverable) break;
      }
    }

    // ---- All recovery failed ----
    failTrackedTask(this.options, taskId, journal.getLastError() || "All recovery attempts failed");

    const failureReport = buildFailureReport(
      journal,
      lastDiagnosis || { category: "unknown", recoverable: false, strategy: "give_up", delayMs: 0, userHint: "Unknown failure", technicalDetail: "No diagnosis available" },
      request.prompt,
      recoveryAttempts
    );

    log.error("All recovery attempts exhausted", {
      attempts: recoveryAttempts,
      elapsed: journal.getElapsedMs(),
      errors: journal.getErrors().map(e => e.error),
    });

    return {
      success: false,
      response: failureReport,
      classification: "ACTION",
      threadIds: [],
      keyPoints: [],
      taskId,
      error: journal.getLastError() || "All recovery attempts failed",
      runLog: journal.toJSON(),
    };
  }

  // ============================================
  // RECOVERY STRATEGIES
  // ============================================

  /**
   * Execute a recovery strategy based on the diagnosis.
   */
  private async executeRecoveryStrategy(
    request: EnhancedPromptRequest,
    userId: string,
    journal: RunJournal,
    diagnosis: RecoveryDiagnosis,
    taskId: string | undefined
  ): Promise<AgentRunResult> {
    switch (diagnosis.strategy) {
      case "retry_after_delay":
        journal.log("recovery", "Retrying full pipeline after delay");
        return executeFullPipeline(
          this.llm, this.options, request, userId, `recovery_${nanoid(8)}`, journal,
          () => {} // don't reassign taskId during recovery
        );

      case "retry_simple":
        journal.log("recovery", "Retrying with simplified pipeline (writer, no tools)");
        return this.executeSimpleRecovery(request, journal, diagnosis);

      case "degrade_no_tools":
        journal.log("recovery", "Degrading to conversational mode (no tools)");
        return this.executeSimpleRecovery(request, journal, diagnosis);

      case "fallback_direct":
        journal.log("recovery", "Using direct fallback response");
        return {
          success: true,
          response: `I'm having some technical difficulties right now. ${diagnosis.userHint} Please try again in a moment.`,
          classification: "CONVERSATIONAL",
          threadIds: [],
          keyPoints: [],
        };

      case "give_up":
      default:
        throw new Error(`Non-recoverable: ${diagnosis.technicalDetail}`);
    }
  }

  /**
   * Simplified recovery: skip receptionist, use writer persona directly,
   * inject journal as context so the LLM knows what happened.
   */
  private async executeSimpleRecovery(
    request: EnhancedPromptRequest,
    journal: RunJournal,
    diagnosis: RecoveryDiagnosis
  ): Promise<AgentRunResult> {
    const recoveryContext = buildRecoveryContext(journal, diagnosis);

    const writer = getPersona("writer");
    const systemPrompt = recoveryContext + (writer?.systemPrompt
      ? `\n\n## Your Base Persona\n${writer.systemPrompt}`
      : "");

    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: request.prompt },
    ];

    // Debug callback
    this.options.onLLMRequest?.({
      persona: "recovery",
      provider: this.options.provider || "deepseek",
      model: "deepseek-chat",
      promptLength: messages.reduce((acc, m) => acc + m.content.length, 0),
      maxTokens: 500,
      messages,
    });

    const startTime = Date.now();
    const response = await this.llm.chat(messages, {
      maxTokens: 500,
      temperature: 0.7,
    });

    this.options.onLLMResponse?.({
      persona: "recovery",
      duration: Date.now() - startTime,
      responseLength: response.content.length,
      response: response.content,
    });

    journal.log("recovery", "Simple recovery LLM call succeeded", {
      responseLength: response.content.length,
    });

    return {
      success: true,
      response: response.content,
      classification: "CONVERSATIONAL",
      threadIds: [],
      keyPoints: [],
    };
  }
}
