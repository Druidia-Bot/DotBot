/**
 * Memory Condenser
 * 
 * Called by the local agent's sleep cycle. Receives a thread + model context,
 * uses an LLM to analyze the conversation, and returns structured instructions
 * that the local agent applies programmatically.
 * 
 * The LLM NEVER rewrites full models — it only returns atomic operations:
 * add_belief, remove_belief, close_loop, archive_thread, etc.
 */

import { createLLMClient, selectModel } from "../llm/providers.js";
import type { ExecutionCommand } from "../types.js";
import { runToolLoop, type ToolLoopOptions } from "./tool-loop.js";
import type { ToolManifestEntry } from "./tools.js";

const CONDENSER_SYSTEM_PROMPT = `You are a Memory Condenser for DotBot. Your job is to analyze a conversation thread and extract structured knowledge that should be permanently stored in mental models.

You receive:
- A conversation thread (messages between user and assistant)
- An index of existing mental models (slug, name, category, keywords)
- Full data for models the system thinks are relevant

You return a JSON object with:
- "instructions": an array of atomic operations to apply to the memory system
- "reasoning": a brief explanation of your decisions

## Available Instructions

### Model Operations
- { "action": "create_model", "slug": "url-safe-slug", "name": "Human Name", "category": "person|place|object|project|concept|event|organization", "description": "Brief description" }
- { "action": "update_model_meta", "modelSlug": "...", "updates": { "description": "..." } }
- { "action": "update_keywords", "modelSlug": "...", "keywords": ["keyword1", "keyword2"] }

### Belief Operations
- { "action": "add_belief", "modelSlug": "...", "belief": { "id": "belief_xxx", "attribute": "what this is about", "value": "the believed value", "confidence": 0.0-1.0, "formedAt": "ISO date", "lastConfirmedAt": "ISO date" } }
- { "action": "update_belief", "modelSlug": "...", "beliefId": "...", "updates": { "value": "new value", "confidence": 0.9 } }
- { "action": "remove_belief", "modelSlug": "...", "beliefId": "...", "reason": "why" }

### Constraint Operations
- { "action": "add_constraint", "modelSlug": "...", "constraint": { "id": "constraint_xxx", "description": "...", "type": "hard|soft", "identifiedAt": "ISO date", "source": "conversation" } }
- { "action": "remove_constraint", "modelSlug": "...", "constraintId": "...", "reason": "why" }

### Open Loop Operations
- { "action": "add_open_loop", "modelSlug": "...", "loop": { "id": "loop_xxx", "description": "what is unresolved", "importance": "low|medium|high", "identifiedAt": "ISO date", "resolutionCriteria": "what would close this", "toolHint": "web_search|email_lookup|calendar_check|none" } }
- { "action": "close_loop", "modelSlug": "...", "loopId": "...", "resolution": "how it was resolved" }

### Relationship Operations
- { "action": "add_relationship", "modelSlug": "...", "relationship": { "type": "works_with|owns|lives_at|part_of|related_to|...", "targetSlug": "...", "direction": "outgoing|incoming|bidirectional", "identifiedAt": "ISO date", "confidence": 0.8 } }

### Conversation & Thread Operations
- { "action": "add_conversation_ref", "modelSlug": "...", "ref": { "timestamp": "ISO date", "summary": "brief summary", "keyPoints": ["point1", "point2"] } }
- { "action": "condense_thread", "threadId": "...", "summary": "condensed summary of the full conversation", "keyPoints": ["key point 1", "key point 2"], "preserveLastN": 3 }
- { "action": "archive_thread", "threadId": "..." }

### Identity Operations (RARE — only for core identity changes)
These modify the agent's self-model (me.json). Use ONLY when the user explicitly tells the agent something about itself — e.g., "your name is X", "always respond in Y style", "my email is Z". Do NOT use for normal conversation facts.
- { "action": "identity_set_name", "value": "new name" }
- { "action": "identity_set_role", "value": "new role description" }
- { "action": "identity_add_trait", "value": "new personality trait" }
- { "action": "identity_remove_trait", "value": "trait to remove" }
- { "action": "identity_add_ethic", "value": "new ethical boundary" }
- { "action": "identity_remove_ethic", "value": "ethic to remove" }
- { "action": "identity_add_conduct", "value": "new behavioral rule" }
- { "action": "identity_remove_conduct", "value": "conduct rule to remove" }
- { "action": "identity_set_property", "key": "property_name", "value": "property_value" }
- { "action": "identity_remove_property", "key": "property_name" }
- { "action": "identity_add_instruction", "value": "instruction from the human" }
- { "action": "identity_remove_instruction", "value": "instruction to remove" }
- { "action": "identity_add_communication_style", "value": "style keyword" }
- { "action": "identity_remove_communication_style", "value": "style keyword to remove" }

## Rules

1. **Extract EVERYTHING important.** Facts, preferences, decisions, constraints, relationships, unresolved items. If the user said it, capture it.
2. **New beliefs get high confidence (0.85-0.95).** The user just said it — it's fresh.
3. **Repeated beliefs get confidence boost.** If a belief already exists and is confirmed, bump confidence.
4. **Contradictions should remove the old belief and add the new one.** Include reason.
5. **Open loops with toolHint** — if an unresolved item could potentially be resolved by a tool (web search, email lookup, etc.), set the toolHint so the system can try to resolve it automatically.
6. **Always add a conversation_ref** to each model you touch, summarizing what was discussed.
7. **Always condense the thread** at the end — replace verbose messages with a summary + key points.
8. **Create new models** for entities that don't exist yet but were discussed substantially.
9. **Update keywords** for any model whose relevant topics expanded.
10. **Be precise with slugs.** Use the existing model slugs from the index. For new models, use lowercase-hyphenated format.

Respond ONLY with valid JSON. No markdown, no explanation outside the JSON.`;

