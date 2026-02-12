/**
 * Task Execution — V2
 *
 * Handles executing tasks with personas using the agentic tool loop.
 * Supports memory context injection, knowledge retrieval, and skill execution.
 */

import { nanoid } from "nanoid";
import { getPersona } from "../personas/loader.js";
import {
  type ILLMClient,
  type ModelSelection,
  selectModel,
  createClientForSelection,
  estimateTokens,
  detectLargeFileContext,
  detectArchitectTask,
} from "../llm/providers.js";
import { createComponentLogger } from "../logging.js";
import { injectRelevantKnowledge } from "../knowledge/index.js";
import { runToolLoop } from "./tool-loop.js";
import type { AgentRunnerOptions } from "./runner.js";
import type {
  EnhancedPromptRequest,
  ReceptionistDecision,
  PersonaDefinition,
} from "../types/agent.js";
import * as db from "../db/index.js";

const log = createComponentLogger("agents.execution");

// ============================================
// MODEL SELECTION HELPER
// ============================================

import type { ModelSelectionCriteria } from "../llm/types.js";
import { isCloudReachable } from "../llm/local-llm.js";

/**
 * Run selectModel() and return the appropriate LLM client.
 * If the selection picks the same provider as the current client, reuse it.
 * If it picks a different provider, create a new client for that provider.
 *
 * Automatically checks cloud connectivity so isOffline is set correctly.
 * The connectivity check is cached (60s TTL) so this is cheap to call.
 */
export async function resolveModelAndClient(
  currentLlm: ILLMClient,
  criteria: ModelSelectionCriteria
): Promise<{ selectedModel: ModelSelection; client: ILLMClient }> {
  // Check cloud connectivity if not already set in criteria
  if (criteria.isOffline === undefined) {
    const reachable = await isCloudReachable();
    if (!reachable) {
      criteria.isOffline = true;
    }
  }

  const selectedModel = selectModel(criteria);

  // If the selection matches the current client's provider, reuse it
  if (selectedModel.provider === currentLlm.provider) {
    return { selectedModel, client: currentLlm };
  }

  // Different provider needed — create a new client
  try {
    const client = createClientForSelection(selectedModel);
    return { selectedModel, client };
  } catch (error) {
    // If we can't create the new client (e.g. missing API key), fall back to current
    log.warn(`Failed to create client for ${selectedModel.provider}, falling back to ${currentLlm.provider}`, { error });
    return { selectedModel, client: currentLlm };
  }
}

// ============================================
// MEMORY CONTEXT INJECTION
// ============================================

/**
 * Score an L0 model index entry against a task description.
 * Returns 0+ score — higher = more relevant.
 */
function scoreModelAgainstTask(
  model: { name: string; category: string; keywords: string[] },
  taskDescription: string
): number {
  const taskLower = taskDescription.toLowerCase();
  const taskWords = taskLower.split(/\s+/).filter(w => w.length > 2);
  let score = 0;

  // Name match (high weight)
  const nameLower = model.name.toLowerCase();
  if (taskLower.includes(nameLower)) score += 10;
  for (const word of taskWords) {
    if (nameLower.includes(word)) score += 3;
  }

  // Category match
  if (taskLower.includes(model.category)) score += 2;

  // Keyword match
  for (const keyword of model.keywords) {
    for (const word of taskWords) {
      if (keyword.includes(word) || word.includes(keyword)) score += 2;
    }
  }

  return score;
}

/** Max number of model skeletons to inject into context */
const MAX_SKELETON_MODELS = 5;
/** Minimum score to consider a model relevant to the task */
const MIN_MODEL_RELEVANCE_SCORE = 4;
/** Max characters for skeleton injection */
const MAX_SKELETON_CHARS = 2000;

/**
 * Build a compact memory context section from the request's mental model
 * index and thread summary. Scores models against the task description
 * and fetches compact skeletons for relevant ones — so the LLM sees
 * structure (beliefs, relationships, open loops) and can dig deeper via tools.
 */
