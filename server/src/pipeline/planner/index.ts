/**
 * Planner Module — Barrel Export
 *
 * Step-based task execution pipeline with adaptive re-planning.
 *
 * Structure:
 *   types.ts        — All type definitions
 *   planning/       — LLM-driven plan creation & re-planning
 *   execution/      — Step execution orchestration
 *   workspace/      — Workspace I/O, progress tracking, handoff
 *   prompts/        — Prompt templates (.md) and JSON schemas
 */

// Types
export type {
  PlannerInput,
  Step,
  StepPlan,
  StepResult,
  ToolCallEntry,
  ReplanResult,
  StepExecutorOptions,
  PlannerExecutionResult,
} from "./types.js";

// Planning
export { createPlan } from "./planning/index.js";
export { replan } from "./planning/index.js";

// Execution
export { executeSteps } from "./execution/index.js";

// Workspace
export {
  updatePlanProgress,
  saveStepOutput,
  buildToolCallEntry,
  buildHandoffBrief,
  buildFinalResponse,
  listWorkspaceFiles,
  buildWorkspaceBriefing,
  buildStepUserMessage,
} from "./workspace/index.js";
