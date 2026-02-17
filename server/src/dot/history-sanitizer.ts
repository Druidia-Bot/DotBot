/**
 * History Sanitizer — Strip Toxic Patterns from Conversation History
 *
 * Prevents the LLM from "resuming" stale actions embedded in old assistant
 * messages (e.g. calling system.restart because a previous response said
 * "restart needed"). Patterns are redacted before history is sent to the model.
 */

/**
 * Patterns in assistant history messages that cause the LLM to
 * treat old suggestions as pending actions.
 */
const TOXIC_HISTORY_PATTERNS = [
  /\bsystem[._]restart\b/gi,
  /\bsystem__restart\b/gi,
  /\brestart needed\b/gi,
  /\bagent restart needed\b/gi,
  /\brun manually[:\s]*`?system/gi,
  /\b\w+__\w+\s+\w+="[^"]*"/g,  // fake tool-call syntax: tool__name arg="val"
];

export function sanitizeHistory(
  history: { role: string; content: string }[],
): { role: string; content: string }[] {
  return history.map(h => {
    if (h.role !== "assistant") return h;
    let content = h.content;
    for (const pattern of TOXIC_HISTORY_PATTERNS) {
      content = content.replace(pattern, "[redacted-stale-action]");
    }
    return { ...h, content };
  });
}
