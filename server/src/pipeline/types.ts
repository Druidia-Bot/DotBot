/**
 * Pipeline Types — Shared interfaces and constants for the pipeline modules.
 */

import type { ILLMClient } from "#llm/types.js";
import type { ClassifyResult } from "./intake/intake.js";
import type { ToolManifestEntry } from "#tools/types.js";

// ============================================
// PIPELINE OPTIONS & RESULT
// ============================================

export interface PipelineOptions {
  llm: ILLMClient;
  userId: string;
  deviceId: string;
  prompt: string;
  messageId: string;
  source: string;
  onIntakeComplete?: (intakeResult: ClassifyResult) => void | Promise<void>;
}

export interface PipelineResult {
  intakeResult: ClassifyResult;
  shortCircuited?: boolean;
  agentId?: string;
  workspacePath?: string;
  knowledgebasePath?: string;
  personaPath?: string;
  resurfacedModels: string[];
  newModelsCreated: string[];
  knowledgeGathered: number;
  /** Final response from the planner step executor (if execution ran) */
  executionResponse?: string;
  /** Whether the planner execution succeeded */
  executionSuccess?: boolean;
}

// ============================================
// CONSTANTS
// ============================================

// Fast-path thresholds: skip receptionist when context is rich and task is not automatable
export const FAST_PATH_CONTEXT_THRESHOLD = 0.9;
export const FAST_PATH_AUTOMATABLE_CEILING = 0.4;

// ============================================
// ROUTING TYPES
// ============================================

export interface AgentRoutingResult {
  decision: string;
  targetAgentId?: string;
  reasoning: string;
  ackMessage?: string;
  /** For 'continue' decisions — workspace path to reuse for immediate execution */
  workspacePath?: string;
}

// ============================================
// QUEUE EXECUTION TYPES
// ============================================

export interface QueueExecutionOptions {
  llm: ILLMClient;
  userId: string;
  deviceId: string;
  messageId: string;
  previousAgentId: string;
  workspacePath: string;
  toolManifest: ToolManifestEntry[];
  intakeResult: ClassifyResult;
  queuedTasks: Array<{ id: string; request: string; addedAt: string }>;
}
