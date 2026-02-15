/**
 * Local LLM Client (node-llama-cpp)
 *
 * Runs Qwen 2.5 0.5B locally via llama.cpp for offline fallback.
 * Uses the model manager for lazy loading and the connectivity
 * module for cloud reachability checks.
 */

import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMProvider,
} from "../../types.js";
import { ensureModelLoaded, getLoadedModel } from "./model-manager.js";

export class LocalLLMClient implements ILLMClient {
  provider: LLMProvider = "local" as LLMProvider;

  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    await ensureModelLoaded();

    const { LlamaChatSession } = await import("node-llama-cpp");

    // Extract system prompt
    const systemMsg = messages.find((m) => m.role === "system");
    const systemPrompt = systemMsg?.content || "";

    // Create a fresh context + session per call
    const loadedModel = getLoadedModel();
    const context = await loadedModel.createContext();
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt,
    });

    try {
      // Replay conversation: feed each user message through the session.
      // For a 0.5B fallback model we only care about getting a reasonable
      // response to the latest turn.
      const userMessages = messages.filter((m) => m.role === "user");
      let response = "";

      if (userMessages.length === 0) {
        response = "I'm the local offline assistant. How can I help?";
      } else if (userMessages.length === 1) {
        response = await session.prompt(userMessages[0].content || "", {
          maxTokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.3,
        });
      } else {
        // Multi-turn: replay all but the last silently, then get final response
        for (let i = 0; i < userMessages.length - 1; i++) {
          await session.prompt(userMessages[i].content || "", {
            maxTokens: 256, // Short responses for history replay
            temperature: 0.3,
          });
        }
        const lastMsg = userMessages[userMessages.length - 1];
        response = await session.prompt(lastMsg.content || "", {
          maxTokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.3,
        });
      }

      return {
        content: response,
        model: "qwen2.5-0.5b-instruct-q4_k_m",
        provider: "local" as LLMProvider,
        usage: undefined,
        toolCalls: undefined,
      };
    } finally {
      await context.dispose();
    }
  }

  async *stream(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    await ensureModelLoaded();

    const { LlamaChatSession } = await import("node-llama-cpp");

    const systemMsg = messages.find((m) => m.role === "system");
    const systemPrompt = systemMsg?.content || "";
    const userMessages = messages.filter((m) => m.role === "user");
    const lastMsg = userMessages[userMessages.length - 1]?.content || "";

    const loadedModel = getLoadedModel();
    const context = await loadedModel.createContext();
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt,
    });

    try {
      // Replay history silently
      for (let i = 0; i < userMessages.length - 1; i++) {
        await session.prompt(userMessages[i].content || "", {
          maxTokens: 256,
          temperature: 0.3,
        });
      }

      // Stream the final response via onTextChunk callback
      let fullText = "";
      const chunks: string[] = [];
      let resolveChunk: ((value: string | null) => void) | null = null;
      let done = false;

      // Kick off generation in background
      const genPromise = session
        .prompt(lastMsg, {
          maxTokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.3,
          onTextChunk: (chunk: string) => {
            if (resolveChunk) {
              resolveChunk(chunk);
              resolveChunk = null;
            } else {
              chunks.push(chunk);
            }
          },
        })
        .then((text: string) => {
          fullText = text;
          done = true;
          if (resolveChunk) {
            resolveChunk(null); // Signal completion
            resolveChunk = null;
          }
        });

      // Yield chunks as they arrive
      while (!done || chunks.length > 0) {
        if (chunks.length > 0) {
          const chunk = chunks.shift()!;
          yield { content: chunk, done: false };
        } else if (!done) {
          // Wait for next chunk
          const chunk = await new Promise<string | null>((resolve) => {
            resolveChunk = resolve;
          });
          if (chunk !== null) {
            yield { content: chunk, done: false };
          }
        }
      }

      await genPromise;
      yield { content: "", done: true };
    } finally {
      await context.dispose();
    }
  }
}
