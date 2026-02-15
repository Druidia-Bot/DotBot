/**
 * Planner — Types
 *
 * Data structures for the step-based execution pipeline.
 * The planner breaks a task into high-level steps, each executed
 * sequentially with workspace awareness and adaptive re-planning.
 */

import type { ClassifyResult } from "../intake/intake.js";
import type { RecruiterResult } from "../recruiter/types.js";

// ============================================
// PLANNER INPUT
// ============================================

export interface PlannerInput {
  /** Agent ID (same as receptionist's agentId) */
  agentId: string;
  /** Device ID for tool execution */
  deviceId: string;
  /** Workspace base path on the user's machine */
  workspacePath: string;
  /** Restated user request from intake */
  restatedRequest: string;
  /** Full content of intake_knowledge.md (includes all sections: memory, files, web, polymarket) */
  intakeKnowledgebase: string;
  /** Intake classification result */
  intakeResult: ClassifyResult;
  /** Recruiter output (custom prompt, tools, model role) */
  recruiterResult: RecruiterResult;
}

// ============================================
// STEP PLAN (LLM output)
// ============================================

export interface Step {
  /** Step identifier (e.g. "step-1", "step-2") */
  id: string;
  /** Short title (e.g. "Research competitors") */
  title: string;
  /** Detailed objective — what this step should accomplish */
  description: string;
  /** What success looks like (e.g. "A markdown file with 5 competitor profiles") */
  expectedOutput: string;
  /** Suggested tool IDs for this step (subset of persona's tools, not restrictive) */
  toolHints: string[];
  /** Whether this step needs external data (web, APIs, email, etc.) */
  requiresExternalData: boolean;
  /** Step IDs that must complete before this one (for future parallel execution) */
  dependsOn: string[];
}

export interface StepPlan {
  /** The overall approach summary */
  approach: string;
  /** Ordered list of steps */
  steps: Step[];
  /** Whether this is a simple single-step task (skip re-planning overhead) */
  isSimpleTask: boolean;
}

// ============================================
// STEP EXECUTION RESULTS
// ============================================

export interface StepResult {
  /** The step that was executed */
  step: Step;
  /** Whether the step completed successfully */
  success: boolean;
  /** The agent's response/output for this step */
  output: string;
  /** Tool calls made during this step */
  toolCallsMade: { tool: string; args: Record<string, string>; result: string; success: boolean }[];
  /** Number of tool loop iterations used */
  iterations: number;
  /** Files written to workspace during this step */
  filesCreated: string[];
  /** Whether the agent escalated (needs different tools/approach) */
  escalated?: boolean;
  /** Escalation reason if applicable */
  escalationReason?: string;
}

// ============================================
// TOOL CALL TRACKING (real-time, persisted to plan.json)
// ============================================

/** Lightweight record of a single tool call, written to plan.json in real-time. */
export interface ToolCallEntry {
  /** Dotted tool ID (e.g. "search.web", "filesystem.create_file") */
  toolId: string;
  /** ISO timestamp of when the call completed */
  timestamp: string;
  /** Whether the handler returned successfully */
  success: boolean;
  /** First ~200 chars of the result (enough to understand what happened) */
  resultSnippet: string;
  /** Workspace-relative path if the tool produced a persisted file (e.g. "research/search.web-2026-...txt") */
  outputPath?: string;
}

// ============================================
// RE-PLANNER (adaptive planning)
// ============================================

export interface ReplanResult {
  /** Updated remaining steps (can add, remove, or modify) */
  remainingSteps: Step[];
  /** Brief reasoning for any changes */
  reasoning: string;
  /** Whether the plan was changed */
  changed: boolean;
}

// ============================================
// STEP EXECUTOR OPTIONS
// ============================================

export interface StepExecutorOptions {
  /** LLM client for model resolution */
  llm: import("#llm/types.js").ILLMClient;
  /** User ID for premium credits and schedule ownership */
  userId: string;
  /** Device ID for tool execution on the local agent */
  deviceId: string;
  /** Agent ID for logging and workspace paths */
  agentId: string;
  /** Workspace base path on the user's machine */
  workspacePath: string;
  /** Custom system prompt from the persona picker */
  customPrompt: string;
  /** Validated tool IDs from the persona picker */
  selectedToolIds: string[];
  /** Model role hint from the persona picker */
  modelRole: string;
  /** The restated user request */
  restatedRequest: string;
  /** Tool manifest from the local agent */
  toolManifest: import("#tools/types.js").ToolManifestEntry[];
  /** Runtime environment info from local agent */
  runtimeInfo?: any[];
  /** Skip re-planning for simple tasks */
  skipReplan?: boolean;
}

// ============================================
// OVERALL EXECUTION RESULT
// ============================================

export interface PlannerExecutionResult {
  /** The final plan (may differ from initial if re-planned) */
  plan: StepPlan;
  /** Results from each executed step */
  stepResults: StepResult[];
  /** The final merged response to send to the user */
  finalResponse: string;
  /** Whether overall execution succeeded */
  success: boolean;
  /** Total tool calls across all steps */
  totalToolCalls: number;
  /** Total iterations across all steps */
  totalIterations: number;
}
