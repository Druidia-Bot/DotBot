/**
 * Condenser — Shared Types
 */

import type { ExecutionCommand } from "../types.js";
import type { ToolManifestEntry } from "../agents/tools.js";

export interface CondenserOptions {
  apiKey: string;
  provider?: "deepseek" | "anthropic" | "openai";
}

export interface CondenserRequest {
  thread: any;
  modelIndex: { slug: string; name: string; category: string; keywords: string[] }[];
  relevantModels: any[];
  lastCycleAt?: string;
  identity?: string;
}

export interface CondenserResult {
  instructions: any[];
  reasoning: string;
}

export interface LoopResolverRequest {
  loop: any;
  modelSlug: string;
  modelName: string;
  contextBeliefs: { attribute: string; value: any }[];
  availableTools: string[];
  identity?: string;
}

export interface LoopResolverToolOptions {
  executeCommand: (command: ExecutionCommand) => Promise<string>;
  toolManifest: ToolManifestEntry[];
}

export interface LoopResolverResult {
  resolved: boolean;
  resolution?: string;
  blockedReason?: string;
  notifyUser: boolean;
  notification?: string;
  newStatus: "resolved" | "blocked" | "investigating";
  sideEffects?: any[];
}
