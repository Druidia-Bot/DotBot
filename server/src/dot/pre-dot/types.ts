/**
 * Pre-Dot Types
 *
 * Shared types for the pre-Dot processing pipeline:
 * principle loading, tailor (pass 1), and consolidator (pass 2).
 */

export interface PrincipleFile {
  id: string;
  summary: string;
  always: boolean;
  body: string;
}

export interface TopicSegment {
  /** The portion of the user's message that relates to this topic */
  text: string;
  /** Model slug this segment maps to, or null for general/no-model topics */
  modelSlug: string | null;
  /** 0-4 manufactured history turns specific to this topic */
  history: { role: "user" | "assistant"; content: string }[];
}

export interface TailorResult {
  /** The user's request restated with ambiguous references resolved from conversation context */
  restatedRequest: string | null;
  /** Complexity score 0-10 (0-2 chat, 3-4 single tool, 5-6 multi-step, 7-8 research, 9-10 project) */
  complexity: number | null;
  /** Filenames of research cache entries relevant to this request */
  relevantCache: string[];
  /** Slugs of memory models relevant to this request */
  relevantModels: string[];
  /** 2-4 topic-relevant turns distilled from conversation history for the relevant model */
  manufacturedHistory: { role: "user" | "assistant"; content: string }[];
  /** When 2+ models are relevant, the user's message split into per-topic segments */
  topicSegments: TopicSegment[];
  /** Map of principle id → tailored directive or null if not applicable */
  tailored: Record<string, string | null>;
  /** Raw principle files that were loaded (for fallback) */
  principles: PrincipleFile[];
}
