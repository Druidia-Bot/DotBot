/**
 * Tool Loop — Generic Execution Engine
 *
 * The core iteration pattern shared by all agentic callers:
 * 1. Drain injection queue (user corrections from supervisor)
 * 2. Sanitize messages (DeepSeek/OpenAI quirks)
 * 3. Send messages + tools to LLM (abort-aware)
 * 4. LLM responds with tool calls → dispatch to handler registry
 * 5. Push results back as role:"tool" messages
 * 6. Check stuck/duplicate detection, inject warnings
 * 7. Repeat until: no tool calls, stopTool fires, force-escalation, or maxIterations
 * 8. On max iterations: run a synthesis pass (text-only) for a clean response
 *
 * All features are opt-in — simple callers just provide handlers + maxIterations.
 * Full callers (execution.ts) add streaming, abort, injection, stuck detection, etc.
 */

import { createComponentLogger } from "../logging.js";
import { unsanitizeToolName } from "../agents/tools.js";
import { sanitizeMessages } from "./sanitize.js";
import { abortableCall } from "./abort.js";
import { createStuckState, checkStuck, recordToolResult, getStuckWarning } from "./stuck-detection.js";
import type { LLMMessage, LLMRequestOptions, ToolCall } from "../llm/types.js";
import type { ToolLoopOptions, ToolLoopResult, ToolHandlerResult } from "./types.js";

const log = createComponentLogger("tool-loop");

/** Normalize handler return to ToolHandlerResult. */
function normalizeResult(raw: string | ToolHandlerResult): ToolHandlerResult {
  if (typeof raw === "string") return { content: raw };
  return raw;
}

