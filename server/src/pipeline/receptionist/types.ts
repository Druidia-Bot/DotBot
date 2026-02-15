/**
 * Receptionist — Shared Types
 */

import type { EnhancedPromptRequest } from "../../types/agent.js";
import type { ClassifyResult } from "../intake/intake.js";

export interface ReceptionistResult {
  agentId: string;
  workspacePath: string;
  knowledgebasePath: string;
  resurfacedModels: string[];
  newModelsCreated: string[];
  knowledgeGathered: number;
  /** Full content of intake_knowledge.md (includes all sections: memory, files, web, polymarket) */
  intakeKnowledgebase: string;
}

export interface KnowledgebaseInput {
  agentId: string;
  request: EnhancedPromptRequest;
  intakeResult: ClassifyResult;
  relevantModelSummaries: string;
  knowledgeResults: { query: string; content: string }[];
  knowledgeSearchCount: number;
  resurfacedModels: string[];
  newModelsCreated: string[];
  localFileResults?: { query: string; output: string }[];
  localFileSearchSkipReason?: string;
  webSearchResults?: { query: string; results: { title: string; url: string; description: string }[] }[];
  polymarketResults?: { query: string; markets: any[] }[];
}

export interface LoopResult {
  resurfacedModels: string[];
  newModelsCreated: string[];
  savedToModels: string[];
  knowledgeGathered: { query: string; content: string }[];
  knowledgeSearchCount: number;
}
