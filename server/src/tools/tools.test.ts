/**
 * Tool System Tests
 * 
 * Tests for manifest conversion and tool name sanitization.
 */

import { describe, it, expect } from "vitest";
import {
  manifestToNativeTools,
  sanitizeToolName,
  unsanitizeToolName,
} from "./manifest.js";
import type { ToolManifestEntry } from "./types.js";

const mockManifest: ToolManifestEntry[] = [
  {
    id: "filesystem.create_file",
    name: "create_file",
    description: "Create a new file",
    category: "filesystem",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    id: "filesystem.read_file",
    name: "read_file",
    description: "Read a file",
    category: "filesystem",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
  },
  {
    id: "shell.powershell",
    name: "run_command",
    description: "Run a PowerShell command",
    category: "shell",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run" },
      },
      required: ["command"],
    },
  },
];

describe("sanitizeToolName / unsanitizeToolName", () => {
  it("replaces dots with double underscores", () => {
    expect(sanitizeToolName("filesystem.create_file")).toBe("filesystem__create_file");
  });

  it("handles multiple dots", () => {
    expect(sanitizeToolName("a.b.c")).toBe("a__b__c");
  });

  it("leaves names without dots unchanged", () => {
    expect(sanitizeToolName("create_file")).toBe("create_file");
  });

  it("round-trips correctly", () => {
    const original = "filesystem.create_file";
    expect(unsanitizeToolName(sanitizeToolName(original))).toBe(original);
  });
});

describe("manifestToNativeTools", () => {
  it("converts manifest entries to ToolDefinition[]", () => {
    const tools = manifestToNativeTools(mockManifest);
    expect(tools).toHaveLength(3);
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toBe("filesystem__create_file");
    expect(tools[0].function.description).toBe("Create a new file");
  });

  it("sanitizes tool names (dots → __)", () => {
    const tools = manifestToNativeTools(mockManifest);
    for (const t of tools) {
      expect(t.function.name).not.toContain(".");
    }
  });

  it("includes parameters as JSON Schema", () => {
    const tools = manifestToNativeTools(mockManifest);
    const createFile = tools[0];
    expect(createFile.function.parameters).toBeDefined();
    expect(createFile.function.parameters!.properties.path).toBeDefined();
    expect(createFile.function.parameters!.required).toContain("path");
  });

  it("returns empty array when no manifest provided", () => {
    expect(manifestToNativeTools(undefined)).toHaveLength(0);
    expect(manifestToNativeTools([])).toHaveLength(0);
  });
});

