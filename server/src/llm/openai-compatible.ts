/**
 * OpenAI-Compatible LLM Client
 * 
 * Works with any provider that implements the OpenAI chat completions API:
 * OpenAI, LM Studio, vLLM, etc.
 */

import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMProvider, ToolCall } from "./types.js";

/**
 * Format LLMMessages into OpenAI-compatible API format.
 * Handles images on tool result messages by converting to content arrays.
 */
function formatMessagesForAPI(messages: LLMMessage[]): any[] {
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
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
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
      })
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
