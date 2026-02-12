/**
 * Enhanced Judge — V2 Quality Gate
 *
 * Three-check scoring system that evaluates agent responses before
 * they reach the user:
 *
 * 1. **Coherence**: Is the response well-structured and readable?
 *    Catches raw JSON dumps, truncated output, formatting issues.
 *
 * 2. **Relevance**: Does it actually answer what the user asked?
 *    Catches off-topic tangents, partial answers, missed requirements.
 *
 * 3. **Value**: Does it provide actionable, useful content?
 *    Catches vague hand-waving, unnecessary disclaimers, filler text.
 *
 * Verdicts:
 * - pass: Response is good, send to user
 * - cleaned: Response had issues, judge fixed them (cleaned version attached)
 * - rerun: Response is fundamentally wrong, re-execute the agent (one retry max)
 * - abort: Response cannot be salvaged, send error message
 *
 * The enhanced judge also receives the tool call history so it can verify
 * the agent actually did what it claimed.
 */

import { createComponentLogger } from "../logging.js";
import { resolveModelAndClient } from "./execution.js";
import type { ILLMClient } from "../llm/providers.js";
import type { AgentRunnerOptions } from "./runner-types.js";

const log = createComponentLogger("judge");

// ============================================
// TYPES
// ============================================

export interface EnhancedJudgeVerdict {
  verdict: "pass" | "cleaned" | "rerun" | "abort";
  /** Cleaned response text (only for "cleaned" verdict) */
  cleanedResponse: string | null;
  /** Individual check scores (0-10) */
  scores: {
    coherence: number;
    relevance: number;
    value: number;
  };
  /** Brief explanation of the verdict */
  reasoning: string;
}

export interface JudgeContext {
  /** The original user message */
  originalPrompt: string;
  /** The agent's proposed response */
  proposedResponse: string;
  /** Agent identifier (persona ID or topic label) */
  agentId: string;
  /** Summary of tool calls made (from work log) */
  toolCallSummary?: string;
  /** Whether this is a rerun attempt (prevents infinite loops) */
  isRetry?: boolean;
}

// ============================================
// ENHANCED JUDGE
// ============================================

/**
 * Run the enhanced three-check judge on a response.
 *
 * Returns the final response (original, cleaned, or error message)
 * plus the verdict details.
 */
export async function runEnhancedJudge(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  context: JudgeContext
): Promise<{ response: string; verdict: EnhancedJudgeVerdict }> {
  const { selectedModel: modelConfig, client } = await resolveModelAndClient(
    llm,
    { explicitRole: "intake" }  // Judge uses fast model — it's a quick quality check
  );

  const systemPrompt = `You are a response quality judge. Score the proposed response on three dimensions (0-10 each):

1. **Coherence** (0-10): Is the response well-structured, readable, and properly formatted?
   - 0-3: Raw JSON/data dump, garbled text, broken formatting
   - 4-6: Readable but poorly organized, missing structure
   - 7-10: Clean, well-formatted, easy to follow

2. **Relevance** (0-10): Does it address what the user actually asked?
   - 0-3: Completely off-topic or addresses wrong question
   - 4-6: Partially addresses the request, misses key parts
   - 7-10: Directly and completely answers the user's request

3. **Value** (0-10): Does it provide actionable, useful content?
   - 0-3: Vague hand-waving, excessive disclaimers, no substance
   - 4-6: Some useful info but incomplete or generic
   - 7-10: Specific, actionable, genuinely helpful

## Decision Rules

- Average >= 7: **pass** (send as-is)
- Average 5-6.9 AND fixable: **cleaned** (fix formatting/trim filler, provide cleaned_response)
- Average < 5 OR fundamentally wrong: **rerun** (re-execute the agent)
- Rerun already attempted (is_retry=true) AND still bad: **abort**

## Cleaning Rules (for "cleaned" verdict)

When cleaning, you may:
- Fix formatting (add headers, remove raw JSON, improve structure)
- Remove excessive disclaimers or filler
- Trim irrelevant tangents
- Fix obvious factual errors in the response structure

You may NOT:
- Add new information the agent didn't provide
- Change the substance or conclusions
- Rewrite the entire response (that's a "rerun")

Respond with JSON:
\`\`\`json
{
  "verdict": "pass|cleaned|rerun|abort",
  "scores": { "coherence": N, "relevance": N, "value": N },
  "reasoning": "Brief explanation",
  "cleaned_response": "Only for cleaned verdict, null otherwise"
}
\`\`\``;

  const toolContext = context.toolCallSummary
    ? `\n\nTOOL CALLS MADE:\n${context.toolCallSummary}`
    : "";

  const userMessage = `USER'S ORIGINAL REQUEST:
${context.originalPrompt}

AGENT: ${context.agentId}
${context.isRetry ? "⚠️ THIS IS A RETRY ATTEMPT — if still bad, verdict should be 'abort'" : ""}
${toolContext}

PROPOSED RESPONSE:
${context.proposedResponse}

Score and judge this response.`;

  const messages: { role: "system" | "user"; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  options.onLLMRequest?.({
    persona: "judge",
    provider: modelConfig.provider,
    model: modelConfig.model,
    promptLength: messages.reduce((acc, m) => acc + m.content.length, 0),
    maxTokens: modelConfig.maxTokens,
    messages,
  });

  const startTime = Date.now();

  try {
    const response = await client.chat(messages, {
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
      temperature: 0.1,  // Low temperature for consistent judgments
      responseFormat: "json_object",
    });

    options.onLLMResponse?.({
      persona: "judge",
      duration: Date.now() - startTime,
      responseLength: response.content.length,
      response: response.content,
      model: response.model,
      provider: response.provider,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const verdict: EnhancedJudgeVerdict = {
        verdict: parsed.verdict || "pass",
        scores: {
          coherence: parsed.scores?.coherence ?? 7,
          relevance: parsed.scores?.relevance ?? 7,
          value: parsed.scores?.value ?? 7,
        },
        reasoning: parsed.reasoning || "",
        cleanedResponse: parsed.cleaned_response || null,
      };

      log.info("Enhanced judge verdict", {
        verdict: verdict.verdict,
        scores: verdict.scores,
        agentId: context.agentId,
      });

      // Determine final response based on verdict
      if (verdict.verdict === "cleaned" && verdict.cleanedResponse) {
        return { response: verdict.cleanedResponse, verdict };
      }
      if (verdict.verdict === "abort") {
        return {
          response: `I wasn't able to produce a satisfactory response for this request. ${verdict.reasoning}`,
          verdict,
        };
      }

      // "pass" or "rerun" — return original (caller handles rerun logic)
      return { response: context.proposedResponse, verdict };
    }

    log.warn("Judge returned non-JSON, treating as pass");
  } catch (error) {
    log.error("Enhanced judge failed, passing response through", { error });
  }

  // Fallback: pass through
  return {
    response: context.proposedResponse,
    verdict: {
      verdict: "pass",
      scores: { coherence: 7, relevance: 7, value: 7 },
      reasoning: "Judge fallback — could not evaluate",
      cleanedResponse: null,
    },
  };
}
