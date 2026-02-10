/**
 * Store Core — Integration Tests
 * 
 * Tests file I/O operations using a temp directory.
 * Validates initialization, index management, and JSON utilities.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

// We need to override the paths before importing store-core.
// Since store-core uses const paths at module level, we'll test
// the utility functions directly and do integration tests via the barrel.

describe("Store Core — Utility Functions", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `dotbot-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("fileExists returns false for non-existent file", async () => {
    // Import the function
    const { fileExists } = await import("./store-core.js");
    const result = await fileExists(path.join(tempDir, "nope.json"));
    expect(result).toBe(false);
  });

  it("fileExists returns true after creating a file", async () => {
    const { fileExists } = await import("./store-core.js");
    const filePath = path.join(tempDir, "exists.json");
    await fs.writeFile(filePath, "{}");
    const result = await fileExists(filePath);
    expect(result).toBe(true);
  });

  it("readJson and writeJson round-trip correctly", async () => {
    const { readJson, writeJson } = await import("./store-core.js");
    const filePath = path.join(tempDir, "roundtrip.json");
    const data = { name: "test", count: 42, nested: { a: true } };
    
    await writeJson(filePath, data);
    const loaded = await readJson<typeof data>(filePath);
    
    expect(loaded).toEqual(data);
  });

  it("slugify creates filesystem-safe names", async () => {
    const { slugify } = await import("./store-core.js");
    
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("user@email.com")).toBe("user-email-com");
    expect(slugify("  spaces  ")).toBe("spaces");
    expect(slugify("UPPER_case")).toBe("upper-case");
  });
});

describe("Store Core — Path Constants", () => {
  it("all path constants are defined and absolute", async () => {
    const core = await import("./store-core.js");
    
    expect(path.isAbsolute(core.DOTBOT_DIR)).toBe(true);
    expect(path.isAbsolute(core.MEMORY_DIR)).toBe(true);
    expect(path.isAbsolute(core.SCHEMAS_DIR)).toBe(true);
    expect(path.isAbsolute(core.MODELS_DIR)).toBe(true);
    expect(path.isAbsolute(core.SKILLS_DIR)).toBe(true);
    expect(path.isAbsolute(core.THREADS_DIR)).toBe(true);
    expect(path.isAbsolute(core.ARCHIVE_DIR)).toBe(true);
    expect(path.isAbsolute(core.TEMP_DIR)).toBe(true);
  });

  it("DOTBOT_DIR is under home directory", async () => {
    const core = await import("./store-core.js");
    expect(core.DOTBOT_DIR).toContain(".bot");
    expect(core.DOTBOT_DIR.startsWith(os.homedir())).toBe(true);
  });
});

describe("Store Core — Exported API Surface", () => {
  it("exports all expected functions", async () => {
    const core = await import("./store-core.js");
    
    // Utility exports
    expect(typeof core.fileExists).toBe("function");
    expect(typeof core.readJson).toBe("function");
    expect(typeof core.writeJson).toBe("function");
    expect(typeof core.slugify).toBe("function");
    
    // Store operations
    expect(typeof core.initializeMemoryStore).toBe("function");
    expect(typeof core.getMemoryIndex).toBe("function");
    expect(typeof core.rebuildMemoryIndex).toBe("function");
  });
});
