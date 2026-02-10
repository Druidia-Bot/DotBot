/**
 * Agent Runner Types
 * 
 * Shared types for the agent pipeline. Extracted from runner.ts
 * so that other modules can import types without pulling in the full class.
 */

import type { CouncilReviewResult } from "../types.js";
import type { ExecutionCommand } from "../types.js";
import type {
  ThreadSummaryL1,
  ThreadPacket,
  PersonaDefinition,
  TaskProgressUpdate,
  UpdaterRecommendations,
} from "../types/agent.js";
import type { JournalEntry } from "./self-recovery.js";

// ============================================
// RUNNER OPTIONS
// ============================================

export interface AgentRunnerOptions {
  apiKey: string;
  provider?: "deepseek" | "anthropic" | "openai";

  // Callbacks for client communication
  onRequestThreadData?: (
    level: 1 | 2,
    threadIds: string[],
    councilId?: string
  ) => Promise<{
    summaries?: ThreadSummaryL1[];
    packets?: ThreadPacket[];
    personas?: PersonaDefinition[];
  }>;
  onSaveToThread?: (threadId: string, entry: any) => Promise<void>;
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

  // Council review — load a council definition from local-agent
  onLoadCouncil?: (slug: string) => Promise<import("../types.js").CouncilRuntime | null>;
  // Council review — per-provider API keys for council member model overrides
  councilApiKeys?: Partial<Record<string, string>>;

  // Skill discovery — search and read skills from local-agent
  onSearchSkills?: (query: string) => Promise<Array<{ slug: string; name: string; description: string; tags?: string[]; allowedTools?: string[] }>>;
  onReadSkill?: (slug: string) => Promise<{ slug: string; name: string; description: string; content: string } | null>;

  // Memory persistence — send model updates to local-agent for disk storage
  onPersistMemory?: (action: string, data: Record<string, any>) => Promise<any>;

  // Task tracking — persistent task log on local-agent
  onCreateTask?: (data: {
    description: string;
    priority?: "low" | "medium" | "high";
    threadId?: string;
    personaId?: string;
    originPrompt: string;
  }) => Promise<any>;
  onUpdateTask?: (taskId: string, updates: Record<string, any>) => Promise<any>;

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
  }) => void;
  onPlannerOutput?: (plan: any) => void;
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
  councilReview?: CouncilReviewResult;
  taskId?: string;
  error?: string;
  /** Serialized RunJournal — full pipeline trace for diagnostics */
  runLog?: { startTime: number; elapsedMs: number; entries: JournalEntry[] };
}
