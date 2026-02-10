/**
 * DeepSeek LLM Client
 * 
 * Uses the OpenAI-compatible chat completions API format.
 */

import { createComponentLogger } from "../logging.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMProvider, ToolCall } from "./types.js";
import { PROVIDER_CONFIGS } from "./types.js";

const log = createComponentLogger("llm.deepseek");

/**
 * Format LLMMessages into OpenAI-compatible API format.
 * Handles tool_calls on assistant messages and tool_call_id on tool messages.
 */
function formatMessagesForAPI(messages: LLMMessage[]): any[] {
  return messages.map(m => {
    const msg: any = { role: m.role, content: m.content };
    if (m.role === "assistant" && m.tool_calls?.length) {
      msg.tool_calls = m.tool_calls;
    }
    if (m.role === "tool" && m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id;
    }
    if (m.role === "assistant" && m.reasoning_content) {
      msg.reasoning_content = m.reasoning_content;
    }
    return msg;
  });
}

export class DeepSeekClient implements ILLMClient {
  provider: LLMProvider = "deepseek";
  private apiKey: string;
  private baseUrl: string;
  
  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || PROVIDER_CONFIGS.deepseek.baseUrl!;
  }
  
  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    const model = options?.model || PROVIDER_CONFIGS.deepseek.defaultModel;
    
    log.info(`LLM Request`, { 
      provider: "deepseek", 
      model, 
      messages: messages.map(m => ({ role: m.role, content: m.content.substring(0, 500) + (m.content.length > 500 ? '...' : '') }))
    });
    
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

    if (options?.thinking) {
      body.thinking = { type: "enabled" };
      body.max_tokens = options?.maxTokens ?? 32768;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.status} ${await response.text()}`);
    }
    
    const data = await response.json();
    const message = data.choices[0].message;
    
    // Extract native tool calls if present
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
      provider: "deepseek",
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0
      },
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      reasoningContent: message.reasoning_content || undefined,
    };
  }
  
  async *stream(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    const model = options?.model || PROVIDER_CONFIGS.deepseek.defaultModel;
    
    log.info(`LLM Stream Request`, { 
      provider: "deepseek", 
      model, 
      messages: messages.map(m => ({ role: m.role, content: m.content.substring(0, 500) + (m.content.length > 500 ? '...' : '') }))
    });
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature ?? 0.5,
        max_tokens: options?.maxTokens ?? 4096,
        stream: true
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      log.error(`API error ${response.status}`, { error: errorText });
      throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
    }
    
    log.debug(`Response received, streaming...`);
    
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
