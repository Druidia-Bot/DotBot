/**
 * Dot Tools — Run-Log Inspection
 *
 * Gives Dot the ability to inspect her own execution logs:
 *   - logs.list   — list available log files (one per day, 72h retention)
 *   - logs.read   — read entries from a specific day's log
 *   - logs.search — search across all logs for a keyword or stage
 */

import { sendMemoryRequest } from "#ws/device-bridge.js";
import { getDeviceForUser } from "#ws/devices.js";
import type { MemoryRequest } from "#ws/devices.js";
import type { ToolDefinition } from "#llm/types.js";
import type { ToolHandler, ToolContext } from "#tool-loop/types.js";

// ============================================
// LOGS.LIST
// ============================================

export const LOGS_LIST_TOOL_ID = "logs.list";

export function logsListDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "logs__list",
      description:
        "List available run-log files. Each file covers one day (YYYY-MM-DD.log). " +
        "Logs are auto-pruned after 72 hours. Returns file names, sizes, and last-modified timestamps.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  };
}

export function logsListHandler(): ToolHandler {
  return async (ctx: ToolContext, _args: Record<string, any>) => {
    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);
    if (!deviceId) return "No local agent connected — cannot list logs.";

    const result = await sendMemoryRequest(deviceId, {
      action: "list_run_logs",
    } as MemoryRequest);

    if (!result || (Array.isArray(result) && result.length === 0)) {
      return "No run-log files found. Logs are created when the pipeline processes requests and auto-pruned after 72 hours.";
    }

    return JSON.stringify(result, null, 2);
  };
}

// ============================================
// LOGS.READ
// ============================================

export const LOGS_READ_TOOL_ID = "logs.read";

export function logsReadDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "logs__read",
      description:
        "Read entries from a specific day's run-log file. Each entry is a JSON object with a " +
        "'stage' field (intake, receptionist, recruiter, planner, dot-start, dot-complete, error, etc.), " +
        "a 'messageId', and stage-specific data. Use 'tail' to read only the most recent N entries.",
      parameters: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "The log filename to read, e.g. '2026-02-16.log'. Get available files from logs.list.",
          },
          tail: {
            type: "number",
            description: "Only return the last N entries (most recent). Omit to read all entries.",
          },
        },
        required: ["filename"],
      },
    },
  };
}

export function logsReadHandler(): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>) => {
    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);
    if (!deviceId) return "No local agent connected — cannot read logs.";

    const result = await sendMemoryRequest(deviceId, {
      action: "read_run_log",
      data: { filename: args.filename, tail: args.tail },
    } as MemoryRequest);

    if (!result) return "Failed to read log file.";
    if (result.error) return `Error: ${result.error}`;

    return JSON.stringify(result, null, 2);
  };
}

// ============================================
// LOGS.SEARCH
// ============================================

export const LOGS_SEARCH_TOOL_ID = "logs.search";

export function logsSearchDefinition(): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "logs__search",
      description:
        "Search across all run-log files for entries matching a keyword. Useful for finding errors, " +
        "specific stages, message IDs, or tool names. Returns up to 50 matching entries across all days.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search term (case-insensitive). Examples: 'error', 'dot-complete', a messageId, " +
              "a tool name, or any text that might appear in log entries.",
          },
        },
        required: ["query"],
      },
    },
  };
}

export function logsSearchHandler(): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>) => {
    const userId = ctx.state.userId as string;
    const deviceId = getDeviceForUser(userId);
    if (!deviceId) return "No local agent connected — cannot search logs.";

    const result = await sendMemoryRequest(deviceId, {
      action: "search_run_logs",
      query: args.query,
    } as MemoryRequest);

    if (!result) return "Failed to search logs.";
    if (result.error) return `Error: ${result.error}`;

    if (result.matchCount === 0) {
      return `No log entries matched "${args.query}". Try a broader search term, or use logs.list to check which days have logs.`;
    }

    return JSON.stringify(result, null, 2);
  };
}