async function buildMemoryContextSection(
  request: EnhancedPromptRequest,
  taskDescription?: string,
  fetchSkeletons?: (action: string, data: Record<string, any>) => Promise<any>
): Promise<string> {
  const sections: string[] = [];

  // Agent identity (who you are)
  if (request.agentIdentity) {
    sections.push(`## Who You Are\n\n${request.agentIdentity}\n\nThis is your core identity. Follow your ethics and code of conduct at all times. Human instructions override defaults when they don't conflict with ethics.`);
  }

  // Mental model summaries — score against task and inject skeletons for relevant ones
  if (request.memoryIndex && request.memoryIndex.length > 0) {
    let skeletonSection = "";

    if (taskDescription && fetchSkeletons) {
      // Score each model against the task
      const scored = request.memoryIndex
        .map(m => ({ model: m, score: scoreModelAgainstTask(m, taskDescription) }))
        .sort((a, b) => b.score - a.score);

      const relevantSlugs = scored
        .filter(s => s.score >= MIN_MODEL_RELEVANCE_SCORE)
        .slice(0, MAX_SKELETON_MODELS)
        .map(s => s.model.slug)
        .filter((slug): slug is string => !!slug);

      // Fetch skeletons for relevant models
      if (relevantSlugs.length > 0) {
        try {
          const skeletons: Record<string, string> = await fetchSkeletons(
            "get_model_skeletons",
            { slugs: relevantSlugs }
          );
          if (skeletons && typeof skeletons === "object") {
            const skeletonLines: string[] = [];
            let totalChars = 0;
            for (const slug of relevantSlugs) {
              const skel = skeletons[slug];
              if (skel && totalChars + skel.length <= MAX_SKELETON_CHARS) {
                skeletonLines.push(skel);
                totalChars += skel.length;
              }
            }
            if (skeletonLines.length > 0) {
              skeletonSection = `\n\n### Relevant Model Details\n\nThese models are likely relevant to the current task. You can use memory tools to dig deeper into any of them.\n\n${skeletonLines.join("\n\n")}`;
              log.debug(`Injected ${skeletonLines.length} model skeletons (${totalChars} chars)`);
            }
          }
        } catch (err) {
          log.warn("Failed to fetch model skeletons", { error: err });
        }
      }
    }

    // Always show all model names (relevant ones get skeletons above, others just names)
    const allModelLines = request.memoryIndex
      .map(m => `- **${m.name}** (${m.category}): ${m.keywords.join(", ")}`)
      .join("\n");
    sections.push(`## What You Know About the User\n\nYou have the following mental models (stored knowledge) about the user and their world:\n\n${allModelLines}\n\nUse this knowledge to personalize your responses. If the user asks what you know about them or something they feel you should know, reference these models. Use memory tools to read full model content when needed.${skeletonSection}`);
  }

  // Thread context (compact)
  if (request.threadIndex?.threads?.length > 0) {
    const recentThreads = request.threadIndex.threads
      .slice(0, 5)
      .map(t => `- "${t.topic}" (${t.status})`)
      .join("\n");
    sections.push(`## Recent Conversation Threads\n\n${recentThreads}`);
  }

  // Knowledge awareness — remind the LLM it can search for more info
  sections.push(`## Knowledge Base\n\nYou have a searchable knowledge base with stored reference documents. If you need factual details, technical references, or context you don't already have, use \`knowledge.list\` to see available docs or \`knowledge.search\` to find specific information.`);

  return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
}

/**
 * Build the message array with conversation history from the request.
 * Returns [system, ...history, user] for proper multi-turn context.
 */
function buildMessagesWithHistory(
  systemPrompt: string,
  userMessage: string,
  request?: EnhancedPromptRequest
): { role: "system" | "user" | "assistant"; content: string }[] {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];

  // Include conversation history as proper turns
  if (request?.recentHistory?.length) {
    for (const entry of request.recentHistory) {
      messages.push({
        role: entry.role === "user" ? "user" : "assistant",
        content: entry.content,
      });
    }
  }

  messages.push({ role: "user", content: userMessage });
  return messages;
}

// ============================================
// SINGLE-PERSONA EXECUTION (agentic tool loop)
// ============================================

/** Result from persona execution — includes both the response and work context */
export interface PersonaExecutionResult {
  /** The user-facing response text */
  response: string;
  /** When true, persona called agent.escalate or got stuck — needs re-routing through planner */
  escalated?: boolean;
  /** Tool categories the persona said it needs */
  neededToolCategories?: string[];
  /** Why the escalation happened */
  escalationReason?: string;
  /** Brief work log summarizing what tools were used and key results */
  workLog: string;
  /** Raw tool call data for V2 workspace logging (tool-calls.jsonl) */
  toolCallsMade?: { tool: string; args: Record<string, any>; result: string; success: boolean }[];
}

/**
 * Build a brief work log from tool calls for thread persistence.
 * This gives future agent runs context about what was already done,
 * preventing redundant tool calls across conversation turns.
 */
