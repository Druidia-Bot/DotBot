/**
 * Runner Factory
 * 
 * Creates configured AgentRunner instances with all callbacks wired up
 * to the WebSocket device bridge (streaming, memory, tools, etc.).
 * 
 * Also contains helpers for persisting agent work threads and run logs.
 * 
 * Extracted from server.ts to keep concerns separated.
 */

import { nanoid } from "nanoid";
import { AgentRunner } from "../agents/runner.js";
import type { AgentRunResult } from "../agents/runner.js";
import { createComponentLogger } from "../logging.js";
import type {
  EnhancedPromptRequest,
  TaskProgressUpdate,
  UpdaterRecommendations,
} from "../types/agent.js";
import {
  devices,
  sendMessage,
  broadcastToUser,
  getDeviceForUser,
  getTempDirForUser,
  type MemoryRequest,
} from "./devices.js";
import {
  sendExecutionCommand,
  sendMemoryRequest,
  sendSkillRequest,
} from "./device-bridge.js";
import { recordTokenUsage } from "../agents/token-tracker.js";

const log = createComponentLogger("ws.runner");

// ============================================
// RUNNER FACTORY
// ============================================

export function createRunner(
  apiKey: string,
  userId: string,
  toolManifest: any[],
  runtimeInfo: any[],
  serverProvider: string,
  agentTaskId?: string
): AgentRunner {
  // Track whether this background agent has sent its first stream chunk
  // so we can prefix with the persona label once.
  let agentStreamStarted = false;

  return new AgentRunner({
    apiKey,
    provider: serverProvider as "deepseek" | "anthropic" | "openai",
    toolManifest,
    runtimeInfo,
    onStream: (personaId: string, chunk: string, done: boolean) => {
      // For background agents, prefix the first chunk with [personaId] so the
      // user can tell which agent is speaking in the main chat thread.
      let content = chunk;
      if (agentTaskId && !agentStreamStarted && chunk.trim()) {
        content = `**[${personaId}]** ${chunk}`;
        agentStreamStarted = true;
      }
      // Broadcast to all user devices so reconnected browsers still receive chunks
      broadcastToUser(userId, {
        type: "stream_chunk",
        id: nanoid(),
        timestamp: Date.now(),
        payload: { personaId, content, done }
      });
    },
    onTaskProgress: (update: TaskProgressUpdate) => {
      broadcastToUser(userId, {
        type: "task_progress",
        id: nanoid(),
        timestamp: Date.now(),
        payload: agentTaskId ? { ...update, taskId: agentTaskId } : update
      });
      // V2: Progress tracking handled by supervisor, not watchdog
    },
    onThreadUpdate: (threadId: string, updates: UpdaterRecommendations) => {
      broadcastToUser(userId, {
        type: "thread_update",
        id: nanoid(),
        timestamp: Date.now(),
        payload: { threadId, updates }
      });
    },
    onCouncilStream: (event: { type: string; data: any }) => {
      // Stream council turns, consensus checks, and synthesis status in real-time
      broadcastToUser(userId, {
        type: event.type as "council_turn" | "council_consensus" | "council_synthesis",
        id: nanoid(),
        timestamp: Date.now(),
        payload: event.data
      });
    },
    onLLMRequest: (info) => {
      broadcastToUser(userId, {
        type: "llm_request", id: nanoid(), timestamp: Date.now(), payload: info
      });
    },
    onLLMResponse: (info) => {
      broadcastToUser(userId, {
        type: "llm_response", id: nanoid(), timestamp: Date.now(), payload: info
      });
      // Record token usage to SQLite (fire-and-forget)
      if (info.inputTokens || info.outputTokens) {
        const deviceId = getDeviceForUser(userId);
        if (deviceId) {
          recordTokenUsage({
            deviceId,
            model: info.model || "unknown",
            role: info.persona,
            inputTokens: info.inputTokens || 0,
            outputTokens: info.outputTokens || 0,
          });
        }
      }
    },
    onExecuteCommand: async (command) => {
      const agentDeviceId = getDeviceForUser(userId);
      if (!agentDeviceId) throw new Error("No local-agent connected to execute commands");
      return sendExecutionCommand(agentDeviceId, command);
    },
    onExecutePremiumTool: async (toolId, args) => {
      const { executePremiumTool } = await import("../credits/premium-tools.js");
      return executePremiumTool(userId, toolId, args);
    },
    onExecuteImageGenTool: async (toolId, args, execCmd) => {
      const { executeImageGenTool } = await import("../imagegen/index.js");
      const tempDir = getTempDirForUser(userId);
      return executeImageGenTool(toolId, args, execCmd, tempDir);
    },
    onExecuteKnowledgeIngest: async (toolId, args) => {
      const { getApiKeyForProvider } = await import("../llm/model-selector.js");
      const geminiKey = getApiKeyForProvider("gemini");
      if (!geminiKey) {
        return { success: false, output: "", error: "Gemini API key not configured. Knowledge ingestion requires a Gemini API key for document processing." };
      }

      const source = args.source || args.url;
      const isUrl = !source || /^https?:\/\//i.test(source);

      // Local file path — agent uploads directly to server HTTP endpoint
      if (!isUrl && source) {
        const agentDeviceId = getDeviceForUser(userId);
        if (!agentDeviceId) {
          return { success: false, output: "", error: "No local agent connected to read local files" };
        }

        const publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || "3000"}`;
        const uploadUrl = `${publicUrl}/api/ingest-upload`;

        try {
          const uploadCommand = {
            id: `cmd_${nanoid(12)}`,
            type: "tool_execute" as const,
            payload: {
              toolId: "filesystem.upload_file",
              toolArgs: { path: source, uploadUrl, source },
            },
            dryRun: false,
            timeout: 300_000, // 5 min for large files + Gemini processing
            sandboxed: false,
            requiresApproval: false,
          };
          const uploadResult = await sendExecutionCommand(agentDeviceId, uploadCommand);

          // The upload endpoint returns JSON directly — parse and return
          try {
            const parsed = JSON.parse(uploadResult);
            if (!parsed.success) {
              return { success: false, output: "", error: parsed.error || "Upload processing failed" };
            }
            return { success: true, output: JSON.stringify(parsed, null, 2) };
          } catch {
            // If not valid JSON, return raw output
            return { success: true, output: uploadResult };
          }
        } catch (err) {
          return { success: false, output: "", error: `Failed to upload local file: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      const { executeKnowledgeIngest } = await import("../knowledge/ingest.js");
      return executeKnowledgeIngest(args, geminiKey);
    },
    onExecuteScheduleTool: async (toolId, args) => {
      const { executeScheduleTool } = await import("../scheduler/index.js");
      return executeScheduleTool(userId, toolId, args);
    },
    onExecuteResearchTool: async (toolId, args, executeCommand) => {
      const { executeResearchTool } = await import("../scheduler/index.js");
      // agentTaskId is the agent ID for the current execution
      const currentAgentId = agentTaskId || `temp_${nanoid()}`;
      return executeResearchTool(currentAgentId, toolId, args, executeCommand);
    },
    onSearchSkills: async (query) => {
      const agentDeviceId = getDeviceForUser(userId);
      if (!agentDeviceId) return [];
      try {
        return await sendSkillRequest(agentDeviceId, { action: "search_skills", query });
      } catch { return []; }
    },
    onReadSkill: async (slug) => {
      const agentDeviceId = getDeviceForUser(userId);
      if (!agentDeviceId) return null;
      try {
        return await sendSkillRequest(agentDeviceId, { action: "get_skill", skillSlug: slug });
      } catch { return null; }
    },
    onPersistMemory: async (action, data) => {
      const agentDeviceId = getDeviceForUser(userId);
      if (!agentDeviceId) { log.warn("No local-agent connected for memory persistence"); return null; }
      return sendMemoryRequest(agentDeviceId, {
        action, modelSlug: data.slug, data,
      } as MemoryRequest);
    },
    // V2: Per-agent lifecycle notifications
    onAgentStarted: (info) => {
      broadcastToUser(userId, {
        type: "agent_started",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          taskId: info.agentId,
          taskName: info.topic,
          personaId: info.agentRole,
          agentRole: info.agentRole,
          toolCount: info.toolCount,
        }
      });
    },
    onAgentComplete: (info) => {
      broadcastToUser(userId, {
        type: "agent_complete",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          taskId: info.agentId,
          success: info.success,
          response: info.response,
          agentRole: info.agentRole,
          classification: "ACTION",
          threadIds: [],
          keyPoints: [],
        }
      });
    },
  });
}

// ============================================
// HELPER: Persist agent work thread to local agent
// ============================================

