/**
 * Dot Tool Context — Server-Side Executor Wiring
 *
 * Builds the ToolContext that Dot's tool loop needs, wiring up
 * server-side executors for image generation, premium tools, and scheduling.
 */

import { nanoid } from "nanoid";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import type { ToolContext } from "#tool-loop/types.js";
import type { ILLMClient } from "#llm/types.js";

export function buildDotToolContext(opts: {
  deviceId: string;
  userId: string;
  client: ILLMClient;
}): ToolContext {
  const { deviceId, userId, client } = opts;

  return {
    deviceId,
    state: {
      userId,
      llmClient: client,
      // Server-side imagegen executor
      executeImageGenTool: async (toolId: string, args: Record<string, any>) => {
        const { executeImageGenTool } = await import("#tools-server/imagegen/executor.js");
        const executeCommand = async (cmd: any) => {
          const cmdId = `imgcmd_${nanoid(8)}`;
          return sendExecutionCommand(deviceId, { id: cmdId, ...cmd });
        };
        return executeImageGenTool(toolId, args, executeCommand);
      },
      // Server-side premium executor
      executePremiumTool: async (toolId: string, args: Record<string, any>) => {
        const { executePremiumTool } = await import("#tools-server/premium/executor.js");
        return executePremiumTool(userId, toolId, args, deviceId);
      },
      // Server-side schedule executor
      executeScheduleTool: async (toolId: string, args: Record<string, any>) => {
        const { executeScheduleTool } = await import("#tools-server/schedule/executor.js");
        return executeScheduleTool(userId, toolId, args);
      },
    },
  };
}