export function buildWorkLog(
  toolCalls: { tool: string; args: Record<string, any>; result: string; success: boolean }[],
  iterations: number
): string {
  if (toolCalls.length === 0) return "";

  const lines = toolCalls.map(tc => {
    // Truncate result to keep work log compact
    const resultPreview = tc.result.length > 150
      ? tc.result.substring(0, 150) + "..."
      : tc.result;
    const status = tc.success ? "\u2713" : "\u2717";
    return `${status} ${tc.tool}: ${resultPreview}`;
  });

  return [
    `[Agent Work Log \u2014 ${toolCalls.length} tool calls, ${iterations} iterations]`,
    ...lines,
    `[/Work Log]`,
  ].join("\n");
}

/**
 * Execute a task with a persona using the agentic tool loop.
 * If tools are available (onExecuteCommand callback set), the persona
 * can actually DO things on the user's machine. Otherwise falls back
 * to text-only mode.
 * 
 * Returns both the response and a work log for thread persistence.
 */
export async function executeWithPersona(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  persona: PersonaDefinition,
  taskDescription: string,
  request: EnhancedPromptRequest,
  injectionQueue?: string[],
  getAbortSignal?: () => AbortSignal | undefined,
  modelRoleHint?: "workhorse" | "deep_context" | "architect" | "gui_fast",
  extraToolCategories?: string[],
  onWaitForUser?: (reason: string, resumeHint?: string, timeoutMs?: number) => Promise<string>,
  /** V2: When provided, filters manifest to these specific tool IDs instead of using category-based filtering. */
  selectedToolIds?: string[]
): Promise<PersonaExecutionResult> {
  // Select model based on: persona.modelRole (highest) > receptionist hint > task detection
  const { selectedModel, client: taskLlm } = await resolveModelAndClient(llm, {
    explicitRole: persona.modelRole || modelRoleHint || undefined,
    personaModelTier: persona.modelTier,
    estimatedTokens: estimateTokens(taskDescription + persona.systemPrompt),
    hasLargeFiles: detectLargeFileContext(taskDescription),
    isArchitectTask: persona.modelTier === "powerful" || detectArchitectTask(taskDescription),
  });
  log.info(`Model selected for ${persona.id}`, {
    role: selectedModel.role,
    provider: selectedModel.provider,
    model: selectedModel.model,
    reason: selectedModel.reason,
  });

  // Load relevant knowledge for this persona and task
  let knowledgeSection = "";
  try {
    const knowledgeInjection = await injectRelevantKnowledge(
      persona.id,
      taskDescription,
      { maxCharacters: 4000, format: "markdown" }
    );
    if (knowledgeInjection.characterCount > 0) {
      knowledgeSection = `\n\n${knowledgeInjection.content}`;
      log.debug(`Injected ${knowledgeInjection.characterCount} chars of knowledge for ${persona.id}`, {
        included: knowledgeInjection.includedDocuments,
      });
    }
  } catch (error) {
    log.warn(`Failed to load knowledge for ${persona.id}:`, { error });
  }

  // Build memory context from the request's mental models and thread index
  const memoryContext = await buildMemoryContextSection(request, taskDescription, options.onPersistMemory);
  const systemPrompt = `${persona.systemPrompt}${knowledgeSection}${memoryContext}`;

  // Build user message: always preserve the original prompt content.
  // The taskDescription may be a receptionist-reformulated instruction that
  // strips inline content (e.g. a pasted document). When they differ,
  // include both the routing instruction AND the full original message.
  let userMessage: string;
  if (taskDescription !== request.prompt && taskDescription.length < request.prompt.length * 0.8) {
    userMessage = `${taskDescription}\n\n---\nUser's original message:\n${request.prompt}`;
  } else {
    userMessage = taskDescription;
  }

  // Inject codegen nudge when available — weaker models need explicit instruction
  let personaToolCategories = [...(persona.tools || [])];
  const hasCodegen = personaToolCategories.includes("codegen") || personaToolCategories.includes("all");
  if (hasCodegen && options.runtimeInfo) {
    const codegenRuntime = options.runtimeInfo.find((r: any) =>
      (r.name === "claude" || r.name === "codex") && r.available
    );
    if (codegenRuntime) {
      const agentName = codegenRuntime.name === "claude" ? "Claude Code" : "Codex CLI";
      userMessage += `\n\n---\n**IMPORTANT: ${agentName} is installed and available.** For any task that creates or edits multiple files, use \`codegen.execute\` instead of manual file tools. Break large tasks into 2-3 codegen calls.`;
    }
  }

  // Auto-discover relevant skills and inject into context
  let skillMatched = false;
  if (options.onSearchSkills && options.onReadSkill) {
    try {
      const allMatches = await options.onSearchSkills(taskDescription);
      // Filter out skills that opted out of auto-injection (disableModelInvocation).
      // These skills should only run when explicitly routed by the planner or user.
      const skillMatches = allMatches.filter((s: any) => !s.disableModelInvocation);
      if (skillMatches.length > 0) {
        // Read top 2 matching skills (avoid flooding context)
        const topSlugs = skillMatches.slice(0, 2).map((s: any) => s.slug);
        const skillContents: string[] = [];
        for (const slug of topSlugs) {
          const skill = await options.onReadSkill(slug);
          if (skill?.content) {
            skillContents.push(`### Skill: ${skill.name}\n${skill.content}`);
          }
        }
        if (skillContents.length > 0) {
          skillMatched = true;
          userMessage += `\n\n---\n**SKILL INSTRUCTIONS — EXECUTE THESE NOW:**\nYou MUST follow these step-by-step instructions by making tool calls. Do NOT just describe or explain what you would do — actually call the tools. The skill below is your execution recipe.\n\n${skillContents.join("\n\n---\n\n")}`;
          log.info(`Injected ${skillContents.length} skill(s) into context`, {
            persona: persona.id,
            skills: topSlugs,
          });
        }

        // Expand persona's tool categories with skill-required categories.
        // This gives the persona targeted access to tools the skill needs
        // without swapping to an 'all' persona that floods the manifest.
        if (!personaToolCategories.includes("all")) {
          const skillCategories = new Set<string>();
          for (const match of skillMatches.slice(0, 2)) {
            if (match.allowedTools?.length) {
              for (const tool of match.allowedTools) {
                const cat = tool.split(".")[0];
                if (cat) skillCategories.add(cat);
              }
            }
          }
          const missing = [...skillCategories].filter(cat => !personaToolCategories.includes(cat));
          if (missing.length > 0) {
            personaToolCategories = [...personaToolCategories, ...missing];
            log.info(`Expanded tool categories for skill execution`, {
              persona: persona.id,
              added: missing,
              total: personaToolCategories,
            });
          }
        }
      }
    } catch (error) {
      log.warn("Skill auto-discovery failed (non-fatal)", { error });
    }
  }

  // Merge planner-recommended tool categories (proactive — even without skill matches)
  if (extraToolCategories?.length && !personaToolCategories.includes("all")) {
    const plannerMissing = extraToolCategories.filter(cat => !personaToolCategories.includes(cat));
    if (plannerMissing.length > 0) {
      personaToolCategories = [...personaToolCategories, ...plannerMissing];
      log.info(`Expanded tool categories from planner recommendation`, {
        persona: persona.id,
        added: plannerMissing,
        total: personaToolCategories,
      });
    }
  }

  // For background agent tasks without a skill match, inject a "plan first" instruction.
  // When a skill matches, the skill IS the plan — adding "output a plan first" causes the
  // LLM to output text without tool calls, making the tool loop exit prematurely.
  if (injectionQueue && !skillMatched) {
    userMessage += `\n\n---\n**PLANNING REQUIREMENT:** Before making any tool calls, first output a brief numbered plan (3-8 steps) of what you will do. Keep it concise — one line per step. Then proceed to execute the plan. If a step fails, adapt and update the plan.`;
  }

  // Determine which tools this persona is allowed to use
  const hasNoTools = personaToolCategories.includes("none") || personaToolCategories.length === 0;
  const hasAllTools = personaToolCategories.includes("all");

  // Filter tool manifest: V2 ID-based slicing takes priority over V1 category filtering
  let filteredManifest = options.toolManifest;
  if (filteredManifest && selectedToolIds && selectedToolIds.length > 0) {
    // V2 path: receptionist picked specific tool IDs for this agent
    const idSet = new Set(selectedToolIds);
    filteredManifest = filteredManifest.filter((t: any) => idSet.has(t.id));
    log.info("Tool manifest sliced by selected IDs", {
      persona: persona.id,
      requested: selectedToolIds.length,
      matched: filteredManifest.length,
    });
  } else if (filteredManifest && !hasAllTools && !hasNoTools) {
    // V1 path: filter by persona's allowed categories
    filteredManifest = filteredManifest.filter((t: any) =>
      personaToolCategories.includes(t.category) || t.id === "tools.list_tools"
    );
  }

  // If persona explicitly disables tools, skip the tool loop
  if (hasNoTools) {
    log.info("Persona has no tools, using plain text mode", { persona: persona.id });
    const response = await executeWithPersonaPlain(llm, options, persona, userMessage, request);
    return { response, workLog: "" };
  }

  // If we have tool execution capability, use the agentic tool loop
  if (options.onExecuteCommand) {
    log.info("Using agentic tool loop", {
      persona: persona.id,
      toolCategories: hasAllTools ? "all" : personaToolCategories,
      toolCount: filteredManifest?.length || 0,
    });

    const result = await runToolLoop(
      taskLlm,
      systemPrompt,
      userMessage,
      persona.id,
      {
        model: selectedModel.model,
        maxTokens: selectedModel.maxTokens,
        temperature: selectedModel.temperature,
        // thinking: selectedModel.provider === "deepseek" ? true : undefined,  // Disabled: adds ~40s latency per call
      },
      {
        maxIterations: 50,
        executeCommand: options.onExecuteCommand,
        toolManifest: filteredManifest,
        runtimeInfo: options.runtimeInfo,
        conversationHistory: request.recentHistory,
        executePremiumTool: options.onExecutePremiumTool,
        executeImageGenTool: options.onExecuteImageGenTool,
        executeKnowledgeIngest: options.onExecuteKnowledgeIngest,
        executeScheduleTool: options.onExecuteScheduleTool,
        skillMatched,
        injectionQueue,
        onWaitForUser,
        getAbortSignal,
        onStream: options.onStream,
        onLLMResponse: options.onLLMResponse,
        onToolCall: (tool, args) => {
          log.info(`Tool call: ${tool}`, { persona: persona.id, args });
          const argsSummary = Object.keys(args).slice(0, 3).map(k => `${k}=${String(args[k]).substring(0, 40)}`).join(", ");
          options.onTaskProgress?.({
            taskId: `tool_${nanoid(8)}`,
            status: "running",
            message: `Using ${tool}${argsSummary ? ` (${argsSummary})` : ""}`,
            persona: persona.id,
            tool,
            eventType: "tool_call",
          });
        },
        onToolResult: (tool, result, success) => {
          log.info(`Tool result: ${tool} ${success ? "✓" : "✗"}`, {
            persona: persona.id,
            resultLength: result.length,
          });
          options.onTaskProgress?.({
            taskId: `tool_${nanoid(8)}`,
            status: "running",
            message: `${tool} ${success ? "✓" : "✗"} (${result.length} chars)`,
            persona: persona.id,
            tool,
            eventType: "tool_result",
            success,
          });
        },
      }
    );

    log.info("Tool loop completed", {
      persona: persona.id,
      iterations: result.iterations,
      toolCalls: result.toolCallsMade.length,
      completed: result.completed,
      escalated: result.escalated,
    });

    return {
      response: result.response,
      workLog: buildWorkLog(result.toolCallsMade, result.iterations),
      escalated: result.escalated,
      neededToolCategories: result.neededToolCategories,
      escalationReason: result.escalationReason,
      toolCallsMade: result.toolCallsMade,
    };
  }

  // Fallback: no tool execution, just text response
  const plainResponse = await executeWithPersonaPlain(taskLlm, options, persona, userMessage, request, selectedModel);
  return { response: plainResponse, workLog: "" };
}

