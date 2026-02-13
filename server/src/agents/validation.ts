/**
 * Agent Output Validation
 *
 * Validates structured outputs from LLM agents to prevent malformed
 * responses from breaking the pipeline.
 *
 * Critical for receptionist decisions where invalid JSON can cause
 * garbage text to be sent to users.
 */

import { createComponentLogger } from "../logging.js";
import type { ReceptionistDecision, RequestType, PriorityTag } from "../types/agent.js";

const log = createComponentLogger("validation");

// ============================================
// TYPE GUARDS
// ============================================

const VALID_REQUEST_TYPES = new Set<RequestType>([
  "CONVERSATIONAL",
  "INFO_REQUEST",
  "ACTION",
  "CLARIFICATION",
  "CONTINUATION",
  "CORRECTION",
  "CANCELLATION",
  "STATUS_CHECK",
  "MEMORY_UPDATE",
  "PREFERENCE",
  "FEEDBACK",
  "COMPOUND",
  "DEFERRED",
  "DELEGATION",
]);

const VALID_PRIORITY_TAGS = new Set<PriorityTag>([
  "URGENT",
  "BLOCKING",
  "BACKGROUND",
  "SCHEDULED",
]);

const VALID_MEMORY_ACTIONS = new Set(["none", "session_only", "model_update", "model_create"]);

/**
 * Validates that the receptionist returned a proper JSON decision object,
 * not raw text or malformed output.
 *
 * Returns true if valid, false if the output is garbage and should be rejected.
 */
export function validateReceptionistDecision(output: any): output is ReceptionistDecision {
  // Type check: must be an object
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    log.error("Receptionist output is not an object", { type: typeof output, isArray: Array.isArray(output) });
    return false;
  }

  // Required fields
  if (!output.classification || typeof output.classification !== "string") {
    log.error("Missing or invalid 'classification' field", { classification: output.classification });
    return false;
  }

  if (!VALID_REQUEST_TYPES.has(output.classification)) {
    log.error("Invalid classification value", { classification: output.classification });
    return false;
  }

  if (!output.priority || typeof output.priority !== "string") {
    log.error("Missing or invalid 'priority' field", { priority: output.priority });
    return false;
  }

  if (!VALID_PRIORITY_TAGS.has(output.priority)) {
    log.error("Invalid priority value", { priority: output.priority });
    return false;
  }

  if (typeof output.confidence !== "number" || output.confidence < 0 || output.confidence > 1) {
    log.error("Missing or invalid 'confidence' field", { confidence: output.confidence });
    return false;
  }

  if (!Array.isArray(output.threadIds)) {
    log.error("Missing or invalid 'threadIds' field", { threadIds: output.threadIds });
    return false;
  }

  if (typeof output.createNewThread !== "boolean") {
    log.error("Missing or invalid 'createNewThread' field", { createNewThread: output.createNewThread });
    return false;
  }

  if (typeof output.councilNeeded !== "boolean") {
    log.error("Missing or invalid 'councilNeeded' field", { councilNeeded: output.councilNeeded });
    return false;
  }

  if (!output.reasoning || typeof output.reasoning !== "string") {
    log.error("Missing or invalid 'reasoning' field", { reasoning: output.reasoning });
    return false;
  }

  if (!output.memoryAction || typeof output.memoryAction !== "string") {
    log.error("Missing or invalid 'memoryAction' field", { memoryAction: output.memoryAction });
    return false;
  }

  if (!VALID_MEMORY_ACTIONS.has(output.memoryAction)) {
    log.error("Invalid memoryAction value", { memoryAction: output.memoryAction });
    return false;
  }

  // Check for suspicious text patterns that indicate raw text output
  const reasoning = output.reasoning || "";

  // If reasoning is extremely long, it's likely raw text, not a decision
  if (reasoning.length > 5000) {
    log.error("Reasoning field is suspiciously long (likely raw text)", { length: reasoning.length });
    return false;
  }

  // If reasoning contains markdown headers or multiple paragraphs, it's likely raw text
  const paragraphCount = (reasoning.match(/\n\n/g) || []).length;
  if (paragraphCount > 5) {
    log.error("Reasoning contains too many paragraphs (likely raw text)", { paragraphs: paragraphCount });
    return false;
  }

  // All checks passed
  return true;
}

/**
 * Validates receptionist output and returns a safe fallback decision if invalid.
 * This prevents garbage text from being sent to users.
 */
export function validateOrFallback(
  output: any,
  userPrompt: string
): { valid: true; decision: ReceptionistDecision } | { valid: false; error: string } {
  if (validateReceptionistDecision(output)) {
    return { valid: true, decision: output };
  }

  // Log the garbage output for debugging (truncated)
  const outputPreview = typeof output === "string"
    ? output.slice(0, 500)
    : JSON.stringify(output, null, 2).slice(0, 500);

  log.error("Receptionist returned invalid output", {
    outputPreview,
    outputLength: typeof output === "string" ? output.length : JSON.stringify(output).length,
    userPrompt: userPrompt.slice(0, 200),
  });

  return {
    valid: false,
    error: "Receptionist returned malformed output (not a valid JSON decision object)",
  };
}
