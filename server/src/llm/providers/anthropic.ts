/**
 * Anthropic LLM Client
 * 
 * Uses the Anthropic Messages API with system message separation.
 */

import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, LLMStreamChunk, LLMProvider, ToolCall, ToolDefinition } from "../types.js";
import { PROVIDER_CONFIGS } from "../config.js";

/**
 * Convert OpenAI-style tool definitions to Anthropic format.
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function toAnthropicTools(tools: ToolDefinition[]): any[] {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

/**
 * Format a tool result message for Anthropic, including image content blocks
 * when the message carries screenshot data.
 */
function formatToolResult(m: LLMMessage): any {
  if (m.images?.length) {
    // Build content array with image(s) + text summary
    const content: any[] = [];
    for (const img of m.images) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.media_type,
          data: img.base64,
        },
      });
    }
    if (m.content) {
      content.push({ type: "text", text: m.content });
    }
    return { type: "tool_result", tool_use_id: m.tool_call_id, content };
  }
  // Plain text result
  return { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content };
}

/**
 * Format LLMMessages for the Anthropic Messages API.
 * Handles assistant messages with tool_calls and tool result messages.
 */
function formatMessagesForAnthropic(messages: LLMMessage[]): any[] {
  const result: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") continue; // System handled separately

    if (m.role === "assistant" && m.tool_calls?.length) {
      // Convert to Anthropic content blocks
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
      result.push({ role: "assistant", content });
    } else if (m.role === "tool" && m.tool_call_id) {
      // Anthropic expects ALL tool results for a turn in a single user message.
      // Merge consecutive tool messages into one user message with multiple tool_result blocks.
      const toolResults: any[] = [formatToolResult(m)];
      while (i + 1 < messages.length && messages[i + 1].role === "tool" && messages[i + 1].tool_call_id) {
        i++;
        toolResults.push(formatToolResult(messages[i]));
      }
      result.push({ role: "user", content: toolResults });
    } else {
      result.push({ role: m.role, content: m.content });
    }
  }

  return result;
}

export class AnthropicClient implements ILLMClient {
  provider: LLMProvider = "anthropic";
  private apiKey: string;
  private baseUrl: string;
  
  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || "https://api.anthropic.com";
  }
  
  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    const model = options?.model || PROVIDER_CONFIGS.anthropic.defaultModel;
    
    // Separate system message from others (Anthropic API requirement)
    const systemMsg = messages.find(m => m.role === "system");
    const otherMsgs = messages.filter(m => m.role !== "system");
    
    const body: Record<string, any> = {
      model,
      system: systemMsg?.content,
      messages: formatMessagesForAnthropic(otherMsgs),
      temperature: options?.temperature ?? 0.5,
      max_tokens: options?.maxTokens ?? 4096,
    };

    if (options?.tools?.length) {
      body.tools = toAnthropicTools(options.tools);
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
    }
    
    const data = await response.json();
    
    // Extract text and tool_use blocks from Anthropic response
    let textContent = "";
    const toolCalls: ToolCall[] = [];

    for (const block of data.content || []) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content: textContent,
      model,
      provider: "anthropic",
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0
      },
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }
  
  async *stream(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    const model = options?.model || PROVIDER_CONFIGS.anthropic.defaultModel;
    
    const systemMsg = messages.find(m => m.role === "system");
    const otherMsgs = messages.filter(m => m.role !== "system");
    
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        system: systemMsg?.content,
        messages: otherMsgs.map(m => ({ role: m.role, content: m.content })),
        temperature: options?.temperature ?? 0.5,
        max_tokens: options?.maxTokens ?? 4096,
        stream: true
      })
    });
    
    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
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
            if (parsed.type === "content_block_delta") {
              yield { content: parsed.delta.text || "", done: false };
            } else if (parsed.type === "message_stop") {
              yield { content: "", done: true };
              return;
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