export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const {
    client, model, maxTokens, messages, tools, handlers,
    maxIterations, temperature = 0.1, stopTool, context,
    personaId = "unknown",
  } = options;

  let stoppedByTool = false;
  let stopToolArgs: Record<string, any> | null = null;
  let finalContent = "";
  let escalated = false;
  let escalationReason: string | undefined;
  let neededToolCategories: string[] | undefined;
  let infrastructureDown = false;

  const toolCallsMade: ToolLoopResult["toolCallsMade"] = [];
  const stuckState = createStuckState();

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    log.info(`Tool loop iteration ${iteration}/${maxIterations}`, { personaId });

    // ── Drain injection queue (user corrections from supervisor) ──
    if (options.injectionQueue && options.injectionQueue.length > 0) {
      const injections = options.injectionQueue.splice(0);
      const injectionText = injections.join("\n\n");
      log.info(`Injecting ${injections.length} user message(s)`, { personaId });
      // Clear reasoning_content from previous assistant messages (DeepSeek requirement)
      for (const m of messages) {
        if (m.role === "assistant" && m.reasoning_content) {
          m.reasoning_content = undefined;
        }
      }
      messages.push({
        role: "user",
        content: `⚠️ USER UPDATE (apply this to your current task):\n${injectionText}\n\nAcknowledge this update and adjust your plan accordingly.`,
      });
    }

    // ── Check abort before LLM call ──
    const currentSignal = options.getAbortSignal?.();
    if (currentSignal?.aborted) {
      log.warn("Tool loop aborted before LLM call", { personaId, iteration });
      break;
    }

    // ── Sanitize messages (DeepSeek/OpenAI quirks) ──
    sanitizeMessages(messages);

    // ── Call LLM (abort-aware) ──
    const iterStartTime = Date.now();
    const llmOptions: LLMRequestOptions = {
      model,
      maxTokens,
      temperature,
      tools,
      ...options.extraLLMOptions,
    };

    const response = await abortableCall(
      () => client.chat(messages, llmOptions),
      currentSignal,
    );

    // ── Token tracking callback ──
    options.onLLMResponse?.({
      persona: personaId,
      duration: Date.now() - iterStartTime,
      responseLength: response.content?.length || 0,
      response: response.content || "",
      model: response.model,
      provider: response.provider,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    });

    const toolCalls: ToolCall[] = response.toolCalls || [];
    const textContent = response.content || "";
    finalContent = textContent;

    log.info(`LLM response (iteration ${iteration})`, {
      personaId,
      contentLength: textContent.length,
      toolCallCount: toolCalls.length,
      tools: toolCalls.map(c => unsanitizeToolName(c.function.name)),
    });

    // ── No tool calls → check skill nudge or exit ──
    if (toolCalls.length === 0) {
      if (options.skillMatched && iteration <= 2 && toolCallsMade.length === 0) {
        log.warn("Skill matched but LLM responded with text only — nudging to execute", { personaId });
        messages.push({ role: "assistant", content: textContent });
        messages.push({
          role: "user",
          content: "You have a skill with specific tool call instructions. Do NOT just describe what you would do — actually make the tool calls now. Start with the first tool call from the skill instructions.",
        });
        if (textContent && options.onStream) {
          options.onStream(personaId, textContent + "\n\n", false);
        }
        continue;
      }
      log.info(`Tool loop completed after ${iteration} iterations`, { personaId });
      break;
    }

    // ── Stream user-facing text while tools execute ──
    if (textContent && options.onStream) {
      options.onStream(personaId, textContent + "\n\n", false);
    }

    // ── Add assistant message with tool_calls to history ──
    messages.push({
      role: "assistant",
      content: textContent,
      tool_calls: toolCalls,
      reasoning_content: response.reasoningContent || undefined,
    });

    // ── Stuck + duplicate detection ──
    const stuckCheck = checkStuck(
      stuckState,
      toolCalls.map(c => ({
        name: unsanitizeToolName(c.function.name),
        arguments: c.function.arguments,
      })),
      personaId,
    );

    if (stuckCheck.forceEscalate) {
      escalated = true;
      escalationReason = stuckCheck.escalationReason;
      finalContent = stuckCheck.escalationResponse || finalContent;
      // Push placeholder tool results so message sequence stays valid
      for (const call of toolCalls) {
        messages.push({
          role: "tool",
          content: "Skipped — task force-escalated due to stuck detection",
          tool_call_id: call.id,
        });
      }
      break;
    }

    // ── Execute each tool call ──
    let batchBroken = false;

    for (let callIdx = 0; callIdx < toolCalls.length; callIdx++) {
      const call = toolCalls[callIdx];
      const toolId = unsanitizeToolName(call.function.name);

      let args: Record<string, any>;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = {};
        log.warn("Failed to parse tool arguments", { tool: toolId, personaId });
      }

      log.info(`Executing tool: ${toolId}`, { personaId, argKeys: Object.keys(args) });
      options.onToolCall?.(toolId, args);

      const handler = handlers.get(toolId);
      let handlerResult: ToolHandlerResult;
      let success: boolean;

      if (handler) {
        try {
          const raw = await handler(context, args);
          handlerResult = normalizeResult(raw);
          success = true;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          handlerResult = { content: `Error: ${errMsg}` };
          success = false;
          log.warn("Tool handler failed", { tool: toolId, personaId, error: errMsg });

          // Circuit breaker: infrastructure errors are unrecoverable
          const lower = errMsg.toLowerCase();
          if (lower.includes("no local-agent") || lower.includes("not connected") || lower.includes("no device")) {
            log.error("Infrastructure error — breaking tool loop", { personaId, error: errMsg });
            infrastructureDown = true;
          }
        }
      } else {
        handlerResult = { content: `Unknown tool: ${call.function.name}` };
        success = false;
        log.warn("No handler registered for tool", { tool: toolId, personaId });
      }

      // Track tool call + record result for stuck detection
      toolCallsMade.push({ tool: toolId, args, result: handlerResult.content, success });
      options.onToolResult?.(toolId, handlerResult.content, success);
      recordToolResult(stuckState, toolId, handlerResult.content, success);

      // Add tool result message
      const toolMsg: LLMMessage = {
        role: "tool",
        content: handlerResult.content,
        tool_call_id: call.id,
      };
      if (handlerResult.images) {
        toolMsg.images = handlerResult.images;
      }
      messages.push(toolMsg);

      // Check stopTool
      if (stopTool && toolId === stopTool) {
        stoppedByTool = true;
        stopToolArgs = args;
      }

      // Check if handler wants to break the batch (wait_for_user, escalate, etc.)
      if (handlerResult.breakBatch || infrastructureDown) {
        // Push placeholder results for remaining tool calls
        for (let i = callIdx + 1; i < toolCalls.length; i++) {
          messages.push({
            role: "tool",
            content: "Skipped — batch interrupted",
            tool_call_id: toolCalls[i].id,
          });
        }
        batchBroken = true;
        break;
      }
    }

    // ── Post-batch checks ──
    if (infrastructureDown) {
      finalContent = "I'm unable to execute any tools right now — the local agent is disconnected. " +
        "Please check that the local agent is running and connected, then try again.";
      break;
    }

    if (escalated || stoppedByTool) {
      break;
    }

    // Check for escalation flag set by handler via ctx.state
    if (context.state.escalated) {
      escalated = true;
      escalationReason = context.state.escalationReason;
      neededToolCategories = context.state.neededToolCategories;
      break;
    }

    // ── Inject stuck/duplicate warnings AFTER tool results ──
    const stuckWarning = getStuckWarning(stuckState, personaId);
    if (stuckWarning) {
      messages.push({ role: "user", content: stuckWarning });
    }
    if (stuckCheck.duplicates.length > 0 && !batchBroken) {
      messages.push({
        role: "user",
        content: `⚠️ WARNING: You already called ${stuckCheck.duplicates.join(", ")} with the same arguments before. Do NOT repeat the same tool call. Move on to the next step.`,
      });
    }
  }

  // ── Synthesis pass: max iterations hit without a final response ──
  if (!finalContent && !escalated && !infrastructureDown) {
    log.warn("Tool loop hit max iterations — running synthesis pass", { personaId, maxIterations });
    try {
      messages.push({
        role: "user",
        content: "Summarize what you have accomplished so far into a clear, helpful response for the user. List what is done and what remains. Do NOT mention any internal limits, iteration counts, or system constraints.",
      });
      sanitizeMessages(messages);
      const synthOptions: LLMRequestOptions = { model, maxTokens, temperature };
      const synthStartTime = Date.now();
      const synthResponse = await client.chat(messages, synthOptions);
      finalContent = synthResponse.content || "I completed several actions but couldn't generate a final summary.";
      log.info(`Synthesis pass produced ${finalContent.length} chars`, { personaId });

      options.onLLMResponse?.({
        persona: personaId,
        duration: Date.now() - synthStartTime,
        responseLength: finalContent.length,
        response: finalContent,
        model: synthResponse.model,
        provider: synthResponse.provider,
        inputTokens: synthResponse.usage?.inputTokens,
        outputTokens: synthResponse.usage?.outputTokens,
      });
    } catch (err) {
      log.error("Synthesis pass failed", { personaId, error: err });
      finalContent = "I completed several tool actions but ran into an issue generating the final summary.";
    }
  }

  // ── Build conversation log ──
  const conversationLog = messages.map(m => {
    const entry: { role: string; content: string; toolCalls?: any[] } = {
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    };
    if (m.tool_calls?.length) {
      entry.toolCalls = m.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      }));
    }
    return entry;
  });

  const iterations = Math.min(
    toolCallsMade.length > 0 ? maxIterations : 1,
    maxIterations,
  );

  return {
    iterations,
    stoppedByTool,
    finalContent,
    stopToolArgs,
    completed: !escalated && !infrastructureDown && toolCallsMade.length < maxIterations * 3,
    toolCallsMade,
    escalated: escalated || undefined,
    escalationReason,
    neededToolCategories,
    conversationLog,
  };
}
