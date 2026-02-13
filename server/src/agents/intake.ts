/**
 * Intake Agent Stages — V2
 *
 * Standalone functions for intake persona stages:
 * - Receptionist: classifies and routes requests
 * - Judge: validates final responses (quality gate)
 * - Updater: extracts memory deltas (runs in background)
 *
 * Each function accepts an LLM client and runner options so they
 * can be tested independently of the AgentRunner class.
 */

import { nanoid } from "nanoid";
import {
  getReceptionist,
  getUpdater,
  getJudge,
  getPersona,
  getInternalPersonas,
} from "../personas/loader.js";
import type { ILLMClient } from "../llm/providers.js";
import { resolveModelAndClient } from "./execution.js";
import type { MemoryDelta } from "../types.js";
import * as memory from "../memory/manager.js";
import { createComponentLogger } from "../logging.js";
import { getSystemContext, generateToolCapabilitiesSummary } from "./tools.js";
import { generateCompactCatalog } from "../tools/catalog.js";
import { validateReceptionistDecision } from "./validation.js";
import type { AgentRunnerOptions } from "./runner.js";
import type {
  EnhancedPromptRequest,
  ReceptionistDecision,
} from "../types/agent.js";

const log = createComponentLogger("agents.intake");

// ============================================
// RECEPTIONIST
// ============================================

