/**
 * Background search + check_results handlers.
 */

import type { ToolExecResult } from "../_shared/types.js";

export async function handleBackgroundSearch(args: Record<string, any>): Promise<ToolExecResult> {
  if (!args.type) return { success: false, output: "", error: "Missing required field: type" };
  if (!args.query) return { success: false, output: "", error: "Missing required field: query" };

  const validTypes = ["file_content", "deep_memory", "archived_threads"];
  if (!validTypes.includes(args.type)) {
    return { success: false, output: "", error: `Invalid search type: ${args.type}. Must be one of: ${validTypes.join(", ")}` };
  }

  const { startBackgroundSearch } = await import("../background-search.js");
  const taskId = startBackgroundSearch(args.type, args.query);

  return {
    success: true,
    output: `Background search started.\n\nTask ID: ${taskId}\nType: ${args.type}\nQuery: "${args.query}"\n\nUse search.check_results with task_id="${taskId}" to poll for results.`,
  };
}

export async function handleCheckResults(args: Record<string, any>): Promise<ToolExecResult> {
  if (!args.task_id) return { success: false, output: "", error: "Missing required field: task_id" };

  const { checkSearchResults } = await import("../background-search.js");
  const task = checkSearchResults(args.task_id);

  if (!task) {
    return { success: false, output: "", error: `No search task found with ID: ${args.task_id}` };
  }

  if (task.status === "running") {
    const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
    return {
      success: true,
      output: `Search still running (${elapsed}s elapsed).\nType: ${task.type}\nQuery: "${task.query}"\n\nCheck again shortly with search.check_results({ task_id: "${task.id}" }).`,
    };
  }

  if (task.status === "error") {
    return { success: false, output: "", error: `Search failed: ${task.error}` };
  }

  const elapsed = task.completedAt ? Math.round((task.completedAt - task.startedAt) / 1000) : 0;
  return {
    success: true,
    output: `Search complete (${elapsed}s, ${task.resultCount || 0} results).\nType: ${task.type}\nQuery: "${task.query}"\n\n${task.results || "No results."}`,
  };
}
