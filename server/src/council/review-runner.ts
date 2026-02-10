/**
 * Council Review Runner
 * 
 * Councils are the "polishing" layer. Internal personas do the work;
 * councils review, refine, and approve the output.
 * 
 * Two execution modes:
 * - single_pass: Each member reviews once in sequence (round-robin)
 * - iterative: Members review in a loop until all required members approve
 *              or maxIterations is reached
 * 
 * Each council member can use a different LLM provider/model.
 */

import { createLLMClient, type ILLMClient, type LLMProvider, getApiKeyForProvider } from "../llm/providers.js";
import { ResilientLLMClient } from "../llm/resilient-client.js";
import { createComponentLogger } from "../logging.js";
import type {
  CouncilRuntime,
  CouncilMemberRuntime,
  CouncilVerdict,
  CouncilIteration,
  CouncilReviewResult,
} from "../types.js";

const log = createComponentLogger("council-review");

// ============================================
// REVIEW PROMPT TEMPLATE
// ============================================

function buildReviewPrompt(
  council: CouncilRuntime,
  member: CouncilMemberRuntime,
  originalPrompt: string,
  workOutput: string,
  previousFeedback?: CouncilVerdict[],
  iterationRound?: number
): string {
  const principlesText = council.principles
    .sort((a, b) => b.priority - a.priority)
    .map(p => `- **${p.title}** (priority ${p.priority}): ${p.description}`)
    .join("\n");

  const feedbackSection = previousFeedback?.length
    ? `\n## Previous Review Feedback (Round ${(iterationRound || 1) - 1})\n\n${previousFeedback
        .map(v => `### ${v.councilRole} (@${v.memberSlug}): ${v.approved ? "APPROVED" : "REJECTED"}\n${v.feedback}${v.suggestedChanges ? `\n**Suggested Changes:** ${v.suggestedChanges}` : ""}`)
        .join("\n\n")}\n`
    : "";

  return `You are reviewing work as a member of the "${council.name}" council.

## Your Role
**${member.councilRole}** (@${member.personaSlug})
${member.reviewFocus ? `**Review Focus:** ${member.reviewFocus}` : ""}

## Council Mission
${council.mission}

## Governing Principles
${principlesText}

## Original User Request
${originalPrompt}

## Work Output to Review
${workOutput}
${feedbackSection}
## Your Task

Review the work output through the lens of your role. You MUST respond with valid JSON:

\`\`\`json
{
  "approved": true/false,
  "feedback": "Your detailed review feedback",
  "suggestedChanges": "Specific changes you'd recommend (or null if approved)",
  "confidence": 0.85
}
\`\`\`

**Approval criteria:**
- Does the work satisfy the original request?
- Does it align with the council's governing principles?
- Does it meet the standards of your specific role?
${member.reviewFocus ? `- Specifically: ${member.reviewFocus}` : ""}

Be constructive. If rejecting, explain exactly what needs to change.`;
}

// ============================================
// COUNCIL REVIEW RUNNER
// ============================================

export interface CouncilReviewRunnerOptions {
  defaultProvider: LLMProvider;
  defaultApiKey: string;
  apiKeys?: Partial<Record<LLMProvider, string>>;
  onMemberReview?: (member: CouncilMemberRuntime, verdict: CouncilVerdict) => void;
  onIterationComplete?: (iteration: CouncilIteration) => void;
}

export class CouncilReviewRunner {
  private options: CouncilReviewRunnerOptions;
  private llmCache: Map<string, ILLMClient> = new Map();

  constructor(options: CouncilReviewRunnerOptions) {
    this.options = options;
  }

  /**
   * Get or create an LLM client for a specific provider.
   * Allows each council member to use a different provider/model.
   */
  private getLLMClient(provider?: LLMProvider): ILLMClient {
    const actualProvider = provider || this.options.defaultProvider;
    const cacheKey = actualProvider;
    
    if (this.llmCache.has(cacheKey)) {
      return this.llmCache.get(cacheKey)!;
    }
    
    const apiKey = this.options.apiKeys?.[actualProvider] || this.options.defaultApiKey;
    const primary = createLLMClient({ provider: actualProvider, apiKey });
    // Wrap in resilient client so council members get runtime fallback on 429s
    const client = new ResilientLLMClient(
      primary,
      "workhorse",
      (p, k) => createLLMClient({ provider: p, apiKey: k }),
      getApiKeyForProvider
    );
    this.llmCache.set(cacheKey, client);
    return client;
  }

