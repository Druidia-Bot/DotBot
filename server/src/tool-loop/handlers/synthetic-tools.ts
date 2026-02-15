/**
 * Synthetic Tool Handlers
 *
 * Tools that don't exist on the local agent — they're injected into the
 * LLM's tool set by the loop and handled entirely server-side.
 *
 *   - agent__escalate      — re-route to planner (already handled via stopTool)
 *   - agent__wait_for_user — pause loop, wait for user response
 *   - agent__request_tools — expand tool set at runtime
 *   - agent__request_research — delegate research to sub-agent
 *
 * Each function returns both:
 *   - A ToolDefinition (for injection into the LLM's tools array)
 *   - A ToolHandler (for the handler map)
 *
 * Callbacks are pulled from ctx.state (set by the caller at setup time).
 */

import { createComponentLogger } from "../../logging.js";
import type { ToolDefinition } from "../../llm/types.js";
import type { ToolHandler, ToolHandlerResult } from "../types.js";

const log = createComponentLogger("tool-loop.synthetic");

// ============================================
// ESCALATE
// ============================================

export const ESCALATE_TOOL_ID = "agent__escalate";

export function escalateToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "agent__escalate",
      description: "Call this when you realize you don't have the right tools for this task. This will re-route the task to the planner, which will pick a persona with the correct tools. Do NOT keep trying the same failing approach — escalate instead.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why you can't complete the task with your current tools",
          },
          needed_tools: {
            type: "string",
            description: "Comma-separated list of tool categories you think are needed (e.g., 'shell, filesystem, discord')",
          },
        },
        required: ["reason"],
      },
    },
  };
}

/**
 * Build an escalation handler. Before truly escalating, attempts
 * auto-resolve via request_tools if the agent specified categories.
 */
export function escalateHandler(): ToolHandler {
  return async (ctx, args): Promise<ToolHandlerResult> => {
    const reason = args.reason || "Persona needs different tools";
    const neededStr = args.needed_tools || "";
    const neededCategories = neededStr
      ? neededStr.split(",").map((s: string) => s.trim()).filter(Boolean)
      : [];

    // Auto-resolve: try adding the requested tool categories first
    const onRequestTools = ctx.state.onRequestTools as ((cats: string[]) => string[]) | undefined;
    if (neededCategories.length > 0 && onRequestTools) {
      log.info("Escalation intercepted — attempting auto-resolve via request_tools", {
        categories: neededCategories,
      });
      const addedTools = onRequestTools(neededCategories);
      if (addedTools.length > 0) {
        const msg = `✅ Escalation resolved — added ${addedTools.length} tools from categories: ${neededCategories.join(", ")}. ` +
          `They're now available. Continue with the task instead of escalating.`;
        log.info("Escalation auto-resolved", { addedToolCount: addedTools.length });
        return { content: msg };
      }
    }

    // Could not auto-resolve — set escalation flags in context
    log.info("Tool loop escalating", { reason, neededTools: neededStr });
    ctx.state.escalated = true;
    ctx.state.escalationReason = reason;
    ctx.state.neededToolCategories = neededCategories.length > 0 ? neededCategories : undefined;

    return {
      content: "Escalation accepted — task will be re-routed through the planner.",
      breakBatch: true,
    };
  };
}

// ============================================
// WAIT FOR USER
// ============================================

export const WAIT_FOR_USER_TOOL_ID = "agent__wait_for_user";

export function waitForUserToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "agent__wait_for_user",
      description: "Pause execution and wait for the user to respond. Use this when you need information or action from the user before you can continue (e.g., they need to create an account, enter credentials, make a choice). The task will be suspended and automatically resume when the user sends a relevant message.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Brief explanation of what you're waiting for, shown to the user",
          },
          resume_hint: {
            type: "string",
            description: "Description of what kind of response would unblock this task. Used to match incoming messages.",
          },
          timeout_minutes: {
            type: "number",
            description: "Max minutes to wait before giving up (default: 30).",
          },
        },
        required: ["reason", "resume_hint"],
      },
    },
  };
}

