/**
 * Persona & Council Summaries — Shared Utility
 *
 * Centralizes gathering and formatting of persona/council data for LLM prompts.
 * Used by: intake, recruiter.
 */

import { getInternalPersonas } from "./loader.js";
import { getAllLocalPersonas } from "./local-loader.js";
import { getAllCouncils } from "./council-loader.js";

// ============================================
// TYPES
// ============================================

export interface PersonaSummary {
  id: string;
  name: string;
  type: "internal" | "client";
  description: string;
  toolCategories: string[];
  modelRole?: string;
  councilOnly?: boolean;
}

export interface CouncilSummary {
  id: string;
  name: string;
  description: string;
  personas: string[];
}

// ============================================
// DATA GATHERING
// ============================================

/** Gather server internal personas (excludes councilOnly). */
export function getServerPersonaSummaries(): PersonaSummary[] {
  return getInternalPersonas()
    .filter(p => !p.councilOnly)
    .map(p => ({
      id: p.id,
      name: p.name,
      type: "internal" as const,
      description: p.description,
      toolCategories: p.tools || [],
      modelRole: p.modelRole,
      councilOnly: p.councilOnly,
    }));
}

/** Gather local user-defined personas. */
export function getLocalPersonaSummaries(): PersonaSummary[] {
  return getAllLocalPersonas().map(p => ({
    id: p.slug || p.id,
    name: p.name,
    type: "client" as const,
    description: p.description,
    toolCategories: p.tools || [],
    modelRole: p.modelRole,
  }));
}

/** Gather all personas (server + local). */
export function getAllPersonaSummaries(): { server: PersonaSummary[]; local: PersonaSummary[] } {
  return {
    server: getServerPersonaSummaries(),
    local: getLocalPersonaSummaries(),
  };
}

/** Gather all council summaries. */
export function getCouncilSummaries(): CouncilSummary[] {
  return getAllCouncils().map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    personas: c.personas,
  }));
}

// ============================================
// FORMATTING — BULLET LIST
// ============================================

/** Format personas as a markdown bullet list with descriptions and tool hints. */
export function formatPersonasBulletList(personas: PersonaSummary[]): string {
  if (personas.length === 0) return "(none)";
  return personas.map(p =>
    `- **${p.id}** (${p.name}): ${p.description}${p.toolCategories.length > 0 ? ` | tools: [${p.toolCategories.join(", ")}]` : ""}`
  ).join("\n");
}

/** Format councils as a markdown bullet list. */
export function formatCouncilsBulletList(councils: CouncilSummary[]): string {
  if (councils.length === 0) return "(none available)";
  return councils.map(c =>
    `- **${c.id}** (${c.name}): ${c.description} | members: [${c.personas.join(", ")}]`
  ).join("\n");
}

// ============================================
// FORMATTING — TABLE (for intake receptionist)
// ============================================

/** Format personas as a markdown table with Source column. Accepts optional user personas. */
export function formatPersonasTable(
  serverPersonas: PersonaSummary[],
  userPersonas?: { id: string; name?: string; description?: string; councilOnly?: boolean }[],
): string {
  const internalRows = serverPersonas
    .map(p => `| ${p.id} | ${p.description || p.name} | built-in |`)
    .join("\n");

  const userRows = (userPersonas || [])
    .filter(p => !p.councilOnly)
    .map(p => `| ${p.id} | ${p.description || p.name || p.id} | user-defined |`)
    .join("\n");

  const allRows = [internalRows, userRows].filter(Boolean).join("\n");

  return `## Available Personas

These are ALL the personas you can route to. Use the description to pick the best match.

| Persona | Description | Source |
|---------|-------------|--------|
${allRows}

**Important:** Do NOT invent persona IDs. Use ONLY personas listed above. Prefer user-defined personas when their description matches the request better than a built-in.`;
}

// ============================================
// FORMATTING — STYLE REFERENCE (for persona-writer)
// ============================================

/** Format personas as a compact style reference for the persona-writer. */
export function formatPersonaStyleReference(personas: PersonaSummary[]): string {
  if (personas.length === 0) return "";

  const lines = personas.map(p => {
    const toolHint = p.toolCategories.length > 0
      ? ` (commonly uses: ${p.toolCategories.join(", ")})`
      : "";
    return `- **${p.id}**: ${p.description || p.name}${toolHint}`;
  });

  return `## Persona Style Reference

Use these as inspiration for writing custom personas. Do NOT reference them directly — write a fresh system prompt every time.

**IMPORTANT:** The tool categories listed are COMMON CHOICES, not limits. Pick whatever tools the task actually needs from the full catalog below, regardless of what's listed here. If a researcher needs "research" tools, include them even if not listed.

${lines.join("\n")}`;
}

// ============================================
// TOOL MAP (for intake)
// ============================================

/** Build a persona→tool-categories map for routing decisions. */
export function buildPersonaToolMap(
  serverPersonas: PersonaSummary[],
  userPersonas?: { id: string; tools?: string[] }[],
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const p of serverPersonas) {
    if (p.toolCategories.length > 0) map[p.id] = p.toolCategories;
  }
  for (const p of (userPersonas || [])) {
    map[p.id] = p.tools || ["all"];
  }
  return map;
}
