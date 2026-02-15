/**
 * Agent Router — Routing LLM Call
 *
 * When a user message arrives and matched memory models have agent assignments,
 * this module fires a focused LLM call to decide: MODIFY, QUEUE, NEW, or STOP.
 *
 * Input:  user message + list of candidate agents (with steps from plan.json)
 * Output: routing decision + target agent ID
 */

import { createComponentLogger } from "../../logging.js";
import { resolveModelAndClient } from "../../llm/resolve.js";
import { loadPrompt, loadSchema } from "../../prompt-template.js";
import type { ILLMClient } from "../../llm/types.js";
import type { AgentStatus } from "../../recruiter/output.js";

const log = createComponentLogger("agent-router");

// ============================================
// TYPES
// ============================================

export type RoutingDecision = "modify" | "queue" | "new" | "stop";

export interface CandidateAgent {
  agentId: string;
  restatedRequests: string[];
  status: AgentStatus;
  workspacePath: string;
  createdAt: string;
  /** Step titles with completion markers, from plan.json */
  steps?: CandidateStep[];
}

export interface CandidateStep {
  id: string;
  title: string;
  status: "completed" | "current" | "remaining";
}

export interface RoutingResult {
  decision: RoutingDecision;
  targetAgentId?: string;
  reasoning: string;
}

// ============================================
// PROMPT BUILDER
// ============================================

function formatAgentList(agents: CandidateAgent[]): string {
  return agents.map((agent, i) => {
    const lines: string[] = [];
    lines.push(`${i + 1}. ${agent.agentId}`);
    lines.push(`   Requests: ${JSON.stringify(agent.restatedRequests)}`);
    lines.push(`   Status: ${agent.status}`);

    if (agent.steps && agent.steps.length > 0) {
      lines.push("   Steps:");
      for (const step of agent.steps) {
        const marker =
          step.status === "completed" ? "✓" :
          step.status === "current" ? "→" : " ";
        const suffix = step.status === "current" ? " (in progress)" : "";
        lines.push(`     ${marker} ${step.title}${suffix}`);
      }
    }

    lines.push(`   Workspace: ${agent.workspacePath}`);
    lines.push(`   Created: ${agent.createdAt}`);
    return lines.join("\n");
  }).join("\n\n");
}

// ============================================
// ROUTER
// ============================================

/**
 * Run the routing LLM call. Fires when 1+ candidate agents exist on matched models.
 *
 * Returns the decision + target agent ID. The caller is responsible for
 * executing the decision (push signal, queue task, create new agent, or abort).
 */
export async function routeToAgent(
  llm: ILLMClient,
  userMessage: string,
  candidates: CandidateAgent[],
): Promise<RoutingResult> {
  if (candidates.length === 0) {
    return { decision: "new", reasoning: "No candidate agents — new task" };
  }

  log.info("Routing LLM call starting", {
    userMessage: userMessage.slice(0, 100),
    candidateCount: candidates.length,
    candidateIds: candidates.map(c => c.agentId),
  });

  const agentListText = formatAgentList(candidates);

  const [prompt, schema] = await Promise.all([
    loadPrompt("pipeline/routing/router.md", {
      "User Message": userMessage,
      "Agent List": agentListText,
    }),
    loadSchema("pipeline/routing/router.schema.json"),
  ]);

  const { selectedModel: modelConfig, client } = await resolveModelAndClient(
    llm,
    { explicitRole: "intake" },
  );

  const response = await client.chat(
    [{ role: "user", content: prompt }],
    {
      model: modelConfig.model,
      maxTokens: 300,
      temperature: 0.1,
      responseFormat: "json_object",
      responseSchema: { name: "agent_router", schema },
    },
  );

  log.info("Routing LLM call complete", {
    model: response.model,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  });

  let result: RoutingResult;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in routing response");
    const parsed = JSON.parse(jsonMatch[0]);

    result = {
      decision: parsed.decision,
      targetAgentId: parsed.targetAgentId,
      reasoning: parsed.reasoning || "",
    };
  } catch (e) {
    log.error("Failed to parse routing response", {
      error: e,
      raw: response.content.substring(0, 500),
    });
    // Fallback: treat as new task (safest default)
    result = {
      decision: "new",
      reasoning: "Routing LLM parse failure — defaulting to new task",
    };
  }

  // Validate decision
  const validDecisions: RoutingDecision[] = ["modify", "queue", "new", "stop"];
  if (!validDecisions.includes(result.decision)) {
    log.warn("Invalid routing decision, defaulting to new", { decision: result.decision });
    result.decision = "new";
  }

  // Validate targetAgentId for decisions that require it
  if (result.decision !== "new" && !result.targetAgentId) {
    log.warn("Routing decision requires targetAgentId but none provided, defaulting to new", {
      decision: result.decision,
    });
    result.decision = "new";
    result.reasoning += " (no targetAgentId provided — fallback to new)";
  }

  // Validate targetAgentId is one of the candidates
  if (result.targetAgentId) {
    const isValid = candidates.some(c => c.agentId === result.targetAgentId);
    if (!isValid) {
      log.warn("Routing targetAgentId not in candidates, defaulting to new", {
        targetAgentId: result.targetAgentId,
        candidates: candidates.map(c => c.agentId),
      });
      result.decision = "new";
      result.targetAgentId = undefined;
      result.reasoning += " (targetAgentId not in candidates — fallback to new)";
    }
  }

  log.info("Routing decision", {
    decision: result.decision,
    targetAgentId: result.targetAgentId,
    reasoning: result.reasoning.slice(0, 200),
  });

  return result;
}
