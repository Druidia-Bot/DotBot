/**
 * Tool Handler — Research Wrapper
 *
 * Composable middleware that wraps tool handlers with:
 *   1. Workspace persistence — raw results saved to research/
 *   2. Background summarization — large results summarized via LLM
 *   3. Truncation — oversized results trimmed with pointers to full files
 *
 * Only applies to research-heavy tool categories (search, http, market,
 * research). Non-research tools pass through with zero overhead.
 *
 * Category detection lives in research-categories.ts.
 * LLM summarization lives in research-summarizer.ts.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../../logging.js";
import { sendExecutionCommand } from "../../ws/device-bridge.js";
import { isResearchTool, MAX_TOOL_RESULT_CHARS } from "./research-categories.js";
import { summarizeAndSave } from "./research-summarizer.js";
import type { ToolHandler, ToolContext, ToolHandlerResult } from "../types.js";

const log = createComponentLogger("tool-loop.research");

/**
 * Wrap a handler to persist research results to the workspace.
 *
 * @param toolId - The tool's dotted ID
 * @param inner - The original handler to wrap
 * @param workspacePath - Absolute path to the agent workspace (must include research/ subdir)
 * @param categoryMap - Optional map of toolId → category for accurate detection
 */
export function withResearchPersistence(
  toolId: string,
  inner: ToolHandler,
  workspacePath: string,
  categoryMap?: Map<string, string>,
): ToolHandler {
  // Not a research tool — return as-is, no overhead
  if (!isResearchTool(toolId, categoryMap)) return inner;

  return async (ctx: ToolContext, args: Record<string, any>): Promise<string> => {
    const innerResult = await inner(ctx, args);
    const rawResult = typeof innerResult === "string" ? innerResult : innerResult.content;

    // File paths
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeToolId = toolId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const rawFilename = `${safeToolId}-${timestamp}.txt`;
    const summaryFilename = `${safeToolId}-${timestamp}-summary.md`;
    const rawPath = `${workspacePath}/research/${rawFilename}`;
    const summaryPath = `${workspacePath}/research/${summaryFilename}`;

    // Fire-and-forget: save full result to workspace
    sendExecutionCommand(ctx.deviceId, {
      id: `research_save_${nanoid(6)}`,
      type: "tool_execute",
      payload: {
        toolId: "filesystem.create_file",
        toolArgs: { path: rawPath, content: rawResult },
      },
      dryRun: false,
      timeout: 10_000,
      sandboxed: false,
      requiresApproval: false,
    }).then(() => {
      log.info("Saved research result", { toolId, rawFilename, chars: rawResult.length });
    }).catch(err => {
      log.warn("Failed to save research result", { toolId, rawFilename, error: err });
    });

    // If small enough, pass through with a note — no summarization needed
    if (rawResult.length <= MAX_TOOL_RESULT_CHARS) {
      return rawResult + `\n\n[Full result also saved to workspace/research/${rawFilename}]`;
    }

    // Large result — kick off background summarization (fire-and-forget)
    summarizeAndSave(ctx, rawResult, toolId, summaryPath).catch(err => {
      log.warn("summarizeAndSave rejected", { toolId, error: err });
    });

    // Return truncated result immediately — don't block on summarization
    const truncated = rawResult.substring(0, MAX_TOOL_RESULT_CHARS)
      + `\n\n...[truncated — full ${rawResult.length} chars saved to workspace/research/${rawFilename}]`
      + `\n[A summary is being generated at workspace/research/${summaryFilename}]`;
    return truncated;
  };
}

/**
 * Wrap all handlers in a map with research persistence.
 * Returns a new Map — the original is not mutated.
 */
export function wrapHandlersWithResearch(
  handlers: Map<string, ToolHandler>,
  workspacePath: string,
  categoryMap?: Map<string, string>,
): Map<string, ToolHandler> {
  const wrapped = new Map<string, ToolHandler>();
  for (const [toolId, handler] of handlers) {
    wrapped.set(toolId, withResearchPersistence(toolId, handler, workspacePath, categoryMap));
  }
  return wrapped;
}
