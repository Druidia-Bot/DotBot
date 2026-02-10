/**
 * Tool Handlers — Secrets — Production Tests
 *
 * Tests handleSecrets: list_keys, delete_key, prompt_user.
 * All credentials are server-encrypted (srv: prefix) — no DPAPI.
 * Mocks credential-proxy.js for the server-side secure entry flow (prompt_user).
 * Uses a temp directory for .env file operations.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// TEMP DIR + ENV REDIRECT (hoisted for vi.mock)
// ============================================

const { tempDir, tempBotDir, tempEnvPath } = vi.hoisted(() => {
  const _path = require("path");
  const _os = require("os");
  const _tempDir = _path.join(_os.tmpdir(), `dotbot-secrets-test-${Date.now()}`);
  return {
    tempDir: _tempDir,
    tempBotDir: _path.join(_tempDir, ".bot"),
    tempEnvPath: _path.join(_tempDir, ".bot", ".env"),
  };
});
const originalUserProfile = process.env.USERPROFILE;

// ============================================
// MOCK: credential-vault
// ============================================

const mockVault = new Map<string, string>();

vi.mock("../credential-vault.js", () => ({
  vaultSetServerBlob: vi.fn(async (name: string, blob: string) => {
    if (!blob.startsWith("srv:")) throw new Error("Must start with srv:");
    mockVault.set(name, blob);
  }),
  vaultGetBlob: vi.fn(async (name: string) => mockVault.get(name) ?? null),
  vaultHas: vi.fn(async (name: string) => mockVault.has(name)),
  vaultList: vi.fn(async () => [...mockVault.keys()]),
  vaultDelete: vi.fn(async (name: string) => { const had = mockVault.has(name); mockVault.delete(name); return had; }),
  isServerEncrypted: vi.fn(async (name: string) => { const v = mockVault.get(name); return !!v && v.startsWith("srv:"); }),
  invalidateCache: vi.fn(),
}));

// ============================================
// MOCK: tool-executor (for knownFolders)
// ============================================

vi.mock("./tool-executor.js", () => ({
  knownFolders: { userprofile: tempDir },
}));

// ============================================
// MOCK: credential-proxy (for prompt_user server entry flow)
// ============================================

const { mockProxyBehavior } = vi.hoisted(() => ({
  mockProxyBehavior: {
    sessionUrl: "http://localhost:3000/credentials/enter/abc123",
    storedBlob: "srv:dGVzdA==",  // Will be resolved by waitForCredentialStored
    sessionError: null as Error | null,
    storedError: null as Error | null,
  },
}));

vi.mock("../credential-proxy.js", () => ({
  requestCredentialSession: vi.fn(async (keyName: string, _prompt: string, allowedDomain: string, _title?: string) => {
    if (mockProxyBehavior.sessionError) throw mockProxyBehavior.sessionError;
    return { url: mockProxyBehavior.sessionUrl, qrUrl: "https://shareasqrcode.com/?urlText=test", keyName, allowedDomain };
  }),
  waitForCredentialStored: vi.fn(async (_keyName: string) => {
    if (mockProxyBehavior.storedError) throw mockProxyBehavior.storedError;
    return mockProxyBehavior.storedBlob;
  }),
  credentialProxyFetch: vi.fn(async () => { throw new Error("Not used in secrets tests"); }),
  initCredentialProxy: vi.fn(),
  handleProxyResponse: vi.fn(),
  handleSessionReady: vi.fn(),
  handleCredentialStored: vi.fn(),
}));

// ============================================
// MOCK: child_process (for browser open in prompt_user)
// ============================================

vi.mock("child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("child_process")>();
  return {
    ...orig,
    execFile: vi.fn((_cmd: string, _args: string[], _opts: any, _cb?: Function) => {
      // Browser open is fire-and-forget, just return a mock process
      return { pid: 0 } as any;
    }),
  };
});

// ============================================
// IMPORT AFTER MOCKS
// ============================================

import { handleSecrets } from "./tool-handlers-manage.js";

// ============================================
// SETUP / TEARDOWN
// ============================================

beforeEach(async () => {
  process.env.USERPROFILE = tempDir;
  mockVault.clear();
  mockProxyBehavior.sessionUrl = "http://localhost:3000/credentials/enter/abc123";
  mockProxyBehavior.storedBlob = "srv:dGVzdA==";
  mockProxyBehavior.sessionError = null;
  mockProxyBehavior.storedError = null;

  await fs.rm(tempBotDir, { recursive: true, force: true });
  await fs.mkdir(tempBotDir, { recursive: true });
});

afterAll(async () => {
  process.env.USERPROFILE = originalUserProfile;
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ============================================
// secrets.list_keys
// ============================================

describe("handleSecrets — list_keys", () => {
  it("returns 'No credentials' when empty", async () => {
    const result = await handleSecrets("secrets.list_keys", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("No credentials");
  });

  it("lists vault keys with source label", async () => {
    mockVault.set("KEY_A", "srv:a");
    mockVault.set("KEY_B", "srv:b");

    const result = await handleSecrets("secrets.list_keys", {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("KEY_A");
    expect(result.output).toContain("KEY_B");
    expect(result.output).toContain("server-encrypted");
  });

  it("never reveals actual values in listing", async () => {
    mockVault.set("SECRET", "srv:my-secret-blob-123");

    const result = await handleSecrets("secrets.list_keys", {});
    expect(result.output).not.toContain("my-secret-blob-123");
  });
});

// ============================================
// secrets.delete_key
// ============================================

describe("handleSecrets — delete_key", () => {
  it("deletes from vault", async () => {
    mockVault.set("DOOMED", "srv:val");

    const result = await handleSecrets("secrets.delete_key", { key: "DOOMED" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("vault");
    expect(mockVault.has("DOOMED")).toBe(false);
  });

  it("reports not found for nonexistent key", async () => {
    const result = await handleSecrets("secrets.delete_key", { key: "GHOST" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("not found");
  });
});

// ============================================
// secrets.prompt_user
// ============================================

describe("handleSecrets — prompt_user (server entry flow)", () => {
  it("stores server-encrypted blob in vault via server entry page", async () => {
    mockProxyBehavior.storedBlob = "srv:encrypted-blob-from-server";

    const result = await handleSecrets("secrets.prompt_user", {
      key_name: "MY_API_KEY",
      prompt: "Enter your API key",
      allowed_domain: "api.example.com",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("securely stored");
    expect(result.output).toContain("NEVER");
    expect(mockVault.get("MY_API_KEY")).toBe("srv:encrypted-blob-from-server");
  });

  it("output never contains the encrypted blob", async () => {
    mockProxyBehavior.storedBlob = "srv:secret-blob-data";

    const result = await handleSecrets("secrets.prompt_user", {
      key_name: "TOKEN",
      prompt: "Enter token",
      allowed_domain: "discord.com",
    });

    expect(result.output).not.toContain("srv:secret-blob-data");
  });

  it("fails when key_name is missing", async () => {
    const result = await handleSecrets("secrets.prompt_user", {
      prompt: "Enter key",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("key_name");
  });

  it("fails when prompt is missing", async () => {
    const result = await handleSecrets("secrets.prompt_user", {
      key_name: "KEY",
      allowed_domain: "discord.com",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("prompt");
  });

  it("fails when allowed_domain is missing", async () => {
    const result = await handleSecrets("secrets.prompt_user", {
      key_name: "KEY",
      prompt: "Enter key",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("allowed_domain");
  });

  it("handles credential entry timeout (user doesn't complete page)", async () => {
    mockProxyBehavior.storedError = new Error("Credential entry timed out (15 minute limit)");

    const result = await handleSecrets("secrets.prompt_user", {
      key_name: "KEY",
      prompt: "Enter key",
      allowed_domain: "discord.com",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(mockVault.has("KEY")).toBe(false);
  });

  it("handles server connection not established", async () => {
    mockProxyBehavior.sessionError = new Error("Credential proxy not initialized — WS connection not established");

    const result = await handleSecrets("secrets.prompt_user", {
      key_name: "KEY",
      prompt: "Enter key",
      allowed_domain: "discord.com",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("server connection not established");
  });

  it("handles session creation failure", async () => {
    mockProxyBehavior.sessionError = new Error("Failed to create credential session");

    const result = await handleSecrets("secrets.prompt_user", {
      key_name: "KEY",
      prompt: "Enter key",
      allowed_domain: "discord.com",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Credential entry failed");
  });

  it("uses custom title without crashing", async () => {
    mockProxyBehavior.storedBlob = "srv:blob";

    const result = await handleSecrets("secrets.prompt_user", {
      key_name: "KEY",
      prompt: "Enter key",
      allowed_domain: "discord.com",
      title: "Custom Title",
    });
    expect(result.success).toBe(true);
  });

  it("mentions server-side encryption in success message", async () => {
    mockProxyBehavior.storedBlob = "srv:blob";

    const result = await handleSecrets("secrets.prompt_user", {
      key_name: "KEY",
      prompt: "Enter key",
      allowed_domain: "discord.com",
    });
    expect(result.output).toContain("server-side key");
    expect(result.output).toContain("cryptographically bound");
    expect(result.output).toContain("discord.com");
    expect(result.output).toContain("LLM never sees it");
  });
});

// ============================================
// UNKNOWN TOOL
// ============================================

describe("handleSecrets — unknown tool", () => {
  it("returns error for unknown secrets tool", async () => {
    const result = await handleSecrets("secrets.nonexistent", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown secrets tool");
  });
});
