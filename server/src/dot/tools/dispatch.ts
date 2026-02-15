/**
 * Dot Tool — task.dispatch
 *
 * Hands off a fully-formed task to the execution pipeline.
 * Dot must present a plan + time estimate and get user confirmation
 * before calling this tool.
 */

import { createComponentLogger } from "#logging.js";
import type { ToolDefinition } from "#llm/types.js";
import type { ToolHandler, ToolHandlerResult, ToolContext } from "#tool-loop/types.js";

const log = createComponentLogger("dot.tools.dispatch");

export const TASK_DISPATCH_TOOL_ID = "task.dispatch";

export function taskDispatchDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "task__dispatch",
      description:
        "Dispatch a task to the full execution pipeline. The pipeline will create a workspace, " +
        "select specialized tools and personas, plan the work, and execute it. Use this for advanced tasks " +
        "that require custom file creation, code generation, multi-step research, lots of shell commands, or any " +
        "work you cannot complete quickly. You MUST present a tentative plan and time " +
        "estimate to the user and receive their confirmation BEFORE calling this tool.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "A fully-formed, detailed task description or full skill.md content for the pipeline. Include all context " +
              "from your conversation — the pipeline agent won't have your chat history. Be specific " +
              "about what to do, what the user wants, constraints, preferences, and expected output.",
          },
          estimated_minutes: {
            type: "number",
            description: "Your estimated time for this task in minutes.",
          },
        },
        required: ["prompt"],
      },
    },
  };
}

/**
 * Build the task.dispatch handler. The handler is a closure over the
 * dispatch callback — the actual pipeline invocation is wired by dot.ts.
 */
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
