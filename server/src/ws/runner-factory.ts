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
import { selectModel, createClientForSelection } from "../llm/providers.js";
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
import {
  getTaskById,
  recordTaskActivity,
  setWatchdogLLM,
} from "../agents/agent-tasks.js";

const log = createComponentLogger("ws.runner");

let watchdogLLMInitialized = false;

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
  // Initialize watchdog LLM once (cheap workhorse call for investigation)
  if (!watchdogLLMInitialized) {
    try {
      const watchdogConfig = selectModel({});
      const watchdogClient = createClientForSelection(watchdogConfig);
      setWatchdogLLM(watchdogClient);
      watchdogLLMInitialized = true;
    } catch { /* non-fatal */ }
  }

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
      // Feed activity to the watchdog so it knows the agent is alive
      if (agentTaskId && update.message) {
        recordTaskActivity(agentTaskId, update.message);
      }
    },
    onRequestThreadData: async (level: 1 | 2, threadIds: string[], councilId?: string) => {
      const agentId = getDeviceForUser(userId);
      if (!agentId) return { summaries: [], packets: [], personas: [] };

      try {
        if (level === 1) {
          const summaries = [];
          for (const threadId of threadIds) {
            const detail = await sendMemoryRequest(agentId, {
              action: "get_thread_detail",
              data: { threadId },
            } as MemoryRequest);
            if (detail) {
              summaries.push({
                id: detail.id || threadId,
                topic: detail.topic || "",
                keywords: detail.keywords || [],
                lastMessage: (detail.messages?.slice(-1)[0]?.content || "").substring(0, 100),
                openLoopCount: detail.openLoops?.length || 0,
                beliefCount: detail.beliefs?.length || 0,
              });
            }
          }
          return { summaries, packets: [], personas: [] };
        } else {
          const packets = [];
          for (const threadId of threadIds) {
            const detail = await sendMemoryRequest(agentId, {
              action: "get_thread_detail",
              data: { threadId },
            } as MemoryRequest);
            if (detail) packets.push(detail);
          }
          return { summaries: [], packets, personas: [] };
        }
      } catch (err) {
        log.warn("Failed to fetch thread data from local agent", { error: err });
        return { summaries: [], packets: [], personas: [] };
      }
    },
    onSaveToThread: async (threadId: string, entry: any) => {
      const agentDeviceId = getDeviceForUser(userId);
      if (!agentDeviceId) { log.warn("No local-agent connected for thread persistence"); return; }
      const agentDevice = devices.get(agentDeviceId);
      if (!agentDevice) return;
      sendMessage(agentDevice.ws, {
        type: "save_to_thread",
        id: nanoid(),
        timestamp: Date.now(),
        payload: {
          threadId,
          createIfMissing: true,
          newThreadTopic: entry.topic,
          entry: { role: entry.role, content: entry.content },
        },
      });
    },
    onThreadUpdate: (threadId: string, updates: UpdaterRecommendations) => {
      broadcastToUser(userId, {
        type: "thread_update",
        id: nanoid(),
        timestamp: Date.now(),
        payload: { threadId, updates }
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
    },
    onPlannerOutput: (plan) => {
      broadcastToUser(userId, {
        type: "planner_output", id: nanoid(), timestamp: Date.now(), payload: plan
      });
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
    onCreateTask: async (data) => {
      const agentDeviceId = getDeviceForUser(userId);
      if (!agentDeviceId) { log.warn("No local-agent connected for task tracking"); return null; }
      return sendMemoryRequest(agentDeviceId, {
        action: "create_task", data,
      } as MemoryRequest);
    },
    onUpdateTask: async (taskId, updates) => {
      const agentDeviceId = getDeviceForUser(userId);
      if (!agentDeviceId) { log.warn("No local-agent connected for task tracking"); return null; }
      return sendMemoryRequest(agentDeviceId, {
        action: "update_task", data: { taskId, ...updates },
      } as MemoryRequest);
    },
  });
}

// ============================================
// HELPER: Persist agent work thread to local agent
// ============================================

export function sendAgentWork(
  userId: string,
  agentTaskId: string,
  entryType: "started" | "tool_call" | "tool_result" | "iteration" | "completed" | "failed",
  data: Record<string, any>
): void {
  const agentDeviceId = getDeviceForUser(userId);
  if (!agentDeviceId) return;

  const device = devices.get(agentDeviceId);
  if (!device) return;

  sendMessage(device.ws, {
    type: "save_agent_work",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      agentTaskId,
      entry: {
        type: entryType,
        timestamp: Date.now(),
        ...data,
      },
    },
  });
}

// ============================================
// HELPER: Send run log
// ============================================

export function sendRunLog(
  userId: string,
  messageId: string,
  request: EnhancedPromptRequest,
  result: AgentRunResult
): void {
  if (!result.runLog) return;
  broadcastToUser(userId, {
    type: "run_log",
    id: nanoid(),
    timestamp: Date.now(),
    payload: {
      sessionId: messageId,
      prompt: request.prompt.substring(0, 200),
      success: result.success,
      classification: result.classification,
      taskId: result.taskId,
      runLog: result.runLog,
    }
  });
}
