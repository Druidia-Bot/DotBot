/**
 * Agentic Tool Loop — Native Function Calling
 * 
 * The core execution loop that makes personas actually DO things:
 * 1. Send task to LLM with tools as structured ToolDefinition[]
 * 2. LLM responds with content + toolCalls (native function calling)
 * 3. Execute tool calls via WebSocket → local-agent
 * 4. Feed results back as role:"tool" messages with tool_call_id
 * 5. Repeat until done (no tool calls) or max iterations
 * 
 * Uses the LLM provider's native tool calling API — no custom JSON format.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../logging.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, ToolCall } from "../llm/types.js";
import type { ExecutionCommand } from "../types.js";
import {
  generateToolPrompt,
  getSystemContext,
  manifestToNativeTools,
  unsanitizeToolName,
  type ToolManifestEntry,
} from "./tools.js";
import { resolveScreenshot } from "../gui/screenshot-store.js";

const log = createComponentLogger("tool-loop");

/** Max characters per tool result before truncation. */
const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * Defensive sanitizer: ensures every assistant message with tool_calls is
 * immediately followed by matching tool result messages. DeepSeek and OpenAI
 * return 400 if tool results are missing or out of order.
 *
 * Repairs in-place by injecting placeholder tool results where needed.
 */
function sanitizeMessages(messages: LLMMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;

    const expectedIds = new Set(msg.tool_calls.map(tc => tc.id));
    const foundIds = new Set<string>();

    // Scan the messages immediately following this assistant message
    for (let j = i + 1; j < messages.length && j <= i + msg.tool_calls.length; j++) {
      if (messages[j].role === "tool" && messages[j].tool_call_id) {
        foundIds.add(messages[j].tool_call_id!);
      } else {
        break; // Non-tool message breaks the sequence
      }
    }

    // Inject missing tool results right after the assistant message
    if (foundIds.size < expectedIds.size) {
      const missing = [...expectedIds].filter(id => !foundIds.has(id));
      log.warn(`sanitizeMessages: patching ${missing.length} missing tool results`, {
        assistantIdx: i,
        expectedCount: expectedIds.size,
        foundCount: foundIds.size,
      });
      const insertIdx = i + 1 + foundIds.size;
      const patches: LLMMessage[] = missing.map(id => ({
        role: "tool" as const,
        content: "(no result — tool execution was skipped)",
        tool_call_id: id,
      }));
      messages.splice(insertIdx, 0, ...patches);
    }
  }
}

