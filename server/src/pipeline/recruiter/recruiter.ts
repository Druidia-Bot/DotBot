/**
 * Recruiter — Orchestrator
 *
 * Owns the full persona lifecycle for each task:
 *   1. Fetch user personas + councils from local agent
 *   2. Register them in server-side loaders
 *   3. Match council trigger patterns against the prompt
 *   4. Phase 1 LLM: select personas + council + model role
 *   5. Phase 2 LLM: write custom system prompt
 *   6. Write agent_persona.json to workspace
 *
 * Previously split between context/personas.ts (fetch+register)
 * and persona-picker/ (select+write). Now unified here.
 */

import { createComponentLogger } from "#logging.js";
import { resolveModelAndClient } from "#llm/selection/resolve.js";
import { sendExecutionCommand } from "#ws/device-bridge.js";
import { loadSchema } from "../../prompt-template.js";
import type { ILLMClient } from "#llm/types.js";
import type {
  RecruiterInput,
  RecruiterResult,
  RecruiterPhase1Response,
  RecruiterLLMResponse,
} from "./types.js";
import {
  buildPickerPrompt,
  buildWriterPrompt,
  buildAgentPersonaFile,
} from "./output.js";
import {
  fetchAndRegisterPersonas,
  fetchAndRegisterCouncils,
} from "./personas.js";

const log = createComponentLogger("recruiter");

// ============================================
// MAIN ENTRY
// ============================================

export async function runRecruiter(
  llm: ILLMClient,
  input: RecruiterInput,
): Promise<RecruiterResult> {
  const { agentId, deviceId, workspacePath, restatedRequest, intakeKnowledgebase } = input;

  log.info("Starting recruiter", { agentId, restatedRequest: restatedRequest.slice(0, 100) });

  // ── Step 0: Fetch + register personas and councils from local agent ──
  const [_personaSummaries, matchedCouncils] = await Promise.all([
    fetchAndRegisterPersonas(deviceId),
    fetchAndRegisterCouncils(deviceId, restatedRequest),
  ]);

  if (matchedCouncils.length > 0) {
    log.info("Council triggers matched", { councils: matchedCouncils.map((c: any) => c.id) });
  }

  // ── Step 1: Build prompts + load schemas (parallel) ──
  const [pickerPrompt, pickerSchema] = await Promise.all([
    buildPickerPrompt(intakeKnowledgebase, restatedRequest),
    loadSchema("pipeline/recruiter/picker.schema.json"),
  ]);

  const { selectedModel: modelConfig, client } = await resolveModelAndClient(
    llm,
    { explicitRole: "intake" },
  );

  // ── Step 2: Phase 1 — LLM picks personas + council + model role ──
  const phase1Response = await client.chat(
    [{ role: "user", content: pickerPrompt }],
    {
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
      temperature: 0.2,
      responseFormat: "json_object",
      responseSchema: { name: "recruiter_picker", schema: pickerSchema },
    },
  );

  log.info("Phase 1 (pick) complete", {
    model: phase1Response.model,
    inputTokens: phase1Response.usage?.inputTokens,
    outputTokens: phase1Response.usage?.outputTokens,
  });

  let phase1: RecruiterPhase1Response;
  try {
    const jsonMatch = phase1Response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in phase 1 response");
    phase1 = JSON.parse(jsonMatch[0]) as RecruiterPhase1Response;
  } catch (e) {
    log.error("Failed to parse phase 1 response", { error: e, raw: phase1Response.content.substring(0, 500) });
    phase1 = {
      selectedPersonas: [{ id: "general", reason: "Fallback — phase 1 parse failure" }],
      council: null,
      modelRole: "workhorse",
    };
  }

  log.info("Personas selected", {
    picks: phase1.selectedPersonas.map(p => p.id),
    council: phase1.council,
    modelRole: phase1.modelRole,
  });

  // ── Step 3: Phase 2 — LLM reads full persona profiles, writes custom prompt ──
  const writerPrompt = await buildWriterPrompt(intakeKnowledgebase, restatedRequest, phase1);

  const phase2Response = await client.chat(
    [{ role: "user", content: writerPrompt }],
    {
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
      temperature: 0.3,
    },
  );

  log.info("Phase 2 (write) complete", {
    model: phase2Response.model,
    inputTokens: phase2Response.usage?.inputTokens,
    outputTokens: phase2Response.usage?.outputTokens,
  });

  const customPrompt = phase2Response.content?.trim()
    || `You are a capable AI assistant. Your task: ${restatedRequest}`;

  // ── Step 4: Merge phases and write agent_persona.json ──
  const combined: RecruiterLLMResponse = {
    selectedPersonas: phase1.selectedPersonas,
    council: phase1.council,
    modelRole: phase1.modelRole,
    customPrompt,
  };

  const personaFile = buildAgentPersonaFile(agentId, restatedRequest, combined,
    input.previousAgentId ? { previousAgentId: input.previousAgentId } : undefined,
  );
  const personaPath = `${workspacePath}/agent_persona.json`;

  try {
    await sendExecutionCommand(deviceId, {
      id: `rec_write_${Date.now()}`,
      type: "tool_execute",
      payload: {
        toolId: "filesystem.create_file",
        toolArgs: {
          path: personaPath,
          content: JSON.stringify(personaFile, null, 2),
        },
      },
      dryRun: false,
      timeout: 10_000,
      sandboxed: false,
      requiresApproval: false,
    });
  } catch (err) {
    log.error("Failed to write agent_persona.json", { agentId, error: err });
    throw err;
  }

  log.info("Recruiter complete", {
    agentId,
    personas: phase1.selectedPersonas.map(p => p.id),
    council: phase1.council,
    modelRole: phase1.modelRole,
  });

  return {
    agentId,
    personaPath,
    selectedPersonas: phase1.selectedPersonas,
    council: phase1.council,
    customPrompt,
    modelRole: phase1.modelRole,
  };
}