export function waitForUserHandler(): ToolHandler {
  return async (ctx, args): Promise<ToolHandlerResult> => {
    const onWaitForUser = ctx.state.onWaitForUser as
      ((reason: string, resumeHint?: string, timeoutMs?: number) => Promise<string>) | undefined;

    if (!onWaitForUser) {
      return { content: "Error: wait_for_user not supported in this context" };
    }

    const reason = args.reason || "Waiting for user response";
    const resumeHint = args.resume_hint || reason;
    const timeoutMs = args.timeout_minutes ? args.timeout_minutes * 60_000 : undefined;
    log.info("Tool loop pausing — wait_for_user", { reason, resumeHint, timeoutMs });

    const userResponse = await onWaitForUser(reason, resumeHint, timeoutMs);
    log.info("Tool loop resuming — user responded", { responseLength: userResponse.length });

    return {
      content: `User responded: ${userResponse}`,
      breakBatch: true,
    };
  };
}

// ============================================
// REQUEST TOOLS
// ============================================

export const REQUEST_TOOLS_TOOL_ID = "agent__request_tools";

export function requestToolsToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "agent__request_tools",
      description: "Request additional tool categories to be added to your active tool set. Use this when you discover you need tools from a category you weren't given. The tools will be available on your next LLM call.",
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
  };
}

export function requestToolsHandler(): ToolHandler {
  return async (ctx, args) => {
    const onRequestTools = ctx.state.onRequestTools as ((cats: string[]) => string[]) | undefined;
    if (!onRequestTools) {
      return "Error: request_tools not supported in this context";
    }

    const categories = (args.categories || "")
      .split(",").map((s: string) => s.trim()).filter(Boolean);
    const reason = args.reason || "Agent requested additional tools";
    log.info("Agent requesting additional tools", { categories, reason });

    const addedTools = onRequestTools(categories);
    return addedTools.length > 0
      ? `Added ${addedTools.length} tools from categories: ${categories.join(", ")}. They're now available for your next action.`
      : `No additional tools found for categories: ${categories.join(", ")}. Try different category names or call agent.escalate.`;
  };
}

// ============================================
// REQUEST RESEARCH
// ============================================

export const REQUEST_RESEARCH_TOOL_ID = "agent__request_research";

export function requestResearchToolDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "agent__request_research",
      description: "Delegate a research task to a specialized research agent. Use this when you need to look up information (pricing, docs, competitors, etc.) but want to continue working on your primary task.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to research — be specific",
          },
          depth: {
            type: "string",
            description: "Research depth: 'quick', 'moderate', or 'thorough'. Default: moderate",
          },
          format: {
            type: "string",
            description: "Output format: 'plain_text', 'structured_json', 'markdown'. Default: markdown",
          },
        },
        required: ["query"],
      },
    },
  };
}

export function requestResearchHandler(): ToolHandler {
  return async (ctx, args) => {
    const onRequestResearch = ctx.state.onRequestResearch as
      ((query: string, depth: string, format: string) => Promise<string>) | undefined;

    if (!onRequestResearch) {
      return "Error: request_research not supported in this context";
    }

    const query = args.query || "";
    const depth = args.depth || "moderate";
    const format = args.format || "markdown";
    log.info("Agent requesting research", { query, depth });

    try {
      return await onRequestResearch(query, depth, format);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return `Research failed: ${errMsg}`;
    }
  };
}

// ============================================
// UTILITY: Build all synthetic tools + handlers
// ============================================

export interface SyntheticToolsConfig {
  /** Include wait_for_user tool */
  waitForUser?: boolean;
  /** Include request_tools tool */
  requestTools?: boolean;
  /** Include request_research tool */
  requestResearch?: boolean;
}

/**
 * Build synthetic tool definitions and handlers based on config.
 * Escalate is always included.
 */
export function buildSyntheticTools(config: SyntheticToolsConfig = {}): {
  definitions: ToolDefinition[];
  handlers: Map<string, ToolHandler>;
} {
  const definitions: ToolDefinition[] = [escalateToolDefinition()];
  const handlers = new Map<string, ToolHandler>();
  handlers.set(ESCALATE_TOOL_ID, escalateHandler());

  if (config.waitForUser) {
    definitions.push(waitForUserToolDefinition());
    handlers.set(WAIT_FOR_USER_TOOL_ID, waitForUserHandler());
  }

  if (config.requestTools) {
    definitions.push(requestToolsToolDefinition());
    handlers.set(REQUEST_TOOLS_TOOL_ID, requestToolsHandler());
  }

  if (config.requestResearch) {
    definitions.push(requestResearchToolDefinition());
    handlers.set(REQUEST_RESEARCH_TOOL_ID, requestResearchHandler());
  }

  return { definitions, handlers };
}
