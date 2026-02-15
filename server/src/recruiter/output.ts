/**
 * Recruiter — Output Builder
 *
 * Gathers persona/council catalogs, assembles LLM prompts,
 * and builds the agent persona file.
 *
 * Tool manifest is received as a parameter (from context builder
 * via pipeline) — NOT re-fetched.
 */

import { loadPrompt } from "../prompt-template.js";
import { generateCompactCatalog } from "../tools/catalog.js";
import { getPersona } from "../personas/loader.js";
import { getLocalPersona } from "../personas/local-loader.js";
import {
  getAllPersonaSummaries,
  getCouncilSummaries,
  formatPersonasBulletList,
  formatCouncilsBulletList,
} from "../personas/summaries.js";
import type { ToolManifestEntry } from "../agents/tools.js";
import type { RecruiterLLMResponse, RecruiterPhase1Response } from "./types.js";

// ============================================
// PHASE 1: PICKER PROMPT (persona selection)
// ============================================

export async function buildPickerPrompt(
  intakeKB: string,
  restatedRequest: string,
): Promise<string> {
  const { server, local } = getAllPersonaSummaries();
  const councils = getCouncilSummaries();

  const fields: Record<string, string> = {
    "Intake Knowledgebase": intakeKB || "(intake file not available)",
    "Restated Request": restatedRequest,
    "Server Personas": formatPersonasBulletList(server),
    "Local Personas": formatPersonasBulletList(local),
    "Councils": formatCouncilsBulletList(councils),
  };

  return loadPrompt("recruiter/picker.md", fields);
}

// ============================================
// FETCH FULL PERSONA CONTENT
// ============================================

/** Fetch the full system prompt content for each selected persona. */
export function fetchPersonaContent(
  selectedIds: string[],
): { id: string; name: string; content: string }[] {
  const results: { id: string; name: string; content: string }[] = [];

  for (const id of selectedIds) {
    // Try server personas first, then local
    const serverPersona = getPersona(id);
    if (serverPersona) {
      results.push({
        id: serverPersona.id,
        name: serverPersona.name,
        content: serverPersona.systemPrompt,
      });
      continue;
    }

    const localPersona = getLocalPersona(id);
    if (localPersona) {
      results.push({
        id: localPersona.slug || localPersona.id,
        name: localPersona.name,
        content: localPersona.systemPrompt,
      });
      continue;
    }

    // Not found — include a note so the writer knows
    results.push({ id, name: id, content: "(persona file not found)" });
  }

  return results;
}

/** Format full persona profiles as markdown for the writer prompt. */
function formatPersonaProfiles(profiles: { id: string; name: string; content: string }[]): string {
  if (profiles.length === 0) return "(no personas selected)";
  return profiles.map(p =>
    `### ${p.name} (${p.id})\n\n${p.content}`
  ).join("\n\n---\n\n");
}

// ============================================
// PHASE 2: WRITER PROMPT (custom prompt + tools)
// ============================================

export async function buildWriterPrompt(
  intakeKB: string,
  restatedRequest: string,
  phase1: RecruiterPhase1Response,
  manifest: ToolManifestEntry[],
): Promise<string> {
  const selectedIds = phase1.selectedPersonas.map(p => p.id);
  const profiles = fetchPersonaContent(selectedIds);
  const toolCatalog = generateCompactCatalog(manifest);

  const fields: Record<string, string> = {
    "Restated Request": restatedRequest,
    "Intake Knowledgebase": intakeKB || "(intake file not available)",
    "Persona Profiles": formatPersonaProfiles(profiles),
    "Tool Catalog": toolCatalog,
  };

  return loadPrompt("recruiter/writer.md", fields);
}

// ============================================
// AGENT PERSONA FILE
// ============================================

export type AgentStatus =
  | "queued"
  | "running"
  | "paused"
  | "blocked"
  | "waiting_on_human"
  | "completed"
  | "stopped"
  | "failed";

export interface QueuedTask {
  id: string;
  request: string;
  addedAt: string;
}

export interface AgentPersonaFile {
  agentId: string;
  previousAgentId?: string;
  customPrompt: string;
  selectedPersonas: { id: string; reason: string }[];
  council: string | null;
  tools: string[];
  modelRole: string;
  restatedRequests: string[];
  status: AgentStatus;
  queue: QueuedTask[];
  createdAt: string;
  completedAt?: string;
}

export function buildAgentPersonaFile(
  agentId: string,
  restatedRequest: string,
  llmResponse: RecruiterLLMResponse,
  opts?: { previousAgentId?: string; extraRequests?: string[] },
): AgentPersonaFile {
  return {
    agentId,
    ...(opts?.previousAgentId && { previousAgentId: opts.previousAgentId }),
    customPrompt: llmResponse.customPrompt,
    selectedPersonas: llmResponse.selectedPersonas,
    council: llmResponse.council,
    tools: llmResponse.tools,
    modelRole: llmResponse.modelRole,
    restatedRequests: [restatedRequest, ...(opts?.extraRequests ?? [])],
    status: "queued",
    queue: [],
    createdAt: new Date().toISOString(),
  };
}
