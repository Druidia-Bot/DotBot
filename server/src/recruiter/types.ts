/**
 * Recruiter — Shared Types
 *
 * The recruiter owns the full persona lifecycle:
 * fetch → register → match triggers → select → write custom prompt + tools.
 */

import type { ClassifyResult } from "../intake/intake.js";
import type { ToolManifestEntry } from "../agents/tools.js";

// ============================================
// INPUT
// ============================================

export interface RecruiterInput {
  agentId: string;
  deviceId: string;
  workspacePath: string;
  intakeResult: ClassifyResult;
  /** Restated user request from intake (resolved references) */
  restatedRequest: string;
  /** Full content of intake_knowledge.md (includes all sections: memory, files, web, polymarket) */
  intakeKnowledgebase: string;
  /** Tool manifest from context builder — passed through pipeline, not re-fetched */
  toolManifest: ToolManifestEntry[];
  /** Link to predecessor agent when continuing in same workspace (queue execution) */
  previousAgentId?: string;
}

// ============================================
// LLM RESPONSE
// ============================================

/** Phase 1: persona/council selection + model role */
export interface RecruiterPhase1Response {
  selectedPersonas: {
    id: string;
    reason: string;
  }[];
  council: string | null;
  modelRole: "workhorse" | "deep_context" | "architect" | "gui_fast";
}

/** Phase 2: custom prompt + tool selection (after reading full persona files) */
export interface RecruiterPhase2Response {
  customPrompt: string;
  tools: string[];
}

/** Combined result from both phases */
export interface RecruiterLLMResponse {
  selectedPersonas: {
    id: string;
    reason: string;
  }[];
  council: string | null;
  customPrompt: string;
  tools: string[];
  modelRole: "workhorse" | "deep_context" | "architect" | "gui_fast";
}

// ============================================
// OUTPUT
// ============================================

export interface RecruiterResult {
  agentId: string;
  personaPath: string;
  selectedPersonas: { id: string; reason: string }[];
  council: string | null;
  /** The custom system prompt written by the recruiter */
  customPrompt: string;
  /** Validated tool IDs selected for this task */
  tools: string[];
  modelRole: string;
}
