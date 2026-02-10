/**
 * Tool System Tests
 * 
 * Tests for tool prompt generation, native tool conversion, system context,
 * and tool capabilities summary.
 */

import { describe, it, expect } from "vitest";
import {
  generateToolPrompt,
  getSystemContext,
  generateToolCapabilitiesSummary,
  clearTemplateCache,
  manifestToNativeTools,
  sanitizeToolName,
  unsanitizeToolName,
} from "./tools.js";
import type { ToolManifestEntry } from "./tools.js";

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

describe("generateToolPrompt", () => {
  it("returns behavioral guidance (not tool definitions)", () => {
    clearTemplateCache();
    const prompt = generateToolPrompt();
    // Should contain behavioral guidance sections
    expect(prompt).toContain("Tool Use Guidelines");
    expect(prompt).toContain("Important Rules");
  });

  it("does not contain tool definitions or JSON format instructions", () => {
    const prompt = generateToolPrompt();
    // Should NOT contain JSON response format instructions
    expect(prompt).not.toContain("You MUST always respond with a JSON object");
    // Should NOT contain tool definition listings
    expect(prompt).not.toContain("{{TOOL_SECTIONS}}");
  });
});

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

  it("falls back to legacy tools when no manifest", () => {
    const tools = manifestToNativeTools(undefined);
    expect(tools.length).toBeGreaterThan(0);
    // Legacy tools should be present
    const names = tools.map(t => t.function.name);
    expect(names).toContain("create_file");
    expect(names).toContain("read_file");
  });
});

describe("getSystemContext", () => {
  it("returns date and OS info", () => {
    const ctx = getSystemContext();
    expect(ctx).toContain("Windows");
    // Should contain date/time info
    expect(ctx.length).toBeGreaterThan(50);
  });

  it("includes runtime info when provided", () => {
    const runtimes = [
      { name: "node", available: true, version: "v20.0.0" },
      { name: "python", available: false, installHint: "winget install Python.Python.3" },
    ];
    const ctx = getSystemContext(runtimes);
    expect(ctx).toContain("node");
    expect(ctx).toContain("v20.0.0");
    expect(ctx).toContain("python");
    expect(ctx).toContain("NOT installed");
  });
});

describe("generateToolCapabilitiesSummary", () => {
  it("returns empty string for empty manifest", () => {
    expect(generateToolCapabilitiesSummary(undefined)).toBe("");
    expect(generateToolCapabilitiesSummary([])).toBe("");
  });

  it("groups core categories", () => {
    const summary = generateToolCapabilitiesSummary(mockManifest);
    expect(summary).toContain("filesystem");
    expect(summary).toContain("shell");
  });

  it("includes persona tool access when provided", () => {
    const personaTools = {
      "senior-dev": ["all"],
      "junior-dev": ["filesystem", "shell"],
      "general": ["none"],
    };
    const summary = generateToolCapabilitiesSummary(mockManifest, personaTools);
    expect(summary).toContain("senior-dev");
    expect(summary).toContain("all tools");
    expect(summary).toContain("junior-dev");
    expect(summary).toContain("no tools");
  });

  it("highlights learned/custom tools separately", () => {
    const manifestWithLearned: ToolManifestEntry[] = [
      ...mockManifest,
      {
        id: "jokes.random",
        name: "random_joke",
        description: "Get a random joke",
        category: "jokes",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    const summary = generateToolCapabilitiesSummary(manifestWithLearned);
    expect(summary).toContain("random_joke");
    expect(summary).toContain("jokes");
  });
});
