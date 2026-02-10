/**
 * Gemini LLM Client
 * 
 * Uses the Google Generative AI REST API (generateContent).
 * Gemini has a different API format than OpenAI — system messages go in
 * a separate `systemInstruction` field, and tool calling uses a different schema.
 */

import { createComponentLogger } from "../logging.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import { PROVIDER_CONFIGS } from "./types.js";

const log = createComponentLogger("llm.gemini");

// Monotonic counter for unique tool call IDs (Date.now() alone can collide)
let toolCallCounter = 0;

// ============================================
// FORMAT HELPERS
// ============================================

/**
 * Convert OpenAI-style tool definitions to Gemini function declarations.
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Gemini: { functionDeclarations: [{ name, description, parameters }] }
 */
function toGeminiFunctionDeclarations(tools: ToolDefinition[]): any[] {
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
function formatContentsForGemini(messages: LLMMessage[]): any[] {
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
function extractSystemInstruction(messages: LLMMessage[]): string | null {
  const systemMsgs = messages.filter(m => m.role === "system");
  if (systemMsgs.length === 0) return null;
  return systemMsgs.map(m => m.content).join("\n\n");
}

// ============================================
// GEMINI CLIENT
// ============================================

export class GeminiClient implements ILLMClient {
  provider: LLMProvider = "gemini";
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || PROVIDER_CONFIGS.gemini.baseUrl!;
  }

  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    const model = options?.model || PROVIDER_CONFIGS.gemini.defaultModel;

    log.info(`LLM Request`, {
      provider: "gemini",
      model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content.substring(0, 500) + (m.content.length > 500 ? "..." : ""),
      })),
    });

    const body: any = {
      contents: formatContentsForGemini(messages),
      generationConfig: {
        temperature: options?.temperature ?? 0.5,
        maxOutputTokens: options?.maxTokens ?? 4096,
      },
    };

    // System instruction
    const systemInstruction = extractSystemInstruction(messages);
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    // Tool definitions
    if (options?.tools?.length) {
      body.tools = [{
        functionDeclarations: toGeminiFunctionDeclarations(options.tools),
      }];
    }

    const url = `${this.baseUrl}/v1beta/models/${model}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${errorText.substring(0, 500)}`);
    }

    const data = await response.json() as any;
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) {
      throw new Error("Gemini response missing content parts");
    }

    // Extract text and tool calls from parts
    let content = "";
    const toolCalls: ToolCall[] = [];

    for (const part of candidate.content.parts) {
      if (part.text) {
        content += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
    }

    return {
      content,
      model,
      provider: "gemini",
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
      },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async *stream(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    const model = options?.model || PROVIDER_CONFIGS.gemini.defaultModel;

    log.info(`LLM Stream Request`, {
      provider: "gemini",
      model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content.substring(0, 500) + (m.content.length > 500 ? "..." : ""),
      })),
    });

    const body: any = {
      contents: formatContentsForGemini(messages),
      generationConfig: {
        temperature: options?.temperature ?? 0.5,
        maxOutputTokens: options?.maxTokens ?? 4096,
      },
    };

    const systemInstruction = extractSystemInstruction(messages);
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    // Gemini streaming uses streamGenerateContent with alt=sse
    const url = `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`API error ${response.status}`, { error: errorText.substring(0, 500) });
      throw new Error(`Gemini API error: ${response.status} - ${errorText.substring(0, 500)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (text) {
              yield { content: text, done: false };
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }

    yield { content: "", done: true };
  }
}
