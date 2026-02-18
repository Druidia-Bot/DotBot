/**
 * MCP Integration Tests
 *
 * Unit tests for config loading, env var resolution, and content formatting.
 * Does NOT require a real MCP server — tests pure functions only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatMcpContent } from "./executor.js";
import { resolveEnvVars, resolveEnvRecord, loadMcpConfigs } from "./loader.js";
import { promises as fs } from "fs";
import { resolve } from "path";

// ============================================
// formatMcpContent
// ============================================

describe("formatMcpContent", () => {
  it("returns '(no output)' for empty array", () => {
    expect(formatMcpContent([])).toBe("(no output)");
  });

  it("returns '(no output)' for non-array", () => {
    expect(formatMcpContent(null as any)).toBe("(no output)");
  });

  it("formats text content items", () => {
    const content = [
      { type: "text", text: "Hello world" },
      { type: "text", text: "Second line" },
    ];
    expect(formatMcpContent(content)).toBe("Hello world\nSecond line");
  });

  it("formats image content items", () => {
    const content = [{ type: "image", mimeType: "image/png" }];
    expect(formatMcpContent(content)).toBe("[image: image/png]");
  });

  it("formats image with unknown mime type", () => {
    const content = [{ type: "image" }];
    expect(formatMcpContent(content)).toBe("[image: unknown]");
  });

  it("formats resource content items with text", () => {
    const content = [
      { type: "resource", resource: { uri: "file:///test.txt", text: "File contents here" } },
    ];
    expect(formatMcpContent(content)).toBe("File contents here");
  });

  it("formats resource content items without text", () => {
    const content = [
      { type: "resource", resource: { uri: "file:///test.bin" } },
    ];
    expect(formatMcpContent(content)).toBe("[resource: file:///test.bin]");
  });

  it("JSON-stringifies unknown content types", () => {
    const content = [{ type: "custom", data: 42 }];
    expect(formatMcpContent(content)).toBe('{"type":"custom","data":42}');
  });

  it("handles primitive items", () => {
    const content = ["raw string", 42, true];
    expect(formatMcpContent(content)).toBe("raw string\n42\ntrue");
  });

  it("truncates output longer than 8000 chars", () => {
    const longText = "x".repeat(9000);
    const content = [{ type: "text", text: longText }];
    const result = formatMcpContent(content);
    expect(result.length).toBeLessThanOrEqual(8000 + 20); // 8000 + "...[truncated]"
    expect(result).toContain("...[truncated]");
  });

  it("handles mixed content types", () => {
    const content = [
      { type: "text", text: "Result:" },
      { type: "image", mimeType: "image/jpeg" },
      { type: "text", text: "Done" },
    ];
    expect(formatMcpContent(content)).toBe("Result:\n[image: image/jpeg]\nDone");
  });
});

// ============================================
// resolveEnvVars / resolveEnvRecord
// ============================================

describe("resolveEnvVars", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, TEST_TOKEN: "abc123", OTHER_VAR: "xyz" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("substitutes ${VAR} with env value", () => {
    expect(resolveEnvVars("Bearer ${TEST_TOKEN}")).toBe("Bearer abc123");
  });

  it("leaves unset vars as-is", () => {
    expect(resolveEnvVars("${NONEXISTENT_VAR}")).toBe("${NONEXISTENT_VAR}");
  });

  it("handles multiple substitutions", () => {
    expect(resolveEnvVars("${TEST_TOKEN}:${OTHER_VAR}")).toBe("abc123:xyz");
  });

  it("returns plain strings unchanged", () => {
    expect(resolveEnvVars("no vars here")).toBe("no vars here");
  });
});

describe("resolveEnvRecord", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, MY_KEY: "secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves all values in a record", () => {
    const result = resolveEnvRecord({
      Authorization: "Bearer ${MY_KEY}",
      "Content-Type": "application/json",
    });
    expect(result.Authorization).toBe("Bearer secret");
    expect(result["Content-Type"]).toBe("application/json");
  });
});

// ============================================
// loadMcpConfigs
// ============================================

describe("loadMcpConfigs", () => {
  const configDir = resolve(
    process.env.USERPROFILE || process.env.HOME || "",
    ".bot",
    "mcp",
  );

  it("returns empty array when config dir does not exist", async () => {
    // Mock fs.access to throw (dir doesn't exist)
    const spy = vi.spyOn(fs, "access").mockRejectedValueOnce(new Error("ENOENT"));
    const configs = await loadMcpConfigs();
    expect(configs).toEqual([]);
    spy.mockRestore();
  });

  it("loads valid config files", async () => {
    const accessSpy = vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const readdirSpy = vi.spyOn(fs, "readdir").mockResolvedValueOnce(
      ["lobsterbands.json", "readme.txt"] as any,
    );
    const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(
      JSON.stringify({
        name: "lobsterbands",
        transport: "streamable-http",
        url: "https://lobsterbands.com/mcp/sse",
      }),
    );

    const configs = await loadMcpConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("lobsterbands");
    expect(configs[0].transport).toBe("streamable-http");
    expect(configs[0].url).toBe("https://lobsterbands.com/mcp/sse");

    accessSpy.mockRestore();
    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it("skips configs missing required fields", async () => {
    const accessSpy = vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const readdirSpy = vi.spyOn(fs, "readdir").mockResolvedValueOnce(
      ["bad.json"] as any,
    );
    const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(
      JSON.stringify({ name: "incomplete" }), // missing transport
    );

    const configs = await loadMcpConfigs();
    expect(configs).toHaveLength(0);

    accessSpy.mockRestore();
    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it("skips disabled servers", async () => {
    const accessSpy = vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const readdirSpy = vi.spyOn(fs, "readdir").mockResolvedValueOnce(
      ["disabled.json"] as any,
    );
    const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(
      JSON.stringify({
        name: "disabled-server",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        enabled: false,
      }),
    );

    const configs = await loadMcpConfigs();
    expect(configs).toHaveLength(0);

    accessSpy.mockRestore();
    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it("skips HTTP transport without url", async () => {
    const accessSpy = vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const readdirSpy = vi.spyOn(fs, "readdir").mockResolvedValueOnce(
      ["no-url.json"] as any,
    );
    const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(
      JSON.stringify({ name: "no-url", transport: "streamable-http" }),
    );

    const configs = await loadMcpConfigs();
    expect(configs).toHaveLength(0);

    accessSpy.mockRestore();
    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it("skips stdio transport without command", async () => {
    const accessSpy = vi.spyOn(fs, "access").mockResolvedValueOnce(undefined);
    const readdirSpy = vi.spyOn(fs, "readdir").mockResolvedValueOnce(
      ["no-cmd.json"] as any,
    );
    const readFileSpy = vi.spyOn(fs, "readFile").mockResolvedValueOnce(
      JSON.stringify({ name: "no-cmd", transport: "stdio" }),
    );

    const configs = await loadMcpConfigs();
    expect(configs).toHaveLength(0);

    accessSpy.mockRestore();
    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
  });
});
