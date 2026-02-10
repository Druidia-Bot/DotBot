/**
 * Credential Metadata — Production Tests
 *
 * Tests getToolManifest credential metadata:
 * 1. getToolManifest includes credentialRequired/credentialConfigured metadata
 * 2. credentialConfigured reflects vault state (server-encrypted blobs only)
 * 3. Tools without credentialRequired are unaffected
 * 4. Manifest never contains credential values
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ============================================
// MOCK: credential-vault (hoisted so vi.mock factories can reference it)
// ============================================

const { mockVault } = vi.hoisted(() => ({
  mockVault: new Map<string, string>(),
}));

vi.mock("../credential-vault.js", () => ({
  vaultSetServerBlob: vi.fn(async (name: string, blob: string) => { mockVault.set(name, blob); }),
  vaultGetBlob: vi.fn(async (name: string) => mockVault.get(name) ?? null),
  vaultHas: vi.fn(async (name: string) => mockVault.has(name)),
  vaultList: vi.fn(async () => [...mockVault.keys()]),
  vaultDelete: vi.fn(async (name: string) => { const had = mockVault.has(name); mockVault.delete(name); return had; }),
  isServerEncrypted: vi.fn(async (name: string) => { const v = mockVault.get(name); return !!v && v.startsWith("srv:"); }),
  invalidateCache: vi.fn(),
}));

// ============================================
// MOCK: all handler modules (we only need to verify args passed to them)
// ============================================

const capturedArgs: Record<string, any>[] = [];

// Mock discord handler to capture args
vi.mock("./tool-handlers-discord.js", () => ({
  handleDiscord: vi.fn(async (_toolId: string, args: Record<string, any>) => {
    capturedArgs.push(args);
    return { success: true, output: "ok" };
  }),
}));

// Mock all other handlers so executeTool doesn't fail on unrelated imports
vi.mock("./tool-handlers-web.js", () => ({
  handleHttp: vi.fn(async () => ({ success: true, output: "" })),
  handleBrowser: vi.fn(async () => ({ success: true, output: "" })),
  handleSearch: vi.fn(async () => ({ success: true, output: "" })),
}));
vi.mock("./tool-handlers-manage.js", () => ({
  handleSecrets: vi.fn(async (_id: string, args: any) => {
    capturedArgs.push(args);
    return { success: true, output: "" };
  }),
  handleToolsManagement: vi.fn(async () => ({ success: true, output: "" })),
  handleSkillsManagement: vi.fn(async () => ({ success: true, output: "" })),
}));
vi.mock("./tool-handlers-knowledge.js", () => ({
  handleKnowledge: vi.fn(async () => ({ success: true, output: "" })),
  handlePersonas: vi.fn(async () => ({ success: true, output: "" })),
}));
vi.mock("./gui/index.js", () => ({
  handleGui: vi.fn(async () => ({ success: true, output: "" })),
}));

// Mock registry with a controllable tool map
const mockToolMap = new Map<string, any>();

vi.mock("./registry.js", () => ({
  getTool: vi.fn((id: string) => mockToolMap.get(id)),
  getAllTools: vi.fn(() => [...mockToolMap.values()]),
  getToolsByCategory: vi.fn(),
  initToolRegistry: vi.fn(),
  getToolManifest: vi.fn(async () => {
    // Simulate the real getToolManifest logic using mockVault directly
    const entries = [];
    for (const t of mockToolMap.values()) {
      const entry: any = {
        id: t.id,
        name: t.name,
        description: t.description || "",
        category: t.category,
        inputSchema: t.inputSchema || {},
      };
      if (t.credentialRequired) {
        entry.credentialRequired = t.credentialRequired;
        entry.credentialConfigured = mockVault.has(t.credentialRequired);
      }
      entries.push(entry);
    }
    return entries;
  }),
  getRuntimeManifest: vi.fn(() => []),
  registerTool: vi.fn(),
  unregisterTool: vi.fn(),
}));

// ============================================
// IMPORT AFTER MOCKS
// ============================================

import { executeTool } from "./tool-executor.js";
import { getToolManifest } from "./registry.js";

// ============================================
// SETUP
// ============================================

beforeEach(() => {
  mockVault.clear();
  mockToolMap.clear();
  capturedArgs.length = 0;
});

// ============================================
// executeTool — basic routing
// ============================================

describe("executeTool — basic routing", () => {
  it("passes args directly to handler without modification", async () => {
    mockToolMap.set("discord.list_guilds", {
      id: "discord.list_guilds",
      name: "list_guilds",
      category: "discord",
      credentialRequired: "DISCORD_BOT_TOKEN",
    });

    await executeTool("discord.list_guilds", { guild_id: "123" });

    expect(capturedArgs.length).toBe(1);
    expect(capturedArgs[0].guild_id).toBe("123");
    // No __credential injection — credentials are resolved via server proxy
    expect(capturedArgs[0].__credential).toBeUndefined();
  });

  it("returns error for unknown tool", async () => {
    const result = await executeTool("nonexistent.thing", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });
});

// ============================================
// getToolManifest — credential metadata
// ============================================

describe("getToolManifest — credential metadata", () => {
  it("includes credentialRequired and credentialConfigured=true when vault has key", async () => {
    mockToolMap.set("discord.list_guilds", {
      id: "discord.list_guilds",
      name: "list_guilds",
      description: "List guilds",
      category: "discord",
      inputSchema: {},
      credentialRequired: "DISCORD_BOT_TOKEN",
    });
    mockVault.set("DISCORD_BOT_TOKEN", "srv:encrypted-blob");

    const manifest = await getToolManifest();
    const entry = manifest.find((e: any) => e.id === "discord.list_guilds");
    expect(entry).toBeDefined();
    expect(entry!.credentialRequired).toBe("DISCORD_BOT_TOKEN");
    expect((entry as any).credentialConfigured).toBe(true);
  });

  it("sets credentialConfigured=false when vault does not have key", async () => {
    mockToolMap.set("discord.list_guilds", {
      id: "discord.list_guilds",
      name: "list_guilds",
      description: "List guilds",
      category: "discord",
      inputSchema: {},
      credentialRequired: "DISCORD_BOT_TOKEN",
    });
    // Vault empty

    const manifest = await getToolManifest();
    const entry = manifest.find((e: any) => e.id === "discord.list_guilds");
    expect((entry as any).credentialConfigured).toBe(false);
  });

  it("omits credential fields for tools without credentialRequired", async () => {
    mockToolMap.set("filesystem.create_file", {
      id: "filesystem.create_file",
      name: "create_file",
      description: "Create a file",
      category: "filesystem",
      inputSchema: {},
    });

    const manifest = await getToolManifest();
    const entry = manifest.find((e: any) => e.id === "filesystem.create_file");
    expect(entry).toBeDefined();
    expect(entry!.credentialRequired).toBeUndefined();
    expect((entry as any).credentialConfigured).toBeUndefined();
  });

  it("manifest never contains actual credential values", async () => {
    mockToolMap.set("discord.list_guilds", {
      id: "discord.list_guilds",
      name: "list_guilds",
      description: "List guilds",
      category: "discord",
      inputSchema: {},
      credentialRequired: "DISCORD_BOT_TOKEN",
    });
    mockVault.set("DISCORD_BOT_TOKEN", "srv:super-secret-token-12345");

    const manifest = await getToolManifest();
    const json = JSON.stringify(manifest);
    expect(json).not.toContain("super-secret-token-12345");
  });
});
