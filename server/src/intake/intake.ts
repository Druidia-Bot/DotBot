/**
 * Classify Pipeline — Lightweight Intent Classification
 *
 * Bypasses the full V2 pipeline. Loads the intake prompt template,
 * injects context fields, sends to LLM, returns raw JSON.
 */

import { createComponentLogger } from "../logging.js";
import { resolveModelAndClient } from "../llm/resolve.js";
import { loadPrompt } from "../prompt-template.js";
import type { ILLMClient } from "../llm/providers.js";
import type { EnhancedPromptRequest } from "../types/agent.js";

const log = createComponentLogger("intake");

export type ClassifyResult = Record<string, unknown>;

export async function executeClassifyPipeline(
  llm: ILLMClient,
  request: EnhancedPromptRequest
): Promise<ClassifyResult> {
  const { selectedModel: modelConfig, client } = await resolveModelAndClient(
    llm,
    { explicitRole: "intake" }
  );

  // Build field values for template injection
  const fields: Record<string, string> = {
    "Identity": request.agentIdentity || "Name: Dot\nRole: AI Assistant",

    "Conversation History": request.recentHistory.length > 0
      ? request.recentHistory
          .map((h) => `${h.role === "user" ? "Human" : "Assistant"}: ${h.content}`)
          .join("\n")
      : "(No recent conversation history)",

    "Memory Models": request.memoryIndex && request.memoryIndex.length > 0
      ? request.memoryIndex
          .map((m: any) => `- "${m.name}" (${m.category}): ${m.description || "no description"}`)
          .join("\n")
      : "(No memory models)",

    "User Message": request.prompt,
  };

  const prompt = await loadPrompt("intake/intake.md", fields);

  log.info("Calling LLM", {
    historyCount: request.recentHistory.length,
    threadCount: request.threadIndex.threads.length,
    modelCount: request.memoryIndex?.length || 0,
    promptLength: request.prompt.length,
  });

  const response = await client.chat([{ role: "user", content: prompt }],
    {
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
      temperature: 0.1,
      responseFormat: "json_object",
    }
  );

  log.info("LLM responded", {
    model: response.model,
    provider: response.provider,
    responseLength: response.content.length,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  });

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    return JSON.parse(jsonMatch[0]) as ClassifyResult;
  } catch (e) {
    log.error("Failed to parse LLM response", {
      error: e,
      raw: response.content.substring(0, 500),
    });
    return { error: "Failed to parse LLM response", raw: response.content.substring(0, 500) };
  }
}
