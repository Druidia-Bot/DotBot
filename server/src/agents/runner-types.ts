/**
 * Agent Runner Types
 * 
 * Shared types for the agent pipeline. Extracted from runner.ts
 * so that other modules can import types without pulling in the full class.
 */

import type { ExecutionCommand } from "../types.js";
import type {
  PersonaDefinition,
  TaskProgressUpdate,
  UpdaterRecommendations,
} from "../types/agent.js";

// ============================================
// RUNNER OPTIONS
// ============================================

export interface AgentRunnerOptions {
  apiKey: string;
  provider?: "deepseek" | "anthropic" | "openai";

  // Callbacks for client communication
  onTaskProgress?: (update: TaskProgressUpdate) => void;
  onStream?: (personaId: string, chunk: string, done: boolean) => void;
  onThreadUpdate?: (threadId: string, updates: UpdaterRecommendations) => void;

  // Tool execution callback — sends commands to local-agent via WebSocket
  onExecuteCommand?: (command: ExecutionCommand) => Promise<string>;

  // Dynamic tool manifest from local agent's plugin registry
  toolManifest?: any[];

  // Runtime environment info from local agent (python, git, etc.)
  runtimeInfo?: any[];

  // Server-side premium tool executor (bypasses local agent)
  onExecutePremiumTool?: (toolId: string, args: Record<string, any>) => Promise<{ success: boolean; output: string; error?: string }>;

  // Server-side image generation executor (Gemini/OpenAI)
  onExecuteImageGenTool?: (toolId: string, args: Record<string, any>, executeCommand: (cmd: ExecutionCommand) => Promise<string>) => Promise<{ success: boolean; output: string; error?: string }>;

  // Server-side knowledge ingestion (Gemini Files API + processing)
  onExecuteKnowledgeIngest?: (toolId: string, args: Record<string, any>) => Promise<{ success: boolean; output: string; error?: string }>;

  // Server-side schedule tool executor (recurring tasks in SQLite)
  onExecuteScheduleTool?: (toolId: string, args: Record<string, any>) => Promise<{ success: boolean; output: string; error?: string }>;

  // Server-side research artifact tool executor (workspace file management)
  onExecuteResearchTool?: (toolId: string, args: Record<string, any>, executeCommand: (cmd: ExecutionCommand) => Promise<string>) => Promise<{ success: boolean; output: string; error?: string }>;

  // Skill discovery — search and read skills from local-agent
  onSearchSkills?: (query: string) => Promise<Array<{ slug: string; name: string; description: string; tags?: string[]; allowedTools?: string[] }>>;
  onReadSkill?: (slug: string) => Promise<{ slug: string; name: string; description: string; content: string } | null>;

  // Memory persistence — send model updates to local-agent for disk storage
  onPersistMemory?: (action: string, data: Record<string, any>) => Promise<any>;

  // Debug callbacks for client visibility
  onLLMRequest?: (info: {
    persona: string;
    provider: string;
    model: string;
    promptLength: number;
    maxTokens: number;
    messages: { role: string; content: string }[];
  }) => void;
  onLLMResponse?: (info: {
    persona: string;
    duration: number;
    responseLength: number;
    response: string;
    /** Model ID used for this call (for token tracking) */
    model?: string;
    /** Provider used for this call (for token tracking) */
    provider?: string;
    /** Input tokens consumed (from LLM response usage) */
    inputTokens?: number;
    /** Output tokens consumed (from LLM response usage) */
    outputTokens?: number;
  }) => void;

  // V2: Per-agent lifecycle notifications (orchestrator → client)
  onAgentStarted?: (info: {
    agentId: string;
    topic: string;
    agentRole: string;
    toolCount: number;
  }) => void;
  onAgentComplete?: (info: {
    agentId: string;
    topic: string;
    agentRole: string;
    success: boolean;
    response: string;
  }) => void;
}

// ============================================
// RUNNER RESULT
// ============================================

export interface AgentRunResult {
  success: boolean;
  response: string;
  classification: import("../types/agent.js").RequestType;
  threadIds: string[];
  keyPoints: string[];
  taskId?: string;
  error?: string;
}
