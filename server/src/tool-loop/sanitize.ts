/**
 * Message Sanitization
 *
 * Defensive sanitizer: ensures every assistant message with tool_calls is
 * immediately followed by matching tool result messages. DeepSeek and OpenAI
 * return 400 if tool results are missing or out of order.
 *
 * Repairs in-place by injecting placeholder tool results where needed.
 */

import { createComponentLogger } from "../logging.js";
import type { LLMMessage } from "../llm/types.js";

const log = createComponentLogger("tool-loop.sanitize");

export function sanitizeMessages(messages: LLMMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;

    const expectedIds = new Set(msg.tool_calls.map(tc => tc.id));
    const foundIds = new Set<string>();

    // Scan forward to find all tool results, skipping injected user messages.
    // Stop when we've found all results, hit another assistant message, or reach the end.
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === "assistant") break;

      if (messages[j].role === "tool" && messages[j].tool_call_id) {
        foundIds.add(messages[j].tool_call_id!);
        if (foundIds.size === expectedIds.size) break;
      }
    }

    // Inject missing tool results right after the assistant message
    if (foundIds.size < expectedIds.size) {
      const missing = [...expectedIds].filter(id => !foundIds.has(id));
      log.warn(`sanitizeMessages: patching ${missing.length} missing tool results`, {
        assistantIdx: i,
        expectedCount: expectedIds.size,
        foundCount: foundIds.size,
      });
      const insertIdx = i + 1 + foundIds.size;
      const patches: LLMMessage[] = missing.map(id => ({
        role: "tool" as const,
        content: "(no result — tool execution was skipped)",
        tool_call_id: id,
      }));
      messages.splice(insertIdx, 0, ...patches);
    }
  }
}
