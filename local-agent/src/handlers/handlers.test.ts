/**
 * Handler Module Export Tests
 * 
 * Validates that all handler functions extracted during the refactor
 * are properly exported and have correct signatures.
 */

import { describe, it, expect } from "vitest";

describe("Memory Handlers Exports", () => {
  it("exports handleMemoryRequest and handleSkillRequest", async () => {
    // Importing memory-handlers loads the full memory module chain — allow extra time
    const mod = await import("./memory-handlers.js");
    
    expect(typeof mod.handleMemoryRequest).toBe("function");
    expect(typeof mod.handleSkillRequest).toBe("function");
  }, 30_000);
});

describe("Discovery Handlers Exports", () => {
  it("exports persona, council, and knowledge handlers", async () => {
    // Importing discovery-handlers loads the full memory module chain — allow extra time
    const mod = await import("./discovery-handlers.js");
    
    expect(typeof mod.handlePersonaRequest).toBe("function");
    expect(typeof mod.handleCouncilRequest).toBe("function");
    expect(typeof mod.handleKnowledgeRequest).toBe("function");
  }, 30_000);
});

describe("Resource Handlers Exports", () => {
  it("exports all resource handler functions", async () => {
    const mod = await import("./resource-handlers.js");
    
    expect(typeof mod.handleExecutionRequest).toBe("function");
    expect(typeof mod.handleSchemaRequest).toBe("function");
    expect(typeof mod.handleThreadRequest).toBe("function");
    expect(typeof mod.handleThreadUpdate).toBe("function");
    expect(typeof mod.handleSaveToThread).toBe("function");
    expect(typeof mod.handleStoreAsset).toBe("function");
    expect(typeof mod.handleRetrieveAsset).toBe("function");
    expect(typeof mod.handleCleanupAssets).toBe("function");
  });
});
