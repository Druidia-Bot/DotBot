/**
 * OpenAI-Compatible LLM Client (Chat + Stream)
 *
 * Works with any provider that implements the OpenAI chat completions API:
 * OpenAI, xAI, LM Studio, vLLM, etc.
 */

import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMProvider,
  ToolCall,
} from "../../types.js";
import { formatMessagesForAPI } from "./format.js";

export class OpenAICompatibleClient implements ILLMClient {
  provider: LLMProvider;
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  
  constructor(
    provider: LLMProvider,
    apiKey: string,
    baseUrl: string,
    defaultModel: string
  ) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.defaultModel = defaultModel;
  }
  
  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    const model = options?.model || this.defaultModel;
    
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    
    const body: Record<string, any> = {
      model,
      messages: formatMessagesForAPI(messages),
      temperature: options?.temperature ?? 0.5,
      max_tokens: options?.maxTokens ?? 4096,
      stream: false,
    };

    if (options?.tools?.length) {
      body.tools = options.tools;
    }

    if (options?.responseFormat === "json_object") {
      if (options.responseSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: options.responseSchema.name,
            strict: true,
            schema: options.responseSchema.schema,
          },
        };
      } else {
        body.response_format = { type: "json_object" };
      }
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    
    if (!response.ok) {
      throw new Error(`${this.provider} API error: ${response.status} ${await response.text()}`);
    }
    
    const data = await response.json();
    const message = data.choices[0].message;

    const toolCalls: ToolCall[] | undefined = message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    return {
      content: message.content || "",
      model,
      provider: this.provider,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0
      },
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };
  }
  
  async *stream(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    const model = options?.model || this.defaultModel;
    
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature ?? 0.5,
        max_tokens: options?.maxTokens ?? 4096,
        stream: true
      }),
      signal: AbortSignal.timeout(120_000),
    });
    
    if (!response.ok) {
      throw new Error(`${this.provider} API error: ${response.status}`);
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
          if (data === "[DONE]") {
            yield { content: "", done: true };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || "";
            if (content) {
              yield { content, done: false };
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
