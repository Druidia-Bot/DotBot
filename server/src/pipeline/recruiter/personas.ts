/**
 * Recruiter — Persona & Council Fetching
 *
 * Fetches user-defined personas and councils from the local agent,
 * registers them in the server-side loaders, and checks council
 * trigger patterns against the current prompt.
 *
 * Previously lived in context/personas.ts — moved here because
 * persona registration is only needed by the recruiter, not by
 * earlier pipeline stages.
 */

import { registerUserPersona } from "../../personas/loader.js";
import { registerLocalPersona } from "../../personas/local-loader.js";
import { registerCouncil } from "../../personas/council-loader.js";
import { createComponentLogger } from "#logging.js";
import { requestPersonas, requestCouncilPaths } from "#ws/device-bridge.js";
import type { LocalPersonaDefinition, CouncilDefinition } from "../../types/agent.js";
import RE2 from "re2";

const log = createComponentLogger("recruiter.personas");

// ── Safe Regex (ReDoS protection) ───────────────────────────────────

/**
 * Test a regex pattern against input using RE2 (Google's safe regex engine).
 * RE2 guarantees linear-time execution with no catastrophic backtracking,
 * completely preventing ReDoS attacks.
 */
function safeRegexTest(pattern: string, input: string): boolean {
  try {
    if (pattern.length > 500) {
      log.warn("Regex pattern too long, rejecting", { patternLength: pattern.length });
      return false;
    }
    const regex = new RE2(pattern, "i");
    return regex.test(input);
  } catch (e) {
    log.warn("Invalid regex pattern in safeRegexTest", { pattern, error: e });
    return false;
  }
}

// ── Persona Fetching & Registration ─────────────────────────────────

export async function fetchAndRegisterPersonas(
  deviceId: string,
): Promise<{ id: string; name: string; description: string }[]> {
  try {
    const personas = await requestPersonas(deviceId);
    if (!Array.isArray(personas)) return [];

    const summaries: { id: string; name: string; description: string }[] = [];

    for (const p of personas) {
      summaries.push({
        id: p.id || p.slug,
        name: p.name || p.id,
        description: p.description || "",
      });

      if (p.id && p.systemPrompt) {
        // Register as both user persona (backwards compat) AND local persona (V2)
        registerUserPersona({
          id: p.id,
          name: p.name || p.id,
          type: "internal",
          modelTier: p.modelTier || "smart",
          description: p.description || "",
          systemPrompt: p.systemPrompt,
          tools: Array.isArray(p.tools) ? p.tools : [],
          modelRole: p.modelRole || undefined,
          councilOnly: p.councilOnly || false,
        });

        const localPersona: LocalPersonaDefinition = {
          id: p.id,
          slug: p.slug || p.id,
          name: p.name || p.id,
          type: "client",
          modelTier: p.modelTier || "smart",
          description: p.description || "",
          systemPrompt: p.systemPrompt,
          tools: Array.isArray(p.tools) ? p.tools : [],
          modelRole: p.modelRole || undefined,
          councilOnly: p.councilOnly || false,
          knowledgeDocumentIds: p.knowledgeDocumentIds || [],
          lastSyncedAt: new Date().toISOString(),
        };
        registerLocalPersona(localPersona);
      }
    }

    return summaries;
  } catch (err) {
    log.warn("Failed to fetch user personas from local agent", { error: err });
    return [];
  }
}

// ── Council Fetching, Registration & Trigger Matching ───────────────

export async function fetchAndRegisterCouncils(
  deviceId: string,
  prompt: string,
): Promise<any[]> {
  const matchedCouncils: any[] = [];

  try {
    const councils = await requestCouncilPaths(deviceId);
    if (!Array.isArray(councils)) return [];

    for (const c of councils) {
      if (!c.id || !c.name || !Array.isArray(c.personas)) continue;

      const council: CouncilDefinition = {
        id: c.id,
        name: c.name,
        description: c.description || "",
        personas: c.personas,
        triggerPatterns: c.triggerPatterns || [],
        reviewMode: c.reviewMode || false,
        protocol: c.protocol,
        tags: c.tags,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
      registerCouncil(council);

      if (council.triggerPatterns && council.triggerPatterns.length > 0) {
        for (const pattern of council.triggerPatterns) {
          if (safeRegexTest(pattern, prompt)) {
            matchedCouncils.push({
              id: council.id,
              name: council.name,
              description: council.description,
              triggerMatches: [pattern],
            });
            break;
          }
        }
      }
    }
  } catch (err) {
    log.warn("Failed to fetch councils from local agent", { error: err });
  }

  return matchedCouncils;
}
