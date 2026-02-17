/**
 * Context — Shared Types
 *
 * Interfaces used across the context fetcher modules.
 */

export interface L0Index {
  models: any[];
  threads: any[];
  sessionSummary: string | null;
}

export interface MemoryState {
  l0Index: L0Index;
  priorHistory: { role: "user" | "assistant"; content: string }[];
  activeThreadId: string | null;
  activeTasks: any[];
  agentIdentity: string | undefined;
  backstory: string | undefined;
}

export interface ResearchCacheEntry {
  filename: string;
  source: string;
  type: string;
  tool: string;
  cachedAt: string;
  summary: string;
  title?: string;
  brief?: string;
  tags?: string[];
  relatedModels?: string[];
  enriched?: boolean;
  reviewed?: boolean;
  promoted?: boolean;
}
