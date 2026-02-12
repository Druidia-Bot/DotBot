/**
 * Agent Runner - V2 Only
 *
 * Thin orchestrator class that coordinates V2 pipeline execution.
 */

import { nanoid } from "nanoid";
import { createLLMClient, type ILLMClient } from "../llm/providers.js";
import { createComponentLogger } from "../logging.js";
import type { EnhancedPromptRequest } from "../types/agent.js";
import { runReceptionist } from "./intake.js";
import { executeV2Pipeline } from "./pipeline.js";

// Re-export types for backward compatibility
export type { AgentRunnerOptions, AgentRunResult } from "./runner-types.js";
import type { AgentRunnerOptions, AgentRunResult } from "./runner-types.js";

const log = createComponentLogger("agents");

export class AgentRunner {
  private llm: ILLMClient;
  public options: AgentRunnerOptions;

  constructor(opts: AgentRunnerOptions) {
    this.options = opts;
    this.llm = createLLMClient({
      provider: opts.provider || "deepseek",
      apiKey: opts.apiKey,
    });
    log.info("AgentRunner initialized", { provider: opts.provider || "deepseek" });
  }

  async classify(
    request: EnhancedPromptRequest,
    userId: string
  ): Promise<import("../types/agent.js").ReceptionistDecision> {
    return runReceptionist(this.llm, this.options, request, userId);
  }

  async run(
    request: EnhancedPromptRequest,
    userId: string,
  ): Promise<AgentRunResult & { router?: import("./message-router.js").MessageRouter }> {
    const sessionId = `session_${nanoid()}`;

    try {
      log.info("V2 pipeline: starting");
      const result = await executeV2Pipeline(
        this.llm,
        this.options,
        request,
        userId,
        sessionId
      );

      log.info("V2 pipeline: success", {
        responseLength: result.response?.length || 0,
        classification: result.classification,
      });

      return result;
    } catch (error) {
      log.error("V2 pipeline: error", { error });

      return {
        success: false,
        response: `I encountered an error: ${error instanceof Error ? error.message : "Unknown error"}. Please try rephrasing your request.`,
        classification: "CONVERSATIONAL",
        threadIds: [],
        keyPoints: [],
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async runWithDecision(
    request: EnhancedPromptRequest,
    userId: string,
    decision: import("../types/agent.js").ReceptionistDecision,
  ): Promise<AgentRunResult & { router?: import("./message-router.js").MessageRouter }> {
    // V2 goes through full pipeline
    return this.run(request, userId);
  }
}
