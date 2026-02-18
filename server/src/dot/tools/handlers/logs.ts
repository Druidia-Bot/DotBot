/**
 * Handlers: logs.list, logs.read, logs.search
 */

import { sendMemoryRequest } from "#ws/device-bridge.js";
import { getDeviceForUser } from "#ws/devices.js";
import type { MemoryRequest } from "#ws/devices.js";
import type { ToolHandler, ToolContext } from "#tool-loop/types.js";

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
