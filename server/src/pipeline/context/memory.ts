/**
 * Context — Memory & State Fetching (Barrel)
 *
 * Re-exports from decomposed modules so existing imports continue to work.
 *
 * Modules:
 *   memory-types.ts          — L0Index, MemoryState, ResearchCacheEntry
 *   memory-state.ts          — fetchL0Index, fetchRecentHistory, fetchActiveTasks, fetchMemoryState
 *   memory-identity.ts       — fetchAgentIdentity, fetchBackstory
 *   memory-models.ts         — fetchAllModels, fetchAllModelSpines, fetchModel, fetchModelSpine
 *   memory-research-cache.ts — fetchResearchCacheIndex
 *   memory-journal.ts        — fetchJournalFiles
 */

// Types
export type { L0Index, MemoryState, ResearchCacheEntry } from "./memory-types.js";

// Core state
export { fetchL0Index, fetchRecentHistory, fetchActiveTasks, fetchMemoryState } from "./memory-state.js";

// Identity
export { fetchAgentIdentity, fetchBackstory } from "./memory-identity.js";

// Models
export { fetchAllModels, fetchAllModelSpines, fetchModel, fetchModelSpine } from "./memory-models.js";
export { formatModelSpine } from "#tool-loop/handlers/memory-get-model-spine.js";

// Research cache
export { fetchResearchCacheIndex } from "./memory-research-cache.js";

// Journal
export { fetchJournalFiles } from "./memory-journal.js";
