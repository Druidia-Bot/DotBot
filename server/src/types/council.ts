/**
 * Council Review Types (Councils = Polishers)
 *
 * Types for the council-of-agents review system.
 */

import type { LLMProvider } from "./llm.js";

/**
 * A council member as loaded on the server for execution.
 * Combines persona info + council-specific overrides.
 */
export interface CouncilMemberRuntime {
  personaSlug: string;
  councilRole: string;
  sequence: number;
  required: boolean;
  systemPrompt: string;                   // From the persona
  reviewFocus?: string;                    // Council-specific review lens
  providerOverride?: LLMProvider;
  modelOverride?: string;
}

/**
 * A council definition as loaded on the server for execution.
 */
export interface CouncilRuntime {
  slug: string;
  name: string;
  mission: string;
  principles: { id: string; title: string; description: string; priority: number }[];
  members: CouncilMemberRuntime[];
  executionMode: "single_pass" | "iterative";
  maxIterations: number;                   // Default 3
}

/**
 * What each council member returns after reviewing work.
 */
export interface CouncilVerdict {
  memberSlug: string;
  councilRole: string;
  approved: boolean;
  feedback: string;
  suggestedChanges?: string;
  confidence: number;                      // 0-1
  duration: number;                        // ms
}

/**
 * A single iteration of the council review loop.
 */
export interface CouncilIteration {
  round: number;
  verdicts: CouncilVerdict[];
  allRequiredApproved: boolean;
  revisedOutput?: string;                  // If work was revised based on feedback
}

/**
 * The full result of a council review pass.
 */
export interface CouncilReviewResult {
  councilSlug: string;
  approved: boolean;                       // All required members approved
  iterations: CouncilIteration[];
  totalIterations: number;
  finalOutput: string;                     // The polished output
  combinedFeedback: string;                // Summary of all feedback
}
