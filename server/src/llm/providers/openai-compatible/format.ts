/**
 * OpenAI-Compatible Format Helpers
 *
 * Shared utilities for converting between the DotBot LLM message format
 * and the OpenAI chat completions API format.
 */

import type { LLMMessage } from "../../types.js";

/**
 * Format LLMMessages into OpenAI-compatible API format.
 * Handles images on tool result messages by converting to content arrays.
 */
export function formatMessagesForAPI(messages: LLMMessage[]): any[] {
  return messages.map(m => {
    const msg: any = { role: m.role, content: m.content };
    if (m.role === "assistant" && m.tool_calls?.length) {
      msg.tool_calls = m.tool_calls;
    }
    if (m.role === "tool" && m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id;
      // OpenAI supports content arrays with image_url for vision models
      if (m.images?.length) {
        const contentParts: any[] = [];
        for (const img of m.images) {
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:${img.media_type};base64,${img.base64}` },
          });
        }
        if (m.content) {
          contentParts.push({ type: "text", text: m.content });
        }
        msg.content = contentParts;
      }
    }
    return msg;
  });
}