export interface CondenserOptions {
  apiKey: string;
  provider?: "deepseek" | "anthropic" | "openai";
}

export async function runCondenser(
  request: {
    thread: any;
    modelIndex: { slug: string; name: string; category: string; keywords: string[] }[];
    relevantModels: any[];
    lastCycleAt?: string;
  },
  options: CondenserOptions
): Promise<{ instructions: any[]; reasoning: string }> {
  const llm = createLLMClient({ apiKey: options.apiKey, provider: options.provider || "deepseek" });
  const modelConfig = selectModel({ personaModelTier: "smart" });

  // Build the user message with all context
  const modelIndexStr = request.modelIndex
    .map(m => `- ${m.slug}: "${m.name}" (${m.category}) [${m.keywords.join(", ")}]`)
    .join("\n");

  const relevantModelsStr = request.relevantModels.length > 0
    ? request.relevantModels.map(m => 
        `### ${m.name} (${m.slug})\n` +
        `Category: ${m.category}\n` +
        `Beliefs: ${(m.beliefs || []).map((b: any) => `${b.attribute}=${JSON.stringify(b.value)} (confidence: ${b.confidence})`).join(", ") || "none"}\n` +
        `Open Loops: ${(m.openLoops || []).filter((l: any) => l.status !== "resolved").map((l: any) => `[${l.id}] ${l.description}`).join(", ") || "none"}\n` +
        `Constraints: ${(m.constraints || []).filter((c: any) => c.active).map((c: any) => `[${c.type}] ${c.description}`).join(", ") || "none"}\n`
      ).join("\n")
    : "No relevant models loaded.";

  // Filter messages to only those after lastCycleAt if provided
  let messages = request.thread.messages || [];
  if (request.lastCycleAt) {
    const cutoff = new Date(request.lastCycleAt).getTime();
    messages = messages.filter((m: any) => {
      const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
      return ts > cutoff;
    });
  }

  if (messages.length === 0) {
    return { instructions: [], reasoning: "No new messages since last cycle." };
  }

  const conversationStr = messages
    .map((m: any) => `[${m.role || "unknown"}]: ${m.content}`)
    .join("\n");

  const userMessage = `## Thread: "${request.thread.topic || "Untitled"}" (ID: ${request.thread.id})

### Conversation (${messages.length} messages):
${conversationStr}

### Existing Model Index:
${modelIndexStr || "No existing models."}

### Relevant Models (full data):
${relevantModelsStr}

Analyze this conversation and return your instructions as JSON.`;

  const response = await llm.chat(
    [
      { role: "system", content: CONDENSER_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    {
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
      temperature: 0.3, // Low temperature for structured extraction
    }
  );

  // Parse JSON response
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { instructions: [], reasoning: "Condenser returned no JSON." };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      instructions: parsed.instructions || [],
      reasoning: parsed.reasoning || "",
    };
  } catch (e) {
    return { instructions: [], reasoning: `Parse error: ${e}` };
  }
}

