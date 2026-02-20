/**
 * Step Context — ToolContext Builder
 *
 * Builds the per-step ToolContext with server-side executor wiring
 * (imagegen, premium, schedule). Each step gets a fresh context so
 * handlers can stash side effects without cross-step contamination.
 */

import { nanoid } from "nanoid";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import type { ToolContext } from "#tool-loop/types.js";
import type { ILLMClient } from "#llm/types.js";

export interface StepContextDeps {
  deviceId: string;
  userId: string;
  workspacePath: string;
  stepId: string;
  restatedRequest: string;
  client: ILLMClient;
}

export function buildStepContext(deps: StepContextDeps): ToolContext {
  const { deviceId, userId, workspacePath, stepId, restatedRequest, client } = deps;

  return {
    deviceId,
    state: {
      userPrompt: restatedRequest,
      stepId,
      toolCallsMade: [],
      llmClient: client,
      // Server-side imagegen executor — curried with executeCommand bridge
      executeImageGenTool: async (toolId: string, args: Record<string, any>) => {
        const { executeImageGenTool } = await import("#tools-server/imagegen/executor.js");
        const executeCommand = async (cmd: any) => {
          const cmdId = `imgcmd_${nanoid(8)}`;
          return sendExecutionCommand(deviceId, { id: cmdId, ...cmd });
        };
        return executeImageGenTool(toolId, args, executeCommand, `${workspacePath}/output`);
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