/** Truncate oversized tool results to keep context manageable. */
function truncateResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  return (
    result.substring(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n...[truncated — original was ${result.length} chars. Summarize what you have.]`
  );
}

/**
 * Extract image from a tool result JSON.
 * 
 * Supports two paths:
 * 1. screenshot_ref — image uploaded via HTTP POST, resolved from in-memory store (fast path)
 * 2. image_base64 — inline base64 fallback if HTTP upload failed
 * 
 * Returns the image data and a compact text summary, or null if no image.
 */
function extractImageFromResult(result: string): {
  textContent: string;
  image: { base64: string; media_type: "image/jpeg" | "image/png" };
} | null {
  try {
    const parsed = JSON.parse(result);

    // Path 1: HTTP-uploaded screenshot (preferred — already binary, no base64 in WebSocket)
    if (parsed.screenshot_ref && typeof parsed.screenshot_ref === "string") {
      const resolved = resolveScreenshot(parsed.screenshot_ref);
      if (resolved) {
        const summary = { ...parsed };
        delete summary.screenshot_ref;
        summary._image_attached = true;
        return { textContent: JSON.stringify(summary), image: resolved };
      }
      log.warn(`Screenshot ref ${parsed.screenshot_ref} not found in store (expired?)`);
    }

    // Path 2: Inline base64 fallback
    if (parsed.image_base64 && typeof parsed.image_base64 === "string") {
      const imageData = parsed.image_base64;
      const mediaType: "image/jpeg" | "image/png" =
        parsed.format === "png" ? "image/png" : "image/jpeg";

      const summary = { ...parsed };
      delete summary.image_base64;
      summary._image_attached = true;

      return {
        textContent: JSON.stringify(summary),
        image: { base64: imageData, media_type: mediaType },
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================
// TYPES
// ============================================

export interface ToolLoopOptions {
  /** Max iterations of the tool loop */
  maxIterations: number;
  /** Callback to execute a command on the local agent */
  executeCommand: (command: ExecutionCommand) => Promise<string>;
  /** Dynamic tool manifest from local agent. If provided, uses plugin system. */
  toolManifest?: ToolManifestEntry[];
  /** Runtime environment info from local agent */
  runtimeInfo?: any[];
  /** Conversation history to inject between system and user messages */
  conversationHistory?: { role: "user" | "assistant"; content: string }[];
  /** Stream callback for real-time output */
  onStream?: (personaId: string, chunk: string, done: boolean) => void;
  /** Called when a tool is invoked */
  onToolCall?: (tool: string, args: Record<string, string>) => void;
  /** Called when a tool returns a result */
  onToolResult?: (tool: string, result: string, success: boolean) => void;
  /** Server-side premium tool executor (bypasses local agent) */
  executePremiumTool?: (toolId: string, args: Record<string, any>) => Promise<{ success: boolean; output: string; error?: string }>;
  /** Server-side image generation executor */
  executeImageGenTool?: (toolId: string, args: Record<string, any>, executeCommand: (cmd: ExecutionCommand) => Promise<string>) => Promise<{ success: boolean; output: string; error?: string }>;
  /** Server-side knowledge ingestion (Gemini Files API + processing) */
  executeKnowledgeIngest?: (toolId: string, args: Record<string, any>) => Promise<{ success: boolean; output: string; error?: string }>;
  /** Server-side schedule tool executor (recurring tasks in SQLite) */
  executeScheduleTool?: (toolId: string, args: Record<string, any>) => Promise<{ success: boolean; output: string; error?: string }>;
  /** Server-side research artifact tool (saves to agent workspace) */
  executeResearchTool?: (toolId: string, args: Record<string, any>, executeCommand: (cmd: ExecutionCommand) => Promise<string>) => Promise<{ success: boolean; output: string; error?: string }>;
  /** When true, a skill was injected into the user message. The tool loop will nudge
   *  the LLM to make tool calls if it tries to respond with text-only on early iterations.
   *  This prevents the "output plan and stop" failure mode. */
  skillMatched?: boolean;
  /** Shared injection queue — external code can push messages here (e.g. user corrections).
   *  The tool loop drains this at the start of each iteration. */
  injectionQueue?: string[];
  /** Callback for wait_for_user tool — marks task as blocked, returns a promise
   *  that resolves with the user's response when they send a message. */
  onWaitForUser?: (reason: string, resumeHint?: string, timeoutMs?: number) => Promise<string>;
  /** Getter for current AbortSignal — watchdog can abort the current blocking operation.
   *  Returns a fresh signal each call (allows controller replacement after abort+recovery).
   *  When signaled, the pending await rejects, catch block handles it,
   *  and the next iteration drains the injection queue. */
  getAbortSignal?: () => AbortSignal | undefined;

  /** Called after each LLM call with model/token info (for token tracking) */
  onLLMResponse?: (info: {
    persona: string;
    duration: number;
    responseLength: number;
    response: string;
    model?: string;
    provider?: string;
    inputTokens?: number;
    outputTokens?: number;
  }) => void;

  // V2: Agent protocol callbacks
  /** Called when agent requests additional tool categories at runtime */
  onRequestTools?: (toolCategories: string[]) => string[];
  /** Called when agent requests research delegation */
  onRequestResearch?: (query: string, depth: string, format: string) => Promise<string>;
}

export interface ToolLoopResult {
  /** The final user-facing response */
  response: string;
  /** Tool calls that were executed */
  toolCallsMade: { tool: string; args: Record<string, string>; result: string; success: boolean }[];
  /** Number of loop iterations used */
  iterations: number;
  /** Whether the loop completed normally (vs hitting max iterations) */
  completed: boolean;
  /** When true, the persona called agent.escalate or got stuck — needs re-routing through the planner */
  escalated?: boolean;
  /** Tool categories the persona said it needs (from agent.escalate or stuck detection) */
  neededToolCategories?: string[];
  /** Why the escalation happened */
  escalationReason?: string;
  /** V2: Whether research was requested during execution */
  researchRequested?: boolean;
}

// ============================================
// MAIN LOOP
// ============================================

/**
 * Run the agentic tool loop using native function calling.
 * 
 * Tools are passed structurally via the LLM's tools parameter.
 * The model returns toolCalls on its response; results go back as role:"tool" messages.
 */
export async function runToolLoop(
  llm: ILLMClient,
  systemPrompt: string,
  userMessage: string,
  personaId: string,
  llmOptions: LLMRequestOptions,
  options: ToolLoopOptions
): Promise<ToolLoopResult> {
  const systemContextBlock = getSystemContext(options.runtimeInfo);
  const usePluginRouting = !!(options.toolManifest && options.toolManifest.length > 0);

  // Behavioral guidance goes in system prompt; tool definitions go structurally
  const toolGuidance = generateToolPrompt();
  const fullSystemPrompt = `${systemPrompt}\n\n${systemContextBlock}\n${toolGuidance}`;

  // Convert manifest to native ToolDefinition[] for the LLM
  const nativeTools = manifestToNativeTools(options.toolManifest);

  // Inject agent.escalate as a synthetic tool — lets personas request re-routing
  // when they don't have the right tools for the task
  if (nativeTools) {
    nativeTools.push({
      type: "function" as const,
      function: {
        name: "agent__escalate",
        description: "Call this when you realize you don't have the right tools for this task. This will re-route the task to the planner, which will pick a persona with the correct tools. Do NOT keep trying the same failing approach — escalate instead.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Why you can't complete the task with your current tools (e.g., 'I need shell.powershell to run commands but only have knowledge and persona tools')",
            },
            needed_tools: {
              type: "string",
              description: "Comma-separated list of tool categories you think are needed (e.g., 'shell, filesystem, discord')",
            },
          },
          required: ["reason"],
        },
      },
    });
  }

  // Inject agent.wait_for_user as a synthetic tool when the callback is available
  if (options.onWaitForUser && nativeTools) {
    nativeTools.push({
      type: "function" as const,
      function: {
        name: "agent__wait_for_user",
        description: "Pause execution and wait for the user to respond. Use this when you need information or action from the user before you can continue (e.g., they need to create an account, enter credentials, make a choice). The task will be suspended and automatically resume when the user sends a relevant message. Unrelated messages will NOT resume this task.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Brief explanation of what you're waiting for, shown to the user (e.g., 'Waiting for you to create a Discord bot and paste the token')",
            },
            resume_hint: {
              type: "string",
              description: "Description of what kind of response would unblock this task. Used to match incoming messages. Be specific (e.g., 'User confirms they created the Discord bot, pasted the token, or mentions the bot token')",
            },
            timeout_minutes: {
              type: "number",
              description: "Max minutes to wait before giving up (default: 30). Use longer for tasks requiring significant user effort.",
            },
          },
          required: ["reason", "resume_hint"],
        },
      },
    });
  }

  // V2: Inject agent.request_tools — lets agents expand their tool set at runtime
  if (options.onRequestTools && nativeTools) {
    nativeTools.push({
      type: "function" as const,
      function: {
        name: "agent__request_tools",
        description: "Request additional tool categories to be added to your active tool set. Use this when you discover you need tools from a category you weren't given (e.g., you need discord tools to send a notification, or shell tools to run a command). The tools will be available on your next LLM call.",
        parameters: {
          type: "object",
          properties: {
            categories: {
              type: "string",
              description: "Comma-separated tool categories you need (e.g., 'discord, shell, filesystem')",
            },
            reason: {
              type: "string",
              description: "Brief explanation of why you need these tools",
            },
          },
          required: ["categories", "reason"],
        },
      },
    });
  }

  // V2: Inject agent.request_research — lets agents delegate research to a sub-agent
  if (options.onRequestResearch && nativeTools) {
    nativeTools.push({
      type: "function" as const,
      function: {
        name: "agent__request_research",
        description: "Delegate a research task to a specialized research agent. Use this when you need to look up information (pricing, docs, competitors, etc.) but want to continue working on your primary task. The research agent will search the web, read pages, and return structured findings.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What to research — be specific (e.g., 'Current pricing tiers for Monday.com, Asana, and ClickUp')",
            },
            depth: {
              type: "string",
              description: "Research depth: 'quick' (5 iterations, basic search), 'moderate' (15 iterations, multi-source), 'thorough' (30 iterations, deep dive). Default: moderate",
            },
            format: {
              type: "string",
              description: "Output format: 'plain_text', 'structured_json', 'markdown'. Default: markdown",
            },
          },
          required: ["query"],
        },
      },
    });
  }

  const enrichedLlmOptions: LLMRequestOptions = {
    ...llmOptions,
    tools: nativeTools,
  };

  const messages: LLMMessage[] = [
    { role: "system", content: fullSystemPrompt },
  ];

  // Inject conversation history between system and user messages
  if (options.conversationHistory?.length) {
    for (const entry of options.conversationHistory) {
      messages.push({ role: entry.role, content: entry.content });
    }
  }

  messages.push({ role: "user", content: userMessage });

  const toolCallsMade: ToolLoopResult["toolCallsMade"] = [];
  const seenToolCalls = new Set<string>();
  let iterations = 0;
  let finalResponse = "";
  let infrastructureDown = false;
  let escalated = false;
  let neededToolCategories: string[] | undefined;
  let escalationReason: string | undefined;

  // Stuck detection: track consecutive calls to the same tool
  let consecutiveSameToolCount = 0;
  let lastToolId = "";
  const STUCK_WARNING_THRESHOLD = 3;
  const STUCK_ESCALATE_THRESHOLD = 5;

  while (iterations < options.maxIterations) {
    iterations++;

    log.info(`Tool loop iteration ${iterations}/${options.maxIterations}`, { personaId });

    // ── Check injection queue for user corrections ──
    if (options.injectionQueue && options.injectionQueue.length > 0) {
      const injections = options.injectionQueue.splice(0);
      const injectionText = injections.join("\n\n");
      log.info(`Injecting ${injections.length} user message(s) into tool loop`, { personaId });
      // New user question → clear reasoning_content from previous assistant messages
      // (DeepSeek thinking mode requirement: only keep reasoning within a single question)
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

    // Call LLM with native tool calling (abort-aware)
    const currentSignal = options.getAbortSignal?.();
    if (currentSignal?.aborted) {
      log.warn(`Tool loop aborted before LLM call`, { personaId, iteration: iterations });
      break;
    }
    // Defensive: ensure message sequence is valid before calling LLM
    sanitizeMessages(messages);

    const iterStartTime = Date.now();
    const response = await abortableCall(
      () => llm.chat(messages, enrichedLlmOptions),
      currentSignal
    );

    // Track per-iteration token usage
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

    const textContent = response.content || "";
    const toolCalls: ToolCall[] = response.toolCalls || [];

    log.info(`LLM response (iteration ${iterations})`, {
      personaId,
      contentLength: textContent.length,
      toolCallCount: toolCalls.length,
      tools: toolCalls.map(c => unsanitizeToolName(c.function.name)),
    });

    // ── No tool calls → check if we should nudge or exit ──
    if (toolCalls.length === 0) {
      // Skill execution nudge: if a skill was matched and the LLM just output text
      // without making any tool calls in the first 2 iterations, it's probably
      // explaining instead of executing. Nudge it to use tools.
      if (options.skillMatched && iterations <= 2 && toolCallsMade.length === 0) {
        log.warn(`Skill matched but LLM responded with text only (iteration ${iterations}) — nudging to execute`, { personaId });
        messages.push({
          role: "assistant",
          content: textContent,
        });
        messages.push({
          role: "user",
          content: "You have a skill with specific tool call instructions. Do NOT just describe what you would do — actually make the tool calls now. Start with the first tool call from the skill instructions.",
        });
        if (textContent && options.onStream) {
          options.onStream(personaId, textContent + "\n\n", false);
        }
        continue;
      }
      finalResponse = textContent;
      log.info(`Tool loop completed after ${iterations} iterations`, { personaId });
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

    // ── Loop detection ──
    const duplicates: string[] = [];
    for (const call of toolCalls) {
      const toolId = unsanitizeToolName(call.function.name);
      const key = `${toolId}:${call.function.arguments}`;
      if (seenToolCalls.has(key)) {
        duplicates.push(toolId);
      }
      seenToolCalls.add(key);
    }

    // ── Stuck detection: same tool called repeatedly ──
    if (toolCalls.length === 1) {
      const currentToolId = unsanitizeToolName(toolCalls[0].function.name);
      if (currentToolId === lastToolId) {
        consecutiveSameToolCount++;
      } else {
        consecutiveSameToolCount = 1;
        lastToolId = currentToolId;
      }
    } else if (toolCalls.length > 1) {
      consecutiveSameToolCount = 0;
      lastToolId = "";
    }

    // Stuck warning text — deferred until AFTER tool results to maintain valid
    // assistant→tool message sequence (DeepSeek/OpenAI require tool results to
    // immediately follow the assistant message with tool_calls)
    let stuckWarningText: string | undefined;

    // Warn at threshold — give the LLM a chance to self-correct
    if (consecutiveSameToolCount === STUCK_WARNING_THRESHOLD) {
      log.warn(`Stuck detection: ${lastToolId} called ${consecutiveSameToolCount} times — injecting warning`, { personaId });
      stuckWarningText = `⚠️ STUCK DETECTION: You have called ${lastToolId} ${consecutiveSameToolCount} times in a row. This tool is clearly not working for what you need. You have two options:\n1. Call agent.escalate with the tools you actually need (e.g., shell, filesystem, discord)\n2. Try a completely different approach\n\nDo NOT call ${lastToolId} again.`;
    }

    // Force-escalate if stuck on same tool too many times
    if (consecutiveSameToolCount >= STUCK_ESCALATE_THRESHOLD) {
      log.warn(`Stuck detection: ${lastToolId} called ${consecutiveSameToolCount} times consecutively — force-escalating`, { personaId });
      escalated = true;
      escalationReason = `Stuck: called ${lastToolId} ${consecutiveSameToolCount} times consecutively without making progress. This persona likely doesn't have the right tools for this task.`;
      neededToolCategories = undefined; // planner will figure it out
      finalResponse = `I'm having trouble completing this task with my current tools — I've been trying ${lastToolId} repeatedly without success. Let me get this re-routed to a better-equipped persona.`;
      // Push placeholder tool results so the message sequence stays valid
      // (assistant with tool_calls must be followed by tool results)
      for (const call of toolCalls) {
        messages.push({
          role: "tool",
          content: "Skipped — task force-escalated due to stuck detection",
          tool_call_id: call.id,
        });
      }
      break;
    }

    // ── Execute each tool call and add role:"tool" results ──
    for (const call of toolCalls) {
      const toolId = unsanitizeToolName(call.function.name);
      let toolArgs: Record<string, any>;
      try {
        toolArgs = JSON.parse(call.function.arguments);
      } catch {
        toolArgs = {};
        log.warn(`Failed to parse tool arguments for ${toolId}`, { personaId, raw: call.function.arguments });
      }

      log.info(`Executing tool: ${toolId}`, { personaId, args: toolArgs });
      options.onToolCall?.(toolId, toolArgs);

      // ── escalate: persona realizes it doesn't have the right tools ──
      if (toolId === "agent.escalate") {
        const reason = toolArgs.reason || "Persona needs different tools";
        const neededStr = toolArgs.needed_tools || "";
        log.info(`Tool loop escalating — agent.escalate called`, { personaId, reason, neededTools: neededStr });
        escalated = true;
        escalationReason = reason;
        neededToolCategories = neededStr
          ? neededStr.split(",").map((s: string) => s.trim()).filter(Boolean)
          : undefined;
        finalResponse = `I don't have the right tools for this task. ${reason} Let me get this re-routed to a better-equipped persona.`;

        // Push tool result so API message sequence stays valid
        messages.push({
          role: "tool",
          content: "Escalation accepted — task will be re-routed through the planner.",
          tool_call_id: call.id,
        });
        toolCallsMade.push({ tool: toolId, args: toolArgs, result: "escalated", success: true });

        // Skip remaining tool calls in this batch
        const escIdx = toolCalls.indexOf(call);
        for (let i = escIdx + 1; i < toolCalls.length; i++) {
          messages.push({
            role: "tool",
            content: "Skipped — task escalated to planner",
            tool_call_id: toolCalls[i].id,
          });
        }
        break;
      }

      // ── wait_for_user: cooperative pause ──
      // The LLM wants to stop and wait for user input. Instead of executing
      // a tool, we suspend the loop via a promise that resolves when the user
      // sends a message. The task is marked "blocked" while waiting.
      if (toolId === "agent.wait_for_user" && options.onWaitForUser) {
        const reason = toolArgs.reason || "Waiting for user response";
        const resumeHint = toolArgs.resume_hint || reason;
        const timeoutMs = toolArgs.timeout_minutes ? toolArgs.timeout_minutes * 60_000 : undefined;
        log.info(`Tool loop pausing — wait_for_user`, { personaId, reason, resumeHint, timeoutMs });

        // Suspend: this await resolves when the user sends a matching message
        // (text was already streamed at line ~297, assistant message already pushed at ~302)
        const userResponse = await options.onWaitForUser(reason, resumeHint, timeoutMs);
        log.info(`Tool loop resuming — user responded`, { personaId, responseLength: userResponse.length });

        // Push tool result (assistant message with tool_calls was already added above)
        messages.push({
          role: "tool",
          content: `User responded: ${userResponse}`,
          tool_call_id: call.id,
        });
        toolCallsMade.push({ tool: toolId, args: toolArgs, result: `User responded: ${userResponse}`, success: true });

        // Add "skipped" results for any remaining tool calls in this batch
        // (API requires every tool_call to have a matching tool result)
        const callIdx = toolCalls.indexOf(call);
        for (let i = callIdx + 1; i < toolCalls.length; i++) {
          messages.push({
            role: "tool",
            content: "Skipped — task paused for user input",
            tool_call_id: toolCalls[i].id,
          });
        }
        break;
      }

      // ── request_tools: agent needs more tool categories at runtime ──
      if (toolId === "agent.request_tools" && options.onRequestTools) {
        const categories = (toolArgs.categories || "")
          .split(",").map((s: string) => s.trim()).filter(Boolean);
        const reason = toolArgs.reason || "Agent requested additional tools";
        log.info("Tool loop: agent requesting additional tools", { personaId, categories, reason });

        const addedTools = options.onRequestTools(categories);
        const resultMsg = addedTools.length > 0
          ? `Added ${addedTools.length} tools from categories: ${categories.join(", ")}. They're now available for your next action.`
          : `No additional tools found for categories: ${categories.join(", ")}. Try different category names or call agent.escalate.`;

        messages.push({ role: "tool", content: resultMsg, tool_call_id: call.id });
        toolCallsMade.push({ tool: toolId, args: toolArgs, result: resultMsg, success: addedTools.length > 0 });
        continue;
      }

      // ── request_research: delegate research to a sub-agent ──
      if (toolId === "agent.request_research" && options.onRequestResearch) {
        const query = toolArgs.query || "";
        const depth = toolArgs.depth || "moderate";
        const format = toolArgs.format || "markdown";
        log.info("Tool loop: agent requesting research", { personaId, query, depth });

        try {
          const findings = await options.onRequestResearch(query, depth, format);
          messages.push({ role: "tool", content: findings, tool_call_id: call.id });
          toolCallsMade.push({ tool: toolId, args: toolArgs, result: findings, success: true });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          messages.push({ role: "tool", content: `Research failed: ${errMsg}`, tool_call_id: call.id });
          toolCallsMade.push({ tool: toolId, args: toolArgs, result: `Research failed: ${errMsg}`, success: false });
        }
        continue;
      }

      let resultContent: string;
      let resultImages: Array<{ base64: string; media_type: "image/jpeg" | "image/png" }> | undefined;
      let success: boolean;

      try {
        const toolEntry = findToolEntry(toolId, options.toolManifest);
        const isPremium = toolEntry?.category === "premium" && options.executePremiumTool;
        const isImageGen = toolEntry?.category === "imagegen" && options.executeImageGenTool;
        const isKnowledgeIngest = toolId === "knowledge.ingest" && options.executeKnowledgeIngest;
        const isScheduleTool = toolEntry?.category === "schedule" && options.executeScheduleTool;
        const isResearchTool = toolEntry?.category === "research" && options.executeResearchTool;

        let result: string;
        if (isPremium) {
          log.info(`Routing to premium executor`, { personaId, tool: toolId });
          const premiumResult = await options.executePremiumTool!(toolEntry!.id, toolArgs);
          if (!premiumResult.success) {
            throw new Error(premiumResult.error || "Unknown premium tool error");
          }
          result = premiumResult.output;
        } else if (isImageGen) {
          log.info(`Routing to imagegen executor`, { personaId, tool: toolId });
          const imageResult = await options.executeImageGenTool!(toolEntry!.id, toolArgs, options.executeCommand);
          if (!imageResult.success) {
            throw new Error(imageResult.error || "Image generation failed");
          }
          result = imageResult.output;
        } else if (isKnowledgeIngest) {
          log.info(`Routing to knowledge ingest executor`, { personaId, tool: toolId });
          const ingestResult = await options.executeKnowledgeIngest!(toolId, toolArgs);
          if (!ingestResult.success) {
            throw new Error(ingestResult.error || "Knowledge ingestion failed");
          }
          result = ingestResult.output;
        } else if (isScheduleTool) {
          log.info(`Routing to schedule executor`, { personaId, tool: toolId });
          const schedResult = await options.executeScheduleTool!(toolId, toolArgs);
          if (!schedResult.success) {
            throw new Error(schedResult.error || "Schedule operation failed");
          }
          result = schedResult.output;
        } else if (isResearchTool) {
          log.info(`Routing to research executor`, { personaId, tool: toolId });
          const researchResult = await options.executeResearchTool!(toolId, toolArgs, options.executeCommand);
          if (!researchResult.success) {
            throw new Error(researchResult.error || "Research save failed");
          }
          result = researchResult.output;
        } else {
          const command = buildExecutionCommand(
            { tool: toolId, args: toolArgs },
            usePluginRouting,
            options.toolManifest
          );
          result = await abortableCall(
            () => options.executeCommand(command),
            options.getAbortSignal?.()
          );
        }

        // Check if result contains an image (screenshot) — extract it for
        // proper LLM image content blocks instead of sending raw base64 as text
        const imageExtraction = extractImageFromResult(result);
        if (imageExtraction) {
          resultContent = imageExtraction.textContent;
          resultImages = [imageExtraction.image];
          log.info(`Tool ${toolId} returned image (${imageExtraction.image.media_type})`, { personaId });
        } else {
          resultContent = truncateResult(result);
        }
        success = true;
        toolCallsMade.push({ tool: toolId, args: toolArgs, result: resultContent, success: true });
        options.onToolResult?.(toolId, resultContent, true);
        log.info(`Tool ${toolId} succeeded`, { personaId, resultLength: result.length });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        resultContent = `Error: ${errorMsg}`;
        success = false;
        toolCallsMade.push({ tool: toolId, args: toolArgs, result: errorMsg, success: false });
        options.onToolResult?.(toolId, errorMsg, false);
        log.warn(`Tool ${toolId} failed`, { personaId, error: errorMsg });

        // Circuit breaker: infrastructure errors (no local-agent, device gone) are
        // unrecoverable at the tool-loop level. Every subsequent tool call will fail
        // identically, so stop immediately instead of burning iterations.
        const lower = errorMsg.toLowerCase();
        if (lower.includes("no local-agent") || lower.includes("not connected") || lower.includes("no device")) {
          log.error(`Infrastructure error detected — breaking tool loop`, { personaId, error: errorMsg });
          infrastructureDown = true;
        }
      }

      // Add tool result as role:"tool" message with matching tool_call_id
      const toolMsg: LLMMessage = {
        role: "tool",
        content: resultContent,
        tool_call_id: call.id,
      };
      if (resultImages) {
        toolMsg.images = resultImages;
      }
      messages.push(toolMsg);
    }

    // ── Circuit breaker: infrastructure is down, stop immediately ──
    if (infrastructureDown) {
      finalResponse = "I'm unable to execute any tools right now — the local agent is disconnected. " +
        "Please check that the local agent is running and connected, then try again.";
      break;
    }

    // ── Escalation: persona requested re-routing, stop loop immediately ──
    if (escalated) {
      break;
    }

    // ── Append stuck warning AFTER tool results (must come after role:"tool" messages) ──
    if (stuckWarningText) {
      messages.push({ role: "user", content: stuckWarningText });
    }

    // ── Append loop warning if duplicates detected ──
    if (duplicates.length > 0) {
      messages.push({
        role: "user",
        content: `⚠️ WARNING: You already called ${duplicates.join(", ")} with the same arguments before. Do NOT repeat the same tool call. Move on to the next step.`,
      });
    }
  }

  if (iterations >= options.maxIterations && !finalResponse) {
    log.warn(`Tool loop hit max iterations — running synthesis pass`, { personaId, iterations });

    // Final LLM call WITHOUT tools to force a text summary
    try {
      messages.push({
        role: "user",
        content: "Summarize what you have accomplished so far into a clear, helpful response for the user. List what is done and what remains. Do NOT mention any internal limits, iteration counts, or system constraints. If work remains, tell the user what's left and offer to continue.",
      });

      // Drop tools parameter for synthesis — force text-only response
      const synthesisOptions: LLMRequestOptions = { ...llmOptions };
      sanitizeMessages(messages);
      const synthStartTime = Date.now();
      const synthesisResponse = await llm.chat(messages, synthesisOptions);
      finalResponse = synthesisResponse.content || "I completed several actions but couldn't generate a final summary.";
      log.info(`Synthesis pass produced ${finalResponse.length} chars`, { personaId });

      options.onLLMResponse?.({
        persona: personaId,
        duration: Date.now() - synthStartTime,
        responseLength: finalResponse.length,
        response: finalResponse,
        model: synthesisResponse.model,
        provider: synthesisResponse.provider,
        inputTokens: synthesisResponse.usage?.inputTokens,
        outputTokens: synthesisResponse.usage?.outputTokens,
      });
    } catch (err) {
      log.error(`Synthesis pass failed`, { personaId, error: err });
      finalResponse = "I completed several tool actions but ran into an issue generating the final summary. Please check the results above.";
    }
  }

  return {
    response: finalResponse,
    toolCallsMade,
    iterations,
    completed: iterations < options.maxIterations,
    escalated: escalated || undefined,
    neededToolCategories,
    escalationReason,
  };
}

