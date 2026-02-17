/**
 * Condenser — Shared Types
 */

import type { ExecutionCommand } from "../../types.js";
import type { ToolManifestEntry } from "#tools/types.js";

export interface CondenserOptions {
  // No longer needs apiKey/provider — uses createClientForSelection
  // with full fallback chains via the resilient client system.
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
