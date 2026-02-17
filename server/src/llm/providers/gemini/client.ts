/**
 * Gemini LLM Client (Chat + Stream)
 *
 * Uses the Google Generative AI REST API (generateContent).
 */

import { createComponentLogger } from "#logging.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMProvider,
  ToolCall,
} from "../../types.js";
import { PROVIDER_CONFIGS } from "../../config.js";
import {
  formatContentsForGemini,
  extractSystemInstruction,
  toGeminiFunctionDeclarations,
  nextToolCallId,
} from "./format.js";

const log = createComponentLogger("llm.gemini");

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
      signal: AbortSignal.timeout(120_000),
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
          id: nextToolCallId(part.functionCall.name),
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
      signal: AbortSignal.timeout(120_000),
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
