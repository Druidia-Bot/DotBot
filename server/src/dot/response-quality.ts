/**
 * Response Quality Gate
 *
 * Uses the local LLM (Qwen 2.5 0.5B) to judge whether a reasoning model's
 * response is a complete, coherent answer or was truncated/garbled by
 * chain-of-thought consuming the output token budget.
 *
 * No deterministic heuristics — the LLM is the sole judge. A short response
 * like "fine" is perfectly valid if the question was "how are you doing".
 *
 * The local model file is probed at server startup (probeLocalModel).
 * First chat() call loads it into RAM (~1-2s), subsequent calls are fast.
 */

import { createComponentLogger } from "#logging.js";
import { isLocalModelReady, LocalLLMClient } from "#llm/providers/local-llm/index.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import type { ILLMClient } from "#llm/types.js";

const log = createComponentLogger("dot.quality");

const DOT_MAX_TOKENS = 4096;

export interface QualityCheckResult {
  acceptable: boolean;
  reason?: string;
}

/**
 * Ask the local LLM whether the response is a complete, coherent answer.
 *
 * @param response      The final text response from the tool loop
 * @param prompt        The user's original prompt (for context)
 * @returns Whether the response is acceptable and why
 */
export async function checkResponseQuality(
  response: string,
  prompt: string,
): Promise<QualityCheckResult> {
  if (!isLocalModelReady()) {
    log.debug("Local model not ready, skipping quality check");
    return { acceptable: true, reason: "local model unavailable — skipped" };
  }

  try {
    const localClient = new LocalLLMClient();

    const result = await localClient.chat([
      {
        role: "system",
        content: [
          "You judge whether an AI assistant's response is complete and coherent.",
          "Answer ONLY with the word 'yes' or 'no'.",
          "",
          "Answer 'no' if the response:",
          "- Is clearly cut off mid-sentence or mid-word",
          "- Is a sentence fragment that makes no sense on its own",
          "- Contains only a partial code block or markdown artifact",
          "",
          "Answer 'yes' if the response:",
          "- Is a valid answer, even if short (e.g. 'fine', 'done', 'yes')",
          "- Makes sense as a reply to the user's message",
          "- Is complete, even if brief",
        ].join("\n"),
      },
      {
        role: "user",
        content: `User said: "${prompt.slice(0, 300)}"\n\nAssistant replied: "${response.slice(0, 500)}"`,
      },
    ], {
      maxTokens: 4,
      temperature: 0.0,
    });

    const answer = (result.content || "").trim().toLowerCase();
    const acceptable = !answer.startsWith("no");

    log.info("Quality gate judgment", {
      acceptable,
      answer,
      responseLength: response.length,
      responsePreview: response.slice(0, 80),
    });

    return { acceptable, reason: answer };
  } catch (err) {
    log.warn("Quality gate failed — accepting response", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { acceptable: true, reason: "quality gate error — defaulting to accept" };
  }
}

// ============================================
// QUALITY RETRY
// ============================================

export interface QualityRetryOpts {
  llm: ILLMClient;
  deviceId: string;
  messageId: string;
  systemPrompt: string;
  resolvedPrompt: string;
  response: string;
  toolCalls: { tool: string; success: boolean; result?: string }[];
}

/**
 * If the reasoning model produced a truncated/garbled response, retry with
 * the assistant model using the already-executed tool results as context.
 * Returns the improved response, or the original if retry fails or doesn't help.
 */
export async function retryWithAssistantModel(opts: QualityRetryOpts): Promise<string> {
  const { llm, deviceId, messageId, systemPrompt, resolvedPrompt, response, toolCalls } = opts;

  const quality = await checkResponseQuality(response, resolvedPrompt);
  if (quality.acceptable) return response;

  log.warn("Response failed quality gate — retrying with assistant model", {
    messageId,
    originalLength: response.length,
    reason: quality.reason,
  });

  try {
    const { client: retryClient, selectedModel: retryModel } =
      await resolveModelAndClient(llm, { explicitRole: "assistant" }, deviceId);

    const toolSummary = toolCalls
      .filter(t => t.success && t.result)
      .map(t => `[${t.tool}]: ${t.result!.slice(0, 1500)}`)
      .join("\n\n");

    const retryMessages = [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content: [
          resolvedPrompt,
          "",
          "--- Tool Results (already executed) ---",
          toolSummary,
          "",
          "Synthesize a clear, complete response to the user based on the tool results above.",
        ].join("\n"),
      },
    ];

    const retryResponse = await retryClient.chat(retryMessages, {
      model: retryModel.model,
      maxTokens: DOT_MAX_TOKENS,
      temperature: 0.3,
    });

    if (retryResponse.content && retryResponse.content.length > response.length) {
      log.info("Quality retry succeeded", {
        messageId,
        originalLength: response.length,
        retryLength: retryResponse.content.length,
      });
      return retryResponse.content;
    }
  } catch (retryErr) {
    log.warn("Quality retry failed, keeping original response", {
      messageId,
      error: retryErr instanceof Error ? retryErr.message : String(retryErr),
    });
  }

  return response;
}