export async function runReceptionist(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  userId: string
): Promise<ReceptionistDecision> {
  const receptionist = getReceptionist();
  if (!receptionist) throw new Error("Receptionist not loaded");

  const { selectedModel: modelConfig, client } = await resolveModelAndClient(llm, { explicitRole: "intake" });

  // Build context sections for system prompt
  const threadSummary =
    request.threadIndex.threads.length > 0
      ? request.threadIndex.threads
          .map(
            (t) =>
              `- ${t.id}: "${t.topic}" (${t.status}, last: ${t.lastActive})${t.entities?.length ? ` [entities: ${t.entities.join(", ")}]` : ""}${t.keywords?.length ? ` [keywords: ${t.keywords.join(", ")}]` : ""}`
          )
          .join("\n")
      : "No existing threads";

  const memorySummary =
    request.memoryIndex && request.memoryIndex.length > 0
      ? request.memoryIndex
          .map(
            (m) =>
              `- ${m.slug}: "${m.name}" (${m.category}) [${m.keywords.join(", ")}]`
          )
          .join("\n")
      : "No mental models";

  const councilSummary =
    request.matchedCouncils.length > 0
      ? request.matchedCouncils
          .map(
            (c) =>
              `- ${c.id}: ${c.name} - ${
                c.description
              } (matched: ${c.triggerMatches.join(", ")})`
          )
          .join("\n")
      : "No councils matched";

  // Build dynamic persona table from loaded definitions (internal + user-defined)
  // Filter out councilOnly personas — those are reserved for council review steps
  const internalPersonas = getInternalPersonas().filter(p => !p.councilOnly);
  const internalRows = internalPersonas
    .map((p) => `| ${p.id} | ${p.description || p.name} | built-in |`)
    .join("\n");
  const userRows = (request.userPersonas || [])
    .filter((p: any) => !p.councilOnly)
    .map((p) => `| ${p.id} | ${p.description || p.name} | user-defined |`)
    .join("\n");
  const allPersonaRows = [internalRows, userRows].filter(Boolean).join("\n");
  const personaTableSection = `\n\n## Available Personas\n\nThese are ALL the personas you can route to. Use the description to pick the best match.\n\n| Persona | Description | Source |\n|---------|-------------|--------|\n${allPersonaRows}\n\n**Important:** Do NOT invent persona IDs. Use ONLY personas listed above. Prefer user-defined personas when their description matches the request better than a built-in.\n`;

  // Build tool catalog — receptionist sees every tool ID + one-line description
  // so it can pick specific tools for each agent (V2 compact catalog).
  // Also keep persona tool access info for routing decisions.
  const personaToolMap: Record<string, string[]> = {};
  for (const p of internalPersonas) {
    if (p.tools && p.tools.length > 0) personaToolMap[p.id] = p.tools;
  }
  for (const p of (request.userPersonas || [])) {
    personaToolMap[p.id] = ["all"];
  }
  const compactCatalog = generateCompactCatalog(options.toolManifest || []);
  const toolCapabilities = generateToolCapabilitiesSummary(options.toolManifest, personaToolMap);

  // Build active tasks context
  const tasksSummary =
    request.activeTasks && request.activeTasks.length > 0
      ? request.activeTasks
          .map(
            (t) =>
              `- [${t.status.toUpperCase()}] ${t.id}: "${t.description}" (priority: ${t.priority}, persona: ${t.personaId || "none"}, retries: ${t.retryCount})${t.lastError ? ` ERROR: ${t.lastError}` : ""}${t.blockedReason ? ` BLOCKED: ${t.blockedReason}` : ""}`
          )
          .join("\n")
      : "No active tasks";

  // Build system prompt with context
  const systemContext = getSystemContext(options.runtimeInfo);
  const systemPrompt = `${receptionist.systemPrompt}${personaTableSection}

${compactCatalog}

${toolCapabilities}

${systemContext}

## Current Context

THREAD INDEX (L0):
${threadSummary}

MENTAL MODELS (L0):
${memorySummary}

MATCHED COUNCILS:
${councilSummary}

ACTIVE TASKS:
${tasksSummary}
${request.agentIdentity ? `\nAGENT IDENTITY:\n${request.agentIdentity}\n\nUse this identity context to honor the human's instructions and communication preferences when routing and responding.` : ""}

Analyze the conversation and provide your routing decision as JSON.`;

  // Debug logging: check if critical context is present
  log.debug("Receptionist context check", {
    hasSystemContext: systemContext.length > 0,
    hasAgentIdentity: !!request.agentIdentity,
    hasRuntimeInfo: !!(options.runtimeInfo && options.runtimeInfo.length > 0),
    systemContextLength: systemContext.length,
    systemPromptLength: systemPrompt.length,
    threadCount: request.threadIndex.threads.length,
    memoryCount: request.memoryIndex?.length || 0,
    councilCount: request.matchedCouncils.length,
  });

  // Build messages array with proper conversation history
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt }
  ];
  
  // Add conversation history as proper user/assistant turns
  for (const entry of request.recentHistory) {
    messages.push({
      role: entry.role === "user" ? "user" : "assistant",
      content: entry.content
    });
  }
  
  // Add current prompt as final user message
  messages.push({ role: "user", content: request.prompt });

  // Debug callback - LLM request
  options.onLLMRequest?.({
    persona: "receptionist",
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

  // Debug callback - LLM response
  options.onLLMResponse?.({
    persona: "receptionist",
    duration: Date.now() - startTime,
    responseLength: response.content.length,
    response: response.content,
    model: response.model,
    provider: response.provider,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  });

  // Parse JSON response
  let decision: ReceptionistDecision;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      // VALIDATION GATE: Ensure the parsed object is a valid ReceptionistDecision
      if (!validateReceptionistDecision(parsed)) {
        log.error("Receptionist returned malformed JSON — treating as invalid", {
          responseLength: response.content.length,
          parsedKeys: Object.keys(parsed),
        });
        throw new Error("Invalid ReceptionistDecision structure");
      }

      decision = parsed as ReceptionistDecision;

      // Sanitize directResponse: if the LLM set it to a raw classification keyword
      // (e.g. "CONVERSATIONAL", "ACTION"), strip it — the user would see pipeline internals.
      if (decision.directResponse) {
        const CLASSIFICATION_KEYWORDS = new Set([
          "CONVERSATIONAL", "ACTION", "INFO_REQUEST", "CONTINUATION",
          "CORRECTION", "COMPOUND", "GREETING", "ACKNOWLEDGMENT",
        ]);
        if (CLASSIFICATION_KEYWORDS.has(decision.directResponse.trim().toUpperCase())) {
          log.warn("Receptionist set directResponse to classification keyword — stripping", {
            directResponse: decision.directResponse,
            classification: decision.classification,
          });
          decision.directResponse = undefined;
        }
      }
    } else {
      throw new Error("No JSON found");
    }
  } catch (e) {
    // The receptionist returned text instead of JSON OR returned malformed JSON.
    // This usually means it answered the user's question directly.
    // Use that text as a directResponse rather than triggering the expensive planner pipeline.

    // However, if the response is extremely long (>2000 chars), it's likely garbage
    // from a model failure. In that case, send a clean error message instead.
    if (response.content.length > 2000) {
      log.error("Receptionist returned garbage output (very long non-JSON response)", {
        responseLength: response.content.length,
      });

      decision = {
        classification: "CONVERSATIONAL",
        priority: "BLOCKING",
        confidence: 0.3,
        threadIds: [],
        createNewThread: false,
        personaId: "general",
        councilNeeded: false,
        reasoning: "Receptionist encountered an error processing your request",
        directResponse: "I apologize, but I'm having trouble processing your request right now. Could you please try rephrasing it?",
        memoryAction: "none",
      };
    } else {
      log.warn("Receptionist returned text instead of JSON — using as direct response", {
        responseLength: response.content.length,
      });

      // Strip any markdown code fences or JSON fragments the LLM may have mixed in
      const cleanedResponse = response.content
        .replace(/```json[\s\S]*?```/g, "")
        .replace(/```[\s\S]*?```/g, "")
        .trim();

      // Guard: if the LLM just returned a classification keyword (e.g. "CONVERSATIONAL",
      // "ACTION") instead of a real response, don't use it as a direct response — the user
      // would see raw pipeline internals.
      const CLASSIFICATION_KEYWORDS = new Set([
        "CONVERSATIONAL", "ACTION", "INFO_REQUEST", "CONTINUATION",
        "CORRECTION", "COMPOUND", "GREETING", "ACKNOWLEDGMENT",
      ]);
      const isRawClassification = CLASSIFICATION_KEYWORDS.has(cleanedResponse.toUpperCase());
      if (isRawClassification) {
        log.warn("Receptionist returned raw classification keyword as text — discarding", {
          raw: cleanedResponse,
        });
      }

      decision = {
        classification: "CONVERSATIONAL",
        priority: "BLOCKING",
        confidence: 0.6,
        threadIds: [],
        createNewThread: false,
        personaId: "general",
        councilNeeded: false,
        reasoning: "Receptionist answered directly (JSON parse failed, using text as response)",
        directResponse: isRawClassification ? "Hey! I'm here and ready to help. What do you need?" : (cleanedResponse || undefined),
        memoryAction: "session_only",
      };
    }
  }

  // Log when time estimation is missing for tasks that should have it
  const shouldHaveTimeEstimate =
    (decision.classification === "ACTION" || decision.classification === "COMPOUND") &&
    !decision.directResponse; // Direct responses are instant, no estimate needed

  if (shouldHaveTimeEstimate && (!decision.estimatedDurationMs || !decision.acknowledgmentMessage)) {
    log.warn("Receptionist omitted time estimation for long-running task", {
      classification: decision.classification,
      personaId: decision.personaId,
      hasEstimate: !!decision.estimatedDurationMs,
      hasAcknowledgment: !!decision.acknowledgmentMessage,
      promptLength: request.prompt.length,
    });
  }

  return decision;
}

// ============================================
// JUDGE (FINAL QUALITY GATE)
// ============================================

export interface JudgeVerdict {
  verdict: "pass" | "cleaned" | "rerun";
  cleaned_version: string | null;
}

/**
 * Run the Judge as a final quality gate on a response before it reaches the user.
 * Returns the original response if the Judge passes it, a cleaned version, or
 * signals that the persona should be re-run.
 * 
 * Skipped for direct responses (receptionist answers) — those are already
 * conversational and don't need a quality check.
 */
export async function runJudge(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  originalPrompt: string,
  proposedResponse: string,
  personaId: string
): Promise<{ response: string; verdict: JudgeVerdict }> {
  const judge = getJudge();
  if (!judge) {
    log.warn("Judge persona not loaded, skipping quality gate");
    return {
      response: proposedResponse,
      verdict: { verdict: "pass", cleaned_version: null },
    };
  }

  const { selectedModel: modelConfig, client } = await resolveModelAndClient(llm, { personaModelTier: judge.modelTier });

  const userMessage = `USER'S ORIGINAL PROMPT:
${originalPrompt}

PERSONA THAT GENERATED THIS: ${personaId}

PROPOSED RESPONSE:
${proposedResponse}

Return your verdict as JSON.`;

  const messages = [
    { role: "system" as const, content: judge.systemPrompt },
    { role: "user" as const, content: userMessage },
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
      temperature: modelConfig.temperature,
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
      const verdict = JSON.parse(jsonMatch[0]) as JudgeVerdict;

      log.info("Judge verdict", { verdict: verdict.verdict, personaId });

      if (verdict.verdict === "cleaned" && verdict.cleaned_version) {
        return { response: verdict.cleaned_version, verdict };
      }

      // "pass" or "rerun" — return original (runner handles rerun logic)
      return { response: proposedResponse, verdict };
    }

    log.warn("Judge returned non-JSON despite json_object mode, treating as pass");
    return {
      response: proposedResponse,
      verdict: { verdict: "pass", cleaned_version: null },
    };
  } catch (error) {
    log.error("Judge failed, passing response through", { error });
    return {
      response: proposedResponse,
      verdict: { verdict: "pass", cleaned_version: null },
    };
  }
}

// ============================================
// UPDATER (BACKGROUND)
// ============================================

export function runUpdaterAsync(
  llm: ILLMClient,
  options: AgentRunnerOptions,
  request: EnhancedPromptRequest,
  finalResponse: string,
  keyPoints: string[],
  decision: ReceptionistDecision,
  userId: string
): void {
  // Run in background, don't block
  setImmediate(async () => {
    try {
      const updater = getUpdater();
      if (!updater) return;

      const memoryAction = decision.memoryAction || "session_only";
      
      log.info("Updater starting", { 
        memoryAction, 
        targets: decision.memoryTargets?.map((t: any) => t.entity),
      });

      // For "none", nothing to update
      if (memoryAction === "none") {
        return;
      }

      // Build existing model context by fetching from local agent
      let existingModelContext = "";
      if (memoryAction === "model_update" && decision.memoryTargets?.length && options.onPersistMemory) {
        for (const target of decision.memoryTargets) {
          try {
            const slug = target.entity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
            const model = await options.onPersistMemory("get_model_detail", { slug });
            if (model) {
              existingModelContext += `\nEXISTING MODEL: ${model.name || target.entity} (${model.category || "concept"})
Beliefs: ${(model.beliefs || []).map((b: any) => `${b.attribute}: ${b.value}`).join(", ") || "none"}
Open Loops: ${(model.openLoops || []).filter((l: any) => l.status === "open").map((l: any) => l.description).join(", ") || "none"}
Conversations: ${(model.conversations || []).slice(-3).map((c: any) => c.summary).join(" | ") || "none"}
`;
            }
          } catch (fetchErr) {
            log.warn(`Failed to fetch model for ${target.entity}`, { error: fetchErr });
          }
        }
      }

      const { selectedModel: modelConfig, client } = await resolveModelAndClient(llm, { personaModelTier: updater.modelTier });

      const userMessage = `MEMORY ACTION: ${memoryAction}

ORIGINAL PROMPT:
${request.prompt}

FINAL RESPONSE:
${finalResponse}
${keyPoints.length ? `\nKEY POINTS:\n${keyPoints.join("\n")}` : ""}
${decision.memoryTargets?.length ? `\nMEMORY TARGETS:\n${JSON.stringify(decision.memoryTargets, null, 2)}` : ""}
${existingModelContext ? `\n${existingModelContext}` : ""}
Respond with valid JSON containing "deltas" array and "sessionAction" string.`;

      const response = await client.chat(
        [
          { role: "system", content: updater.systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          model: modelConfig.model,
          maxTokens: modelConfig.maxTokens,
          temperature: modelConfig.temperature,
          responseFormat: "json_object",
        }
      );

      // Parse updater response
      try {
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          log.warn("Updater returned no JSON");
          return;
        }
        
        const parsed = JSON.parse(jsonMatch[0]) as {
          deltas: MemoryDelta[];
          sessionAction: string;
        };

        // Log session action (informational only — no server-side storage)
        if (parsed.sessionAction) {
          log.info("Session action from updater", { action: parsed.sessionAction });
        }

        // Apply memory deltas and persist to local agent
        if (parsed.deltas?.length) {
          const updatedModels = memory.applyMemoryDeltas(userId, parsed.deltas);
          log.info("Memory deltas applied", {
            modelsAffected: updatedModels.map(m => m.entity),
            deltaCount: parsed.deltas.length,
          });

          // Persist to local agent disk storage
          if (options.onPersistMemory) {
            for (const model of updatedModels) {
              try {
                // Convert server model to local-agent format
                const slug = model.entity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                const beliefs = Object.entries(model.attributes).map(([attr, value]) => ({
                  id: `belief_${attr}`,
                  attribute: attr,
                  value,
                  confidence: model.confidence,
                  evidence: [{ type: "observed", content: `Set via memory delta`, source: "system", timestamp: new Date().toISOString() }],
                  formedAt: new Date().toISOString(),
                  lastConfirmedAt: new Date().toISOString(),
                }));

                // Also include explicit beliefs from the model
                for (const b of model.beliefs || []) {
                  beliefs.push({
                    id: b.id || `belief_${beliefs.length}`,
                    attribute: b.statement || b.id || "observation",
                    value: b.statement || true,
                    confidence: b.conviction || 0.8,
                    evidence: [{ type: "observed", content: (b.evidence || []).join("; ") || "From conversation", source: "system", timestamp: new Date().toISOString() }],
                    formedAt: new Date().toISOString(),
                    lastConfirmedAt: new Date().toISOString(),
                  });
                }

                const conversations = model.recentDialog?.length ? [{
                  timestamp: new Date().toISOString(),
                  summary: model.recentDialog[model.recentDialog.length - 1]?.spirit || "Conversation",
                  keyPoints: model.recentDialog.slice(-3).map(d => d.spirit).filter(Boolean),
                }] : [];

                await options.onPersistMemory("save_model", {
                  slug,
                  name: model.entity,
                  category: model.type || "concept",
                  description: model.subtype ? `${model.type}/${model.subtype}` : (model.type || ""),
                  beliefs,
                  openLoops: (model.openLoops || []).filter(l => !l.resolvedAt).map(l => ({
                    id: l.id,
                    description: l.description,
                    importance: (l.priority || "medium") as "high" | "medium" | "low",
                    status: "open" as const,
                    createdAt: l.createdAt instanceof Date ? l.createdAt.toISOString() : new Date().toISOString(),
                    resolutionCriteria: l.trigger || "",
                  })),
                  constraints: (model.constraints || []).map(c => ({
                    id: c.id,
                    description: c.description || "",
                    type: c.type || "soft",
                    source: c.source || "observed",
                    flexibility: c.type === "hard" ? "non-negotiable" : "negotiable",
                    addedAt: c.addedAt instanceof Date ? c.addedAt.toISOString() : new Date().toISOString(),
                  })),
                  conversations,
                });
                log.info(`Persisted model to local agent: ${model.entity}`, { slug });
              } catch (persistErr) {
                log.error(`Failed to persist model ${model.entity}`, { error: persistErr });
              }
            }
          }
        }

        // Legacy: notify client of updates for each thread
        if (options.onThreadUpdate && decision.threadIds.length) {
          for (const threadId of decision.threadIds) {
            options.onThreadUpdate(threadId, parsed as any);
          }
        }
      } catch (e) {
        log.error("Failed to parse Updater response", { error: e, responseLength: response.content.length });
      }

    } catch (error) {
      log.error("Updater failed", { error });
    }
  });
}
