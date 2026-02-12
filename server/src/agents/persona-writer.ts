/**
 * Persona Writer — V2 Dynamic Persona Generation
 *
 * Given a classified request, writes custom system prompts and selects
 * specific tools for each task. This is the "Turn 2" of the V2 multi-turn
 * receptionist — it takes the V1 receptionist's classification and produces
 * AgentTask[] ready for the orchestrator.
 *
 * The key insight: instead of picking a static persona ("sysadmin", "writer"),
 * the LLM writes a purpose-built system prompt for this exact task, user,
 * and context. The compact tool catalog lets it pick specific tools by ID.
 */

import { nanoid } from "nanoid";
import { createComponentLogger } from "../logging.js";
import { resolveModelAndClient } from "./execution.js";
import { generateCompactCatalog } from "../tools/catalog.js";
import { getInternalPersonas } from "../personas/loader.js";
import type { ILLMClient } from "../llm/providers.js";
import type { AgentRunnerOptions } from "./runner-types.js";
import type {
  EnhancedPromptRequest,
  ReceptionistDecision,
} from "../types/agent.js";
import type { AgentTask } from "./orchestrator.js";

const log = createComponentLogger("persona-writer");

/**
 * Conservative fallback tool set when the persona-writer LLM fails.
 * Enough for general tasks; agent can call agent.escalate for more.
 * Empty [] would skip V2 ID filtering and grant ALL tools via V1 "all" category.
 */
export const FALLBACK_TOOL_IDS = [
  // Read-only exploration
  "filesystem.read_file", "filesystem.read_lines", "filesystem.exists", "filesystem.file_info",
  "directory.list", "directory.grep", "directory.find", "directory.tree",
  // Basic writes
  "filesystem.create_file", "filesystem.edit_file", "filesystem.append_file",
  // Shell (user's platform)
  "shell.powershell", "shell.bash", "shell.node",
  // Web
  "http.request",
  // Search
  "search.brave_search",
  // Meta
  "tools.list_tools",
  // Synthetic — can ask for more tools or escalate
  "agent.escalate", "agent.request_tools",
];

// ============================================
// PERSONA TEMPLATE SUMMARIES
// ============================================

/**
 * Build a compact reference of internal persona styles for the LLM.
 * These are NOT sent to executing agents — they're guidance for the
 * persona writer to draw inspiration from when crafting custom prompts.
 */
function buildPersonaTemplateReference(): string {
  const personas = getInternalPersonas().filter(p => !p.councilOnly);
  if (personas.length === 0) return "";

  const lines = personas.map(p => {
    const toolHint = p.tools?.length
      ? ` (tools: ${p.tools.join(", ")})`
      : "";
    return `- **${p.id}**: ${p.description || p.name}${toolHint}`;
  });

  return `## Persona Style Reference\n\nUse these as inspiration for writing custom personas. Do NOT reference them directly — write a fresh system prompt every time.\n\n${lines.join("\n")}`;
}

// ============================================
// WRITER
// ============================================

/**
 * Write dynamic personas for one or more tasks.
 *
 * Takes the receptionist's classification + the full request context,
 * makes a single LLM call to produce AgentTask[] with:
 * - Custom system prompts tailored to the exact task
 * - Selected tool IDs from the compact catalog
 * - Model role hints
 * - Relevant message indices for conversation isolation
 */
