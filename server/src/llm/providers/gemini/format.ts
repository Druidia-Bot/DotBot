/**
 * Gemini Format Helpers
 *
 * Shared utilities for converting between the DotBot LLM message format
 * and Gemini's API format. Used by all three Gemini clients.
 */

import { createComponentLogger } from "#logging.js";
import type { LLMMessage, ToolDefinition } from "../../types.js";

const log = createComponentLogger("llm.gemini.format");

// Monotonic counter for unique tool call IDs (Date.now() alone can collide)
let toolCallCounter = 0;

export function nextToolCallId(functionName: string): string {
  return `call_${functionName}_${Date.now()}_${++toolCallCounter}`;
}

/**
 * Convert OpenAI-style tool definitions to Gemini function declarations.
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Gemini: { functionDeclarations: [{ name, description, parameters }] }
 */
export function toGeminiFunctionDeclarations(tools: ToolDefinition[]): any[] {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || "",
    parameters: t.function.parameters || { type: "object", properties: {} },
  }));
}

/**
 * Convert LLMMessages to Gemini contents format.
 * Gemini uses "user" and "model" roles (not "assistant").
 * System messages are extracted separately for systemInstruction.
 */
export function formatContentsForGemini(messages: LLMMessage[]): any[] {
  const contents: any[] = [];

  for (const m of messages) {
    if (m.role === "system") continue; // Handled as systemInstruction

    if (m.role === "assistant") {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            log.warn(`Malformed tool call arguments for ${tc.function.name}, using empty args`);
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args,
            },
          });
        }
      }
      contents.push({ role: "model", parts });
    } else if (m.role === "tool" && m.tool_call_id) {
      // Gemini expects functionResponse parts
      const parts: any[] = [{
        functionResponse: {
          name: m.tool_call_id, // We store toolId in tool_call_id
          response: { content: m.content },
        },
      }];
      // Add image parts if present (Gemini supports inlineData)
      if (m.images?.length) {
        for (const img of m.images) {
          parts.push({
            inlineData: {
              mimeType: img.media_type,
              data: img.base64,
            },
          });
        }
      }
      contents.push({ role: "function", parts });
    } else {
      // user messages
      contents.push({
        role: "user",
        parts: [{ text: m.content }],
      });
    }
  }

  return contents;
}

/**
 * Extract system instruction from messages.
 */
export function extractSystemInstruction(messages: LLMMessage[]): string | null {
  const systemMsgs = messages.filter(m => m.role === "system");
  if (systemMsgs.length === 0) return null;
  return systemMsgs.map(m => m.content).join("\n\n");
}
