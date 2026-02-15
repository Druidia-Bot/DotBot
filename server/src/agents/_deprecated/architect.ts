/**
 * Architect Agent — V2 Heavyweight Escalation Handler
 *
 * When a spawned agent calls agent.escalate, the architect takes over.
 * It uses the architect-tier model (Claude Opus or equivalent) to:
 *
 * 1. Read the escalating agent's full work log + conversation
 * 2. Re-analyze the task with deeper reasoning
 * 3. Either: rewrite the persona + tools and return new AgentTasks,
 *    OR decompose into sub-tasks for the orchestrator to spawn
 *
 * This is the "supervisor who can intervene when a worker is stuck."
 * It runs rarely — only on escalation — so the cost of the architect
 * model is justified.
 */

import { createComponentLogger } from "../logging.js";
import { resolveModelAndClient } from "./execution.js";
import { generateCompactCatalog } from "../tools/catalog.js";
import { FALLBACK_TOOL_IDS } from "./persona-writer.js";
import type { ILLMClient } from "../llm/providers.js";
import type { AgentRunnerOptions } from "./runner-types.js";
import type { AgentTask } from "./orchestrator.js";

const log = createComponentLogger("architect");

// ============================================
// TYPES
// ============================================

export interface EscalationContext {
  /** The agent that escalated */
  agentId: string;
  /** Agent's topic label */
  topic: string;
  /** Original user request */
  originalPrompt: string;
  /** Why the agent escalated */
  escalationReason: string;
  /** What the agent suggested as a better approach */
  suggestedApproach?: string;
  /** The agent's work log (tool calls + results so far) */
  workLog: string;
  /** The agent's system prompt (so architect knows what was tried) */
  agentSystemPrompt: string;
  /** Tool IDs the agent had */
  agentToolIds: string[];
}

export interface ArchitectDecision {
  /** What the architect decided to do */
  action: "rewrite" | "decompose" | "abort";
  /** New tasks to spawn (for rewrite: 1 task, for decompose: multiple) */
  tasks: AgentTask[];
  /** If aborting, the message for the user */
  abortMessage?: string;
  /** Architect's reasoning */
  reasoning: string;
}

// ============================================
// ARCHITECT
// ============================================

/**
 * Handle an escalation from a spawned agent.
 * Uses the architect-tier model for deeper reasoning.
 */
export async function handleEscalation(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  context: EscalationContext
): Promise<ArchitectDecision> {
  const { selectedModel: modelConfig, client } = await resolveModelAndClient(
    llm,
    { explicitRole: "architect" }
  );

  const compactCatalog = generateCompactCatalog(options.toolManifest || []);

  const systemPrompt = `You are an architect-level task analyst. A spawned agent has escalated to you because it's stuck or the task is more complex than expected.

Your job:
1. Read the agent's work log and escalation reason
2. Decide the best path forward
3. Either REWRITE the agent's approach (new persona + tools) or DECOMPOSE into sub-tasks

## Available Tools
${compactCatalog}

## Decision Options

### REWRITE
The task is doable but the agent had the wrong approach/tools. Write a new system prompt and select better tools.
Use this when: wrong tools selected, persona too narrow, approach was off.

### DECOMPOSE
The task is actually multiple tasks that should be handled by separate agents.
Use this when: the agent discovered the task has distinct parts that need different expertise.

### ABORT
The task cannot be completed with available tools/capabilities.
Use this when: required tools don't exist, task is impossible, user needs to provide more info.

## Response Format
Respond with JSON:
\`\`\`json
{
  "action": "rewrite" | "decompose" | "abort",
  "reasoning": "Brief explanation of your decision",
  "tasks": [
    {
      "task": "What this agent should do",
      "topic": "Short label",
      "systemPrompt": "Full system prompt for the agent",
      "selectedToolIds": ["tool.id", ...],
      "modelRole": "workhorse"
    }
  ],
  "abortMessage": "Only for abort — message for the user"
}
\`\`\``;

  const userMessage = `## Escalation from Agent: ${context.topic}

**Original User Request:** ${context.originalPrompt}

**Escalation Reason:** ${context.escalationReason}
${context.suggestedApproach ? `**Agent's Suggestion:** ${context.suggestedApproach}` : ""}

**Agent's System Prompt:**
${context.agentSystemPrompt.substring(0, 500)}${context.agentSystemPrompt.length > 500 ? "..." : ""}

**Tools the Agent Had:** ${context.agentToolIds.join(", ")}

**Work Log (what was tried):**
${context.workLog || "(no tool calls made)"}

Analyze this escalation and decide the best path forward.`;

  const messages: { role: "system" | "user"; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  options.onLLMRequest?.({
    persona: "architect",
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
      temperature: 0.2,
      responseFormat: "json_object",
    });

    options.onLLMResponse?.({
      persona: "architect",
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
      const decision: ArchitectDecision = {
        action: parsed.action || "abort",
        tasks: (parsed.tasks || []).map((t: any) => ({
          task: t.task || "",
          topic: t.topic || "Untitled",
          systemPrompt: t.systemPrompt || t.system_prompt || "",
          selectedToolIds: t.selectedToolIds || t.selected_tool_ids || [...FALLBACK_TOOL_IDS],
          modelRole: t.modelRole || t.model_role || "workhorse",
        })),
        abortMessage: parsed.abortMessage || parsed.abort_message || undefined,
        reasoning: parsed.reasoning || "",
      };

      log.info("Architect decision", {
        action: decision.action,
        taskCount: decision.tasks.length,
        reasoning: decision.reasoning.substring(0, 200),
      });

      return decision;
    }

    log.warn("Architect returned non-JSON");
  } catch (error) {
    log.error("Architect failed", { error });
  }

  // Fallback: abort with generic message
  return {
    action: "abort",
    tasks: [],
    abortMessage: `I wasn't able to figure out a better approach for this task. The original agent escalated because: ${context.escalationReason}`,
    reasoning: "Architect fallback — could not parse response",
  };
}
