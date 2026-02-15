/**
 * Tool Loop — Shared Types
 *
 * Generic types for the tool execution loop. Any caller (receptionist,
 * orchestrator, step executor, heartbeat, condenser, etc.) can use this
 * loop by providing a handler registry and tool definitions.
 *
 * Features are opt-in: callers only provide what they need.
 * Simple callers (receptionist) use handlers + maxIterations.
 * Full callers (execution.ts) add streaming, abort, injection, etc.
 */

import type { ILLMClient, LLMMessage, LLMRequestOptions, ToolDefinition } from "../llm/types.js";

/**
 * Context passed to every tool handler. Contains what the handler needs
 * to communicate with the local agent and track side effects.
 */
export interface ToolContext {
  deviceId: string;
  /** Mutable bag for handlers to stash side-effect data (e.g. resurfacedModels, llmClient). */
  state: Record<string, any>;
}

/**
 * A tool handler: takes context + parsed args, returns the string result
 * that gets sent back to the LLM as a tool message.
 *
 * Handlers can also return a ToolHandlerResult for richer control
 * (e.g., images, breaking the current batch).
 */
export type ToolHandler = (ctx: ToolContext, args: Record<string, any>) => Promise<string | ToolHandlerResult>;

/**
 * Rich result from a tool handler. Use this when you need to return
 * images, signal batch breaks, etc.
 */
export interface ToolHandlerResult {
  /** Text content sent back to the LLM as the tool result. */
  content: string;
  /** Images to attach to the tool result message. */
  images?: Array<{ base64: string; media_type: "image/jpeg" | "image/png" }>;
  /** If true, skip remaining tool calls in this batch (used by wait_for_user, escalate). */
  breakBatch?: boolean;
}

/**
 * Options for the generic tool loop.
 */
export interface ToolLoopOptions {
  client: ILLMClient;
  model: string;
  maxTokens: number;
  messages: LLMMessage[];
  tools: ToolDefinition[];
  handlers: Map<string, ToolHandler>;
  maxIterations: number;
  temperature?: number;

  /** Tool name that signals "stop the loop." The handler still runs, but the loop exits after. */
  stopTool?: string;
  /** Context passed to all handlers. */
  context: ToolContext;
  /** Persona ID for logging and callbacks. */
  personaId?: string;

  // ── Streaming ──
  /** Stream callback for real-time output (text chunks between iterations). */
  onStream?: (personaId: string, chunk: string, done: boolean) => void;

  // ── Abort ──
  /** Getter for current AbortSignal — watchdog can abort the current blocking operation. */
  getAbortSignal?: () => AbortSignal | undefined;

  // ── Injection queue ──
  /** Shared injection queue — external code can push messages here (e.g. user corrections).
   *  The tool loop drains this at the start of each iteration. */
  injectionQueue?: string[];

  // ── Conversation history ──
  /** Conversation history to inject between system and user messages (already in messages array if needed). */
  conversationHistory?: { role: "user" | "assistant"; content: string }[];

  // ── Callbacks ──
  /** Called when a tool is invoked. */
  onToolCall?: (tool: string, args: Record<string, any>) => void;
  /** Called when a tool returns a result. */
  onToolResult?: (tool: string, result: string, success: boolean) => void;
  /** Called after each LLM call with model/token info (for token tracking). */
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

  // ── Skill nudge ──
  /** When true, a skill was injected — nudge the LLM to make tool calls if it tries
   *  to respond with text-only on early iterations. */
  skillMatched?: boolean;

  // ── Extra LLM options ──
  /** Additional LLM request options (thinking, etc.) passed through to the client. */
  extraLLMOptions?: Partial<LLMRequestOptions>;
}

/**
 * Result from the generic tool loop.
 */
export interface ToolLoopResult {
  /** Total LLM iterations executed. */
  iterations: number;
  /** True if the loop stopped because stopTool was called. */
  stoppedByTool: boolean;
  /** The final text content from the last LLM response (if any). */
  finalContent: string;
  /** The arguments passed to the stop tool (if it was called). */
  stopToolArgs: Record<string, any> | null;
  /** Whether the loop completed normally (vs hitting max iterations). */
  completed: boolean;
  /** Tool calls that were executed. */
  toolCallsMade: { tool: string; args: Record<string, any>; result: string; success: boolean }[];
  /** When true, the persona called agent__escalate or got force-escalated. */
  escalated?: boolean;
  /** Why the escalation happened. */
  escalationReason?: string;
  /** Needed tool categories (from escalation). */
  neededToolCategories?: string[];
  /** Compact conversation log for workspace persistence. */
  conversationLog?: Array<{ role: string; content: string; toolCalls?: any[] }>;
}
