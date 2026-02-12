/**
 * Store Barrel — Re-export Validation Tests
 * 
 * Ensures every function extracted during the refactor is still
 * accessible through the barrel module after the split.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";

describe("Store Barrel Re-exports", () => {
  it("re-exports all store-core functions", async () => {
    const store = await import("./store.js");
    
    expect(typeof store.initializeMemoryStore).toBe("function");
    expect(typeof store.getMemoryIndex).toBe("function");
    expect(typeof store.rebuildMemoryIndex).toBe("function");
  });

  it("re-exports all store-models functions", async () => {
    const store = await import("./store.js");
    
    expect(typeof store.getSchema).toBe("function");
    expect(typeof store.saveSchema).toBe("function");
    expect(typeof store.addFieldToSchema).toBe("function");
    expect(typeof store.getMentalModel).toBe("function");
    expect(typeof store.getAllMentalModels).toBe("function");
    expect(typeof store.saveMentalModel).toBe("function");
    expect(typeof store.createMentalModel).toBe("function");
    expect(typeof store.deleteMentalModel).toBe("function");
    expect(typeof store.addBelief).toBe("function");
    expect(typeof store.addOpenLoop).toBe("function");
    expect(typeof store.resolveOpenLoop).toBe("function");
    expect(typeof store.addQuestion).toBe("function");
    expect(typeof store.addConstraint).toBe("function");
    expect(typeof store.searchMentalModels).toBe("function");
  });

  it("re-exports all store-skills functions", async () => {
    const store = await import("./store.js");
    
    expect(typeof store.getSkill).toBe("function");
    expect(typeof store.getAllSkills).toBe("function");
    expect(typeof store.saveSkill).toBe("function");
    expect(typeof store.createSkill).toBe("function");
    expect(typeof store.deleteSkill).toBe("function");
    expect(typeof store.searchSkills).toBe("function");
    expect(typeof store.addSupportingFile).toBe("function");
    expect(typeof store.readSupportingFile).toBe("function");
  });

  it("re-exports all store-threads functions", async () => {
    const store = await import("./store.js");
    
    expect(typeof store.getThread).toBe("function");
    expect(typeof store.getAllThreadSummaries).toBe("function");
    expect(typeof store.getL0MemoryIndex).toBe("function");
    expect(typeof store.updateThread).toBe("function");
    expect(typeof store.saveToThread).toBe("function");
    expect(typeof store.archiveThread).toBe("function");
    expect(typeof store.condenseThread).toBe("function");
  });

  it("re-exports asset functions", async () => {
    const store = await import("./store.js");
    
    expect(typeof store.storeAsset).toBe("function");
    expect(typeof store.retrieveAsset).toBe("function");
    expect(typeof store.cleanupAssets).toBe("function");
  });
});

// ============================================
// SEC-03: Path Traversal Prevention
// ============================================

describe("storeAsset — SEC-03 path traversal prevention", () => {
  beforeEach(() => {
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined as any);
    vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects ../../../etc/passwd traversal", async () => {
    const { storeAsset } = await import("./store.js");
    await expect(
      storeAsset("sess1", "task1", { data: "test", filename: "../../../etc/passwd", assetType: "text" })
    ).rejects.toThrow(/Invalid asset filename|escapes target directory/);
  });

  it("rejects ..\\..\\Windows\\System32 traversal", async () => {
    const { storeAsset } = await import("./store.js");
    await expect(
      storeAsset("sess1", "task1", { data: "test", filename: "..\\..\\Windows\\System32\\config", assetType: "text" })
    ).rejects.toThrow(/Invalid asset filename|escapes target directory/);
  });

  it("rejects filename that is just ..", async () => {
    const { storeAsset } = await import("./store.js");
    await expect(
      storeAsset("sess1", "task1", { data: "test", filename: "..", assetType: "text" })
    ).rejects.toThrow("Invalid asset filename");
  });

  it("rejects empty filename", async () => {
    const { storeAsset } = await import("./store.js");
    await expect(
      storeAsset("sess1", "task1", { data: "test", filename: "", assetType: "text" })
    ).rejects.toThrow("Invalid asset filename");
  });

  it("accepts clean filename and strips directory components", async () => {
    const { storeAsset } = await import("./store.js");
    const result = await storeAsset("sess1", "task1", { data: "hello", filename: "report.txt", assetType: "text" });
    // Should contain the clean filename, not any traversal
    expect(path.basename(result)).toBe("report.txt");
  });

  it("rejects filenames containing path separators", async () => {
    const { storeAsset } = await import("./store.js");
    await expect(
      storeAsset("sess1", "task1", { data: "hello", filename: "subdir/image.png", assetType: "image" })
    ).rejects.toThrow("Invalid asset filename");
  });
});
