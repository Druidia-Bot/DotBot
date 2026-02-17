/**
 * Local LLM Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const llmTools: DotBotTool[] = [
  {
    id: "llm.local_query",
    name: "local_query",
    description: "Send a prompt to the local LLM (Qwen 2.5 0.5B) for simple tasks that don't need a powerful cloud model. Runs entirely on your machine — works even when the server is down. Good for: classification, keyword extraction, summarization of short text, simple formatting, yes/no decisions, labeling, and basic Q&A. NOT suitable for complex reasoning, code generation, or long-form writing. Saves cloud API tokens.",
    source: "core",
    category: "llm",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to send to the local LLM" },
        system: { type: "string", description: "Optional system prompt to set context (keep short — small model)" },
        max_tokens: { type: "number", description: "Max tokens in response (default: 512, max: 2048)" },
      },
      required: ["prompt"],
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
];
