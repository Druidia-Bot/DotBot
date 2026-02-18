/**
 * Handler: task.dispatch
 *
 * Closure over the onDispatch callback (wired by dot.ts).
 */

import { createComponentLogger } from "#logging.js";
import type { ToolHandler, ToolHandlerResult, ToolContext } from "#tool-loop/types.js";

const log = createComponentLogger("dot.tools.dispatch");

export function taskDispatchHandler(
  onDispatch: (prompt: string) => Promise<{
    agentId?: string;
    workspacePath?: string;
    success?: boolean;
    executionResponse?: string;
  }>
): ToolHandler {
  return async (_ctx: ToolContext, args: Record<string, any>): Promise<ToolHandlerResult> => {
    const prompt = args.prompt;
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 10) {
      return {
        content: "Error: prompt is required and must be a detailed task description (at least 10 characters).",
      };
    }

    log.info("Dispatching task to pipeline", {
      promptLength: prompt.length,
      estimatedMinutes: args.estimated_minutes,
    });

    try {
      const result = await onDispatch(prompt);

      const parts: string[] = [];
      parts.push("✅ Task dispatched successfully.");
      if (result.agentId) parts.push(`Agent: ${result.agentId}`);
      if (result.workspacePath) parts.push(`Workspace: ${result.workspacePath}`);
      if (result.success !== undefined) parts.push(`Success: ${result.success}`);
      if (result.executionResponse) {
        parts.push(`\n--- Pipeline Result ---\n${result.executionResponse}`);
      }
      parts.push(
        "\n--- Instructions ---\n" +
        "Present these results to the user clearly. Ask if they need help " +
        "navigating the output, interpreting the results, or taking next steps."
      );
      return { content: parts.join("\n") };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Task dispatch failed", { error: errMsg });
      return { content: `Error dispatching task: ${errMsg}` };
    }
  };
}