/**
 * Execute with persona in plain text mode (no tool calling).
 * Used as fallback and for delegation to avoid infinite loops.
 */
export async function executeWithPersonaPlain(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  persona: PersonaDefinition,
  taskDescription: string,
  request?: EnhancedPromptRequest,
  preSelectedModel?: ModelSelection
): Promise<string> {
  const resolved = preSelectedModel ? null : await resolveModelAndClient(llm, { personaModelTier: persona.modelTier });
  const sel = preSelectedModel || resolved!.selectedModel;
  const client = preSelectedModel ? llm : resolved!.client;

  const memoryContext = request ? await buildMemoryContextSection(request, taskDescription, options.onPersistMemory) : "";
  const systemPrompt = `${persona.systemPrompt}${memoryContext}\n\n## Task\nComplete the following task and respond conversationally. If you need to provide code or commands, explain what they do. If you cannot complete the task, explain why.\n\nRespond in plain text (not JSON).`;

  const messages = buildMessagesWithHistory(systemPrompt, taskDescription, request);

  // Debug callback
  options.onLLMRequest?.({
    persona: persona.id,
    provider: sel.provider,
    model: sel.model,
    promptLength: messages.reduce((acc, m) => acc + m.content.length, 0),
    maxTokens: sel.maxTokens,
    messages,
  });

  const startTime = Date.now();
  const response = await client.chat(messages, {
    model: sel.model,
    maxTokens: sel.maxTokens,
    temperature: sel.temperature,
  });

  options.onLLMResponse?.({
    persona: persona.id,
    duration: Date.now() - startTime,
    responseLength: response.content.length,
    response: response.content,
    model: response.model,
    provider: response.provider,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  });

  return response.content;
}