export async function writePersonas(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  decision: ReceptionistDecision
): Promise<AgentTask[]> {
  const { selectedModel: modelConfig, client } = await resolveModelAndClient(
    llm,
    { explicitRole: "intake" }
  );

  // Build context for the persona writer
  const compactCatalog = generateCompactCatalog(options.toolManifest || []);
  const personaReference = buildPersonaTemplateReference();

  // Memory context — what the agent knows about the user
  const memorySummary =
    request.memoryIndex && request.memoryIndex.length > 0
      ? request.memoryIndex
          .map(m => `- ${m.name} (${m.category}): ${m.keywords.join(", ")}`)
          .join("\n")
      : "No stored knowledge about this user";

  // Identity context
  const identitySection = request.agentIdentity
    ? `\n## Agent Identity\n${request.agentIdentity}`
    : "";

  const systemPrompt = `You are a persona architect. Your job is to take a classified user request and create one or more specialized agent configurations.

For each task, you write:
1. A custom system prompt perfectly tailored to this exact task, user, and context
2. A curated list of tool IDs the agent needs (from the catalog below)
3. Execution parameters (model role, iteration budget)

${personaReference}

${compactCatalog}

## User Knowledge
${memorySummary}
${identitySection}

## Rules

1. Write system prompts that are SPECIFIC to this task — include concrete details from the user's message and memory.
2. Include SUCCESS CRITERIA in every system prompt — the agent must know what "done" looks like.
3. Include CONSTRAINTS — what the agent should NOT do.
4. Pick ONLY the tools needed. Don't give filesystem tools to a pure-chat task. Don't give search tools to a file editing task.
5. Always include "agent.escalate" thinking — tell the agent: "If you need tools you don't have, call agent.escalate."
6. For simple tasks, return ONE task. For compound/multi-topic tasks, return multiple tasks.
7. Set modelRole: "workhorse" for most tasks, "architect" for complex reasoning/code architecture, "deep_context" for large documents.

Respond with a JSON array of tasks:
\`\`\`json
[
  {
    "topic": "Short label for UI",
    "task": "What the agent should do (instruction, not description)",
    "systemPrompt": "Full system prompt for the agent...",
    "selectedToolIds": ["tool.id1", "tool.id2"],
    "modelRole": "workhorse",
    "relevantMessageIndices": []
  }
]
\`\`\``;

  // Build conversation context
  const historySection = request.recentHistory.length > 0
    ? request.recentHistory
        .map((h, i) => `[${i}] ${h.role}: ${h.content.substring(0, 200)}${h.content.length > 200 ? "..." : ""}`)
        .join("\n")
    : "(no prior messages)";

  const userMessage = `## Receptionist Classification
Classification: ${decision.classification}
Confidence: ${decision.confidence}
Reasoning: ${decision.reasoning}
${decision.formattedRequest ? `Formatted request: ${decision.formattedRequest}` : ""}

## Conversation History
${historySection}

## Current User Message
${request.prompt}

Write the agent task configuration(s) as JSON.`;

  const messages: { role: "system" | "user"; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  options.onLLMRequest?.({
    persona: "persona-writer",
    provider: modelConfig.provider,
    model: modelConfig.model,
    promptLength: messages.reduce((acc, m) => acc + m.content.length, 0),
    maxTokens: modelConfig.maxTokens,
    messages,
  });

  const startTime = Date.now();
  const response = await client.chat(messages, {
    model: modelConfig.model,
    maxTokens: modelConfig.maxTokens,
    temperature: modelConfig.temperature,
    responseFormat: "json_object",
  });

  options.onLLMResponse?.({
    persona: "persona-writer",
    duration: Date.now() - startTime,
    responseLength: response.content.length,
    response: response.content,
    model: response.model,
    provider: response.provider,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  });

  // Parse response
  let tasks: AgentTask[];
  try {
    const parsed = JSON.parse(response.content);
    // Handle both { tasks: [...] } and bare [...]
    const rawTasks = Array.isArray(parsed) ? parsed : (parsed.tasks || [parsed]);
    const maxIndex = request.recentHistory.length - 1;
    tasks = rawTasks.map((t: any) => ({
      task: t.task || t.instruction || request.prompt,
      topic: t.topic || "Task",
      systemPrompt: t.systemPrompt || t.system_prompt || "",
      selectedToolIds: t.selectedToolIds || t.selected_tool_ids || t.tools || [],
      modelRole: t.modelRole || t.model_role || "workhorse",
      // Clamp LLM-generated indices to valid history bounds
      relevantMessageIndices: (t.relevantMessageIndices || t.relevant_message_indices || [])
        .filter((i: unknown) => typeof i === "number" && Number.isInteger(i) && i >= 0 && i <= maxIndex),
    }));
  } catch (e) {
    log.warn("Failed to parse persona-writer output, creating fallback task", { error: e });
    tasks = [createFallbackTask(request, decision)];
  }

  // Validate — at least one task with a non-empty system prompt
  if (tasks.length === 0 || tasks.every(t => !t.systemPrompt)) {
    log.warn("Persona writer produced no valid tasks, using fallback");
    tasks = [createFallbackTask(request, decision)];
  }

  log.info("Personas written", {
    taskCount: tasks.length,
    topics: tasks.map(t => t.topic),
    toolCounts: tasks.map(t => t.selectedToolIds.length),
  });

  return tasks;
}

// ============================================
// FALLBACK
// ============================================

/**
 * Create a fallback task when the persona writer fails.
 * Uses a generic but functional system prompt.
 */
function createFallbackTask(
  request: EnhancedPromptRequest,
  decision: ReceptionistDecision
): AgentTask {
  // Include all recent history indices since we don't know which are relevant
  // This is safer than [] which would cause the router to include NO messages
  const allIndices = request.recentHistory.map((_, i) => i);

  return {
    task: decision.formattedRequest || request.prompt,
    topic: "Assistant",
    systemPrompt: `You are a helpful, capable assistant. Complete the user's request thoroughly and accurately. If you need to use tools, use them. If you realize you don't have the right tools, call agent.escalate.\n\nBe direct, actionable, and conversational. Don't be overly formal.`,
    selectedToolIds: [...FALLBACK_TOOL_IDS],
    modelRole: "workhorse",
    relevantMessageIndices: allIndices,
  };
}
