/**
 * Council Loader
 *
 * Loads and manages user-defined councils from the local agent.
 * Councils are multi-persona configurations that collaborate on complex tasks.
 *
 * Structure:
 * ~/.bot/councils/
 *   product-launch.json
 *   code-review.json
 *   content-strategy.json
 */

import type {
  PersonaDefinition,
  CouncilDefinition,
  ResolvedCouncil,
} from "../types/agent.js";
import { createComponentLogger } from "#logging.js";
import { getPersona } from "./loader.js";
import { getLocalPersona } from "./local-loader.js";
import { safeRegexTest } from "../utils/safe-regex.js";

const log = createComponentLogger("council-loader");

// ============================================
// CACHE
// ============================================

const councilCache = new Map<string, CouncilDefinition>();

// ============================================
// REGISTRATION
// ============================================

/**
 * Register a council received from the local agent.
 */
export function registerCouncil(council: CouncilDefinition): void {
  councilCache.set(council.id, council);
  log.info(`Registered council`, {
    id: council.id,
    name: council.name,
    personaCount: council.personas.length,
    reviewMode: council.reviewMode || false,
  });
}

/**
 * Register multiple councils at once.
 */
export function registerCouncils(councils: CouncilDefinition[]): void {
  for (const council of councils) {
    registerCouncil(council);
  }
  log.info(`Registered ${councils.length} councils`);
}

/**
 * Unregister a council.
 */
export function unregisterCouncil(id: string): void {
  const removed = councilCache.delete(id);
  if (removed) {
    log.info(`Unregistered council`, { id });
  }
}

/**
 * Clear all councils (e.g., on client disconnect).
 */
export function clearCouncils(): void {
  const count = councilCache.size;
  councilCache.clear();
  if (count > 0) {
    log.info(`Cleared ${count} councils`);
  }
}

// ============================================
// RETRIEVAL
// ============================================

/**
 * Get a council by ID.
 */
export function getCouncil(id: string): CouncilDefinition | undefined {
  return councilCache.get(id);
}

/**
 * Get all registered councils.
 */
export function getAllCouncils(): CouncilDefinition[] {
  return Array.from(councilCache.values());
}

/**
 * Check if a council ID is registered.
 */
export function isCouncil(id: string): boolean {
  return councilCache.has(id);
}

/**
 * Find councils that match a given text (trigger pattern matching).
 * Used by the receptionist to auto-detect council invocations.
 */
export function findMatchingCouncils(text: string): CouncilDefinition[] {
  const matches: CouncilDefinition[] = [];

  for (const council of councilCache.values()) {
    if (!council.triggerPatterns || council.triggerPatterns.length === 0) {
      continue;
    }

    for (const pattern of council.triggerPatterns) {
      // Use safeRegexTest to prevent ReDoS attacks from malicious patterns
      if (safeRegexTest(pattern, text)) {
        matches.push(council);
        break; // Don't add the same council twice
      }
    }
  }

  return matches;
}

// ============================================
// RESOLUTION
// ============================================

/**
 * Resolve a council definition to actual PersonaDefinition objects.
 * Looks up personas from both server and local persona registries.
 *
 * @throws Error if any persona cannot be resolved
 */
export function resolveCouncil(councilId: string): ResolvedCouncil {
  const council = councilCache.get(councilId);
  if (!council) {
    throw new Error(`Council not found: ${councilId}`);
  }

  const resolvedPersonas: PersonaDefinition[] = [];
  const missingPersonas: string[] = [];

  for (const personaId of council.personas) {
    // Try server personas first
    let persona = getPersona(personaId);

    // Then try local personas
    if (!persona) {
      persona = getLocalPersona(personaId);
    }

    if (persona) {
      resolvedPersonas.push(persona);
    } else {
      missingPersonas.push(personaId);
    }
  }

  if (missingPersonas.length > 0) {
    throw new Error(
      `Cannot resolve council "${council.name}": missing personas [${missingPersonas.join(", ")}]`
    );
  }

  // Default protocol
  const protocol = council.protocol || {
    rounds: 3,
    judgeAfterEachRound: true,
    finalSynthesis: true,
  };

  return {
    id: council.id,
    name: council.name,
    description: council.description,
    personas: resolvedPersonas,
    reviewMode: council.reviewMode || false,
    protocol: {
      rounds: protocol.rounds,
      judgeAfterEachRound: protocol.judgeAfterEachRound ?? true,
      finalSynthesis: protocol.finalSynthesis ?? true,
    },
  };
}

/**
 * Validate a council configuration.
 * Returns an array of validation errors, or empty array if valid.
 */
export function validateCouncil(council: CouncilDefinition): string[] {
  const errors: string[] = [];

  if (!council.id || council.id.trim() === "") {
    errors.push("Council must have an id");
  }

  if (!council.name || council.name.trim() === "") {
    errors.push("Council must have a name");
  }

  if (!council.personas || council.personas.length === 0) {
    errors.push("Council must have at least one persona");
  }

  if (council.personas && council.personas.length === 1) {
    errors.push("Council must have at least 2 personas (use direct persona for single-persona tasks)");
  }

  if (council.protocol) {
    if (council.protocol.rounds < 1) {
      errors.push("Protocol rounds must be at least 1");
    }
    if (council.protocol.rounds > 10) {
      errors.push("Protocol rounds cannot exceed 10");
    }
  }

  return errors;
}

/**
 * Create a council definition from JSON.
 * Validates the structure and returns errors if invalid.
 */
export function parseCouncilJSON(
  json: string
): { council?: CouncilDefinition; errors: string[] } {
  try {
    const parsed = JSON.parse(json);

    // Basic structure check
    if (typeof parsed !== "object" || parsed === null) {
      return { errors: ["Council must be a JSON object"] };
    }

    const council: CouncilDefinition = {
      id: parsed.id || "",
      name: parsed.name || "",
      description: parsed.description || "",
      personas: Array.isArray(parsed.personas) ? parsed.personas : [],
      triggerPatterns: Array.isArray(parsed.triggerPatterns)
        ? parsed.triggerPatterns
        : undefined,
      reviewMode: parsed.reviewMode === true,
      protocol: parsed.protocol,
      tags: Array.isArray(parsed.tags) ? parsed.tags : undefined,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };

    const errors = validateCouncil(council);
    if (errors.length > 0) {
      return { errors };
    }

    return { council, errors: [] };
  } catch (e) {
    return { errors: [`Invalid JSON: ${e}`] };
  }
}