/**
 * Find a tool entry in the manifest by name or ID (with fuzzy matching).
 */
function findToolEntry(toolName: string, manifest?: ToolManifestEntry[]): ToolManifestEntry | undefined {
  if (!manifest) return undefined;

  // Exact match first
  let entry = manifest.find(t => t.name === toolName || t.id === toolName);
  if (entry) return entry;

  // Fuzzy: bare name without category prefix
  entry = manifest.find(t => {
    const dotIdx = t.id.indexOf('.');
    return dotIdx >= 0 && t.id.substring(dotIdx + 1) === toolName;
  });
  if (entry) {
    log.info(`Resolved bare tool name "${toolName}" → "${entry.id}"`);
  }
  return entry;
}

// ============================================
// COMMAND BUILDING
// ============================================

/**
 * Convert a parsed tool call into an ExecutionCommand for the local agent.
 * 
 * When usePluginRouting is true, ALL tools route through tool_execute,
 * letting the local agent's tool executor handle dispatch.
 * Legacy routing is kept as fallback for when no manifest is available.
 */
function buildExecutionCommand(
  call: { tool: string; args: Record<string, any> },
  usePluginRouting: boolean,
  manifest?: ToolManifestEntry[]
): ExecutionCommand {
  const id = `cmd_${nanoid(12)}`;

  // Plugin routing: resolve tool name → tool ID, send as tool_execute
  if (usePluginRouting && manifest) {
    const toolEntry = findToolEntry(call.tool, manifest);
    if (!toolEntry) {
      log.warn(`Tool "${call.tool}" not found in manifest — LLM may have hallucinated a tool name`);
    }
    const toolId = toolEntry?.id || call.tool;
    const isDestructive = toolEntry?.annotations?.destructiveHint ?? false;
    const category = toolEntry?.category || toolId.split(".")[0] || "";

    // Category-aware timeouts: codegen needs 10min, shell needs 5min, others get 30s
    const timeoutByCategory: Record<string, number> = {
      codegen: 660_000,  // 11 min (codegen's internal timeout is 10 min)
      secrets: 960_000,  // 16 min (credential entry blocks up to 15 min)
      shell: 300_000,    // 5 min
      market: 180_000,   // 3 min (xai_sentiment uses serverLLMCall which has 2min timeout)
      browser: 60_000,   // 1 min
      gui: 60_000,       // 1 min (page loads, waits, screenshots)
    };
    const timeout = timeoutByCategory[category] || 30_000;

    return {
      id,
      type: "tool_execute",
      payload: {
        toolId,
        toolArgs: call.args,
      },
      dryRun: false,
      timeout,
      sandboxed: isDestructive,
      requiresApproval: toolEntry?.annotations?.requiresConfirmation ?? false,
    };
  }

  // Legacy routing: hardcoded tool name → execution type mapping
  switch (call.tool) {
    case "create_file":
      return {
        id,
        type: "file_write",
        payload: {
          path: expandHomePath(call.args.path),
          content: call.args.content || "",
        },
        dryRun: false,
        timeout: 10_000,
        sandboxed: false,
        requiresApproval: false,
      };

    case "read_file":
      return {
        id,
        type: "file_read",
        payload: {
          path: expandHomePath(call.args.path),
        },
        dryRun: false,
        timeout: 10_000,
        sandboxed: false,
        requiresApproval: false,
      };

    case "run_command":
      return {
        id,
        type: "powershell",
        payload: {
          script: call.args.command,
        },
        dryRun: false,
        timeout: 30_000,
        sandboxed: true,
        requiresApproval: false,
      };

    case "list_directory":
      return {
        id,
        type: "powershell",
        payload: {
          script: `Get-ChildItem -Path "${expandHomePath(call.args.path)}" | ForEach-Object { $type = if($_.PSIsContainer){'[DIR]'}else{'[FILE]'}; "$type $($_.Name)$(if(!$_.PSIsContainer){' ('+$_.Length+' bytes)'})" }`,
        },
        dryRun: false,
        timeout: 10_000,
        sandboxed: false,
        requiresApproval: false,
      };

    default:
      throw new Error(`Unknown tool: ${call.tool}`);
  }
}

/**
 * Minimal path normalization — pass ~/paths through for the local-agent to resolve,
 * since only the local machine knows the actual folder locations (Dropbox, OneDrive, etc.)
 */
function expandHomePath(filePath: string): string {
  // Normalize forward slashes to backslashes for Windows
  return filePath.replace(/\//g, "\\");
}

/**
 * Race an async operation against an AbortSignal.
 * If signal fires before the operation completes, rejects with "Operation aborted by watchdog".
 * If no signal provided, just runs the operation normally.
 */
function abortableCall<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return fn();
  if (signal.aborted) return Promise.reject(new Error("Operation aborted by watchdog"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("Operation aborted by watchdog — task exceeded time limit. Check injection queue for investigator diagnosis."));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    fn().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