  /**
   * Run a single member's review.
   */
  private async runMemberReview(
    council: CouncilRuntime,
    member: CouncilMemberRuntime,
    originalPrompt: string,
    workOutput: string,
    previousFeedback?: CouncilVerdict[],
    iterationRound?: number
  ): Promise<CouncilVerdict> {
    const startTime = Date.now();
    const llm = this.getLLMClient(member.providerOverride);
    
    // Build the system prompt: persona base + review instructions
    const systemPrompt = member.systemPrompt;
    const reviewPrompt = buildReviewPrompt(
      council, member, originalPrompt, workOutput, previousFeedback, iterationRound
    );

    log.info(`Review by @${member.personaSlug} (${member.councilRole})`, {
      council: council.slug,
      provider: member.providerOverride || this.options.defaultProvider,
      model: member.modelOverride || "default",
    });

    const response = await llm.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: reviewPrompt },
      ],
      {
        model: member.modelOverride || undefined,
        maxTokens: 2048,
        temperature: 0.4,
      }
    );

    // Parse verdict JSON from response
    let verdict: CouncilVerdict;
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in review response");
      
      const parsed = JSON.parse(jsonMatch[0]);
      verdict = {
        memberSlug: member.personaSlug,
        councilRole: member.councilRole,
        approved: !!parsed.approved,
        feedback: parsed.feedback || "No feedback provided",
        suggestedChanges: parsed.suggestedChanges || undefined,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        duration: Date.now() - startTime,
      };
    } catch (e) {
      log.warn(`Failed to parse review from @${member.personaSlug}, treating as rejection`, { error: e });
      verdict = {
        memberSlug: member.personaSlug,
        councilRole: member.councilRole,
        approved: false,
        feedback: `Review parse error. Raw response: ${response.content.substring(0, 500)}`,
        confidence: 0.3,
        duration: Date.now() - startTime,
      };
    }

    log.info(`Verdict from @${member.personaSlug}: ${verdict.approved ? "APPROVED" : "REJECTED"}`, {
      confidence: verdict.confidence,
      duration: verdict.duration,
    });

    this.options.onMemberReview?.(member, verdict);
    return verdict;
  }

  /**
   * Run a single iteration: all members review in sequence.
   */
  private async runIteration(
    council: CouncilRuntime,
    originalPrompt: string,
    workOutput: string,
    round: number,
    previousFeedback?: CouncilVerdict[]
  ): Promise<CouncilIteration> {
    const sortedMembers = [...council.members].sort((a, b) => a.sequence - b.sequence);
    const verdicts: CouncilVerdict[] = [];

    for (const member of sortedMembers) {
      const verdict = await this.runMemberReview(
        council, member, originalPrompt, workOutput, previousFeedback, round
      );
      verdicts.push(verdict);
    }

    const allRequiredApproved = verdicts.every(v => {
      const member = council.members.find(m => m.personaSlug === v.memberSlug);
      return !member?.required || v.approved;
    });

    const iteration: CouncilIteration = {
      round,
      verdicts,
      allRequiredApproved,
    };

    this.options.onIterationComplete?.(iteration);
    return iteration;
  }

  /**
   * Run the full council review.
   * 
   * For single_pass: one round of reviews, return result.
   * For iterative: loop until all required members approve or maxIterations hit.
   * 
   * In iterative mode, rejected feedback is compiled and sent back as context
   * for the next round. The work output itself doesn't change between rounds
   * (that would require re-engaging the worker personas — future enhancement).
   * Currently iterative mode gives reviewers visibility into each other's
   * feedback across rounds, allowing them to refine their own assessments.
   */
  async review(
    council: CouncilRuntime,
    originalPrompt: string,
    workOutput: string
  ): Promise<CouncilReviewResult> {
    log.info(`Council review starting: ${council.name}`, {
      mode: council.executionMode,
      memberCount: council.members.length,
      maxIterations: council.maxIterations,
    });

    const iterations: CouncilIteration[] = [];
    let currentOutput = workOutput;
    const maxRounds = council.executionMode === "iterative" 
      ? council.maxIterations 
      : 1;

    for (let round = 1; round <= maxRounds; round++) {
      log.info(`Review round ${round}/${maxRounds}`);

      const previousFeedback = iterations.length > 0
        ? iterations[iterations.length - 1].verdicts
        : undefined;

      const iteration = await this.runIteration(
        council, originalPrompt, currentOutput, round, previousFeedback
      );
      iterations.push(iteration);

      // If all required members approved, we're done
      if (iteration.allRequiredApproved) {
        log.info(`Council approved on round ${round}`);
        break;
      }

      // If iterative and not approved, continue to next round
      if (council.executionMode === "iterative" && round < maxRounds) {
        log.info(`Round ${round} not approved, continuing to round ${round + 1}`);
      }
    }

    const lastIteration = iterations[iterations.length - 1];
    const approved = lastIteration.allRequiredApproved;

    // Compile combined feedback from the final round
    const combinedFeedback = lastIteration.verdicts
      .map(v => `**${v.councilRole}** (@${v.memberSlug}): ${v.approved ? "✓ APPROVED" : "✗ REJECTED"}\n${v.feedback}${v.suggestedChanges ? `\nSuggested changes: ${v.suggestedChanges}` : ""}`)
      .join("\n\n");

    const result: CouncilReviewResult = {
      councilSlug: council.slug,
      approved,
      iterations,
      totalIterations: iterations.length,
      finalOutput: currentOutput,
      combinedFeedback,
    };

    log.info(`Council review complete: ${council.name}`, {
      approved,
      totalIterations: iterations.length,
      verdictSummary: lastIteration.verdicts.map(v => `${v.memberSlug}:${v.approved}`),
    });

    return result;
  }
}