// ============================================
// LOOP RESOLVER
// ============================================

const LOOP_RESOLVER_SYSTEM_PROMPT = `You are a Loop Resolver for DotBot. Your job is to try to close open loops (unresolved items) using available tools.

You receive an open loop with context about the entity it belongs to. You should:

1. Analyze what information would close this loop
2. If a tool could help (web search, email lookup, etc.), use it
3. Compose a notification for the user in TWO cases:
   a. You fully resolved the loop — set notifyUser: true, newStatus: "resolved"
   b. You found substantial NEW information that the user doesn't already know,
      even if you couldn't fully resolve the loop — set notifyUser: true,
      newStatus: "investigating", and explain what you found and how it
      helps them move toward closing this loop
4. If you can't resolve it AND found nothing substantial, mark it as blocked
5. Do NOT notify for minor or inconclusive findings — only notify when the
   information is actionable or changes the user's understanding of the situation

Return a JSON object:
{
  "resolved": true/false,
  "resolution": "what was found (if resolved)",
  "blockedReason": "why we can't resolve this (if not resolved)",
  "notifyUser": true/false,
  "notification": "Hey! I found something about [topic]... [details]",
  "newStatus": "resolved|blocked|investigating",
  "sideEffects": [] // Optional: additional CondenserInstructions if the research revealed new facts
}

Respond ONLY with valid JSON.`;

export async function runLoopResolver(
  request: {
    loop: any;
    modelSlug: string;
    modelName: string;
    contextBeliefs: { attribute: string; value: any }[];
    availableTools: string[];
  },
  options: CondenserOptions,
  toolOptions?: {
    executeCommand: (command: ExecutionCommand) => Promise<string>;
    toolManifest: ToolManifestEntry[];
  }
): Promise<any> {
  const llm = createLLMClient({ apiKey: options.apiKey, provider: options.provider || "deepseek" });
  const modelConfig = selectModel({ personaModelTier: "smart" });

  const beliefsStr = request.contextBeliefs
    .map(b => `- ${b.attribute}: ${JSON.stringify(b.value)}`)
    .join("\n");

  const userMessage = `## Open Loop to Resolve

**Model:** ${request.modelName} (${request.modelSlug})
**Loop:** ${request.loop.description}
**Importance:** ${request.loop.importance}
**Resolution Criteria:** ${request.loop.resolutionCriteria}
**Tool Hint:** ${request.loop.toolHint || "none"}

### Context (what we know about ${request.modelName}):
${beliefsStr || "No beliefs yet."}

Use the tools available to you (web search, HTTP requests) to find information that would close this loop. After researching, respond with your findings as JSON.`;

  // If tool execution is available, use the tool loop so the LLM can
  // actually perform searches and HTTP requests to resolve the loop.
  if (toolOptions) {
    // Filter manifest to only search + http tools (all that's needed for research)
    const researchTools = toolOptions.toolManifest.filter(
      t => ["search", "http"].includes(t.category)
    );

    if (researchTools.length > 0) {
      const result = await runToolLoop(
        llm,
        LOOP_RESOLVER_SYSTEM_PROMPT,
        userMessage,
        "loop-resolver",
        {
          model: modelConfig.model,
          maxTokens: modelConfig.maxTokens,
          temperature: 0.3,
        },
        {
          maxIterations: 3,
          executeCommand: toolOptions.executeCommand,
          toolManifest: researchTools,
        }
      );

      return parseLoopResolverResponse(result.response);
    }
  }

  // Fallback: LLM-only reasoning (no tools available)
  const response = await llm.chat(
    [
      { role: "system", content: LOOP_RESOLVER_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    {
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
      temperature: 0.3,
    }
  );

  return parseLoopResolverResponse(response.content);
}

function parseLoopResolverResponse(content: string): any {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        resolved: false,
        blockedReason: "Resolver returned no JSON",
        notifyUser: false,
        newStatus: "blocked",
      };
    }
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {
      resolved: false,
      blockedReason: "Failed to parse resolver response",
      notifyUser: false,
      newStatus: "blocked",
    };
  }
}
