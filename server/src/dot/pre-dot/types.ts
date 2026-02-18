/**
 * Pre-Dot Types
 *
 * Shared types for the pre-Dot processing pipeline:
 * principle loading, tailor (pass 1), and consolidator (pass 2).
 */

export interface PrincipleFile {
  id: string;
  summary: string;
  /** "rule" = always-on, "principle" = task-selected */
  type: "rule" | "principle";
  /** Comma-separated trigger keywords/conditions for principle selection (only for type: principle) */
  triggers: string[];
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

export interface RelevantMemory {
  name: string;
  confidence: number;
}

export interface TailorResult {
  /** The user's request restated with ambiguous references resolved from conversation context */
  restatedRequest: string | null;
  /** Complexity score 0-10 (0-2 chat, 3-4 single tool, 5-6 multi-step, 7-8 research, 9-10 project) */
  complexity: number | null;
  /** How confident the tailor is that it understands the full context (0.0-1.0) */
  contextConfidence: number | null;
  /** Filenames of research cache entries relevant to this request */
  relevantCache: string[];
  /** Memory models relevant to this request with confidence scores */
  relevantMemories: RelevantMemory[];
  /** Slugs of memory models relevant to this request (derived from relevantMemories) */
  relevantModels: string[];
  /** 2-4 topic-relevant turns distilled from conversation history for the relevant model */
  manufacturedHistory: { role: "user" | "assistant"; content: string }[];
  /** When 2+ models are relevant, the user's message split into per-topic segments */
  topicSegments: TopicSegment[];
  /** 2-4 focused keywords for skill library search (only when complexity >= 4) */
  skillSearchQuery: string | null;
  /** Short engagement message to send immediately while skills are searched (only when complexity >= 4) */
  skillFeedback: string | null;
}
