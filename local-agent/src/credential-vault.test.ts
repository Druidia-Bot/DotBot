/**
 * Credential Vault — Production Tests
 *
 * Tests all vault operations: vaultSetServerBlob, vaultGetBlob, vaultHas,
 * vaultList, vaultDelete, isServerEncrypted, invalidateCache.
 * All credentials are server-encrypted (srv: prefix) — no DPAPI.
 * Uses a temp directory for vault.json to avoid touching real files.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// TEMP DIR + ENV REDIRECT
// ============================================

const tempDir = path.join(os.tmpdir(), `dotbot-vault-test-${Date.now()}`);
const tempBotDir = path.join(tempDir, ".bot");
const tempVaultPath = path.join(tempBotDir, "vault.json");

// Point USERPROFILE to temp dir so getVaultPath() uses it
const originalUserProfile = process.env.USERPROFILE;

import {
  vaultSetServerBlob,
  vaultGetBlob,
  vaultHas,
  vaultList,
  vaultDelete,
  isServerEncrypted,
  invalidateCache,
} from "./credential-vault.js";

// ============================================
// SETUP / TEARDOWN
// ============================================

beforeEach(async () => {
  process.env.USERPROFILE = tempDir;

  // Clean temp dir
  await fs.rm(tempBotDir, { recursive: true, force: true });
  await fs.mkdir(tempBotDir, { recursive: true });

  // Clear the module-level in-memory cache so each test starts fresh from disk
  invalidateCache();
});

afterAll(async () => {
  process.env.USERPROFILE = originalUserProfile;
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ============================================
// vaultSetServerBlob + vaultGetBlob — round-trip
// ============================================

describe("vaultSetServerBlob + vaultGetBlob", () => {
  it("stores and retrieves a server-encrypted blob", async () => {
    await vaultSetServerBlob("MY_KEY", "srv:encrypted-blob-data");
    const result = await vaultGetBlob("MY_KEY");
    expect(result).toBe("srv:encrypted-blob-data");
  });

  it("overwrites an existing credential", async () => {
    await vaultSetServerBlob("MY_KEY", "srv:version1");
    await vaultSetServerBlob("MY_KEY", "srv:version2");
    const result = await vaultGetBlob("MY_KEY");
    expect(result).toBe("srv:version2");
  });

  it("rejects blobs without srv: prefix", async () => {
    await expect(vaultSetServerBlob("BAD", "no-prefix")).rejects.toThrow("srv:");
  });

  it("writes vault.json to disk", async () => {
    await vaultSetServerBlob("DISK_CHECK", "srv:blob123");
    const content = await fs.readFile(tempVaultPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe("1");
    expect(parsed.credentials.DISK_CHECK).toBe("srv:blob123");
  });

  it("returns null for nonexistent key", async () => {
    const result = await vaultGetBlob("NONEXISTENT");
    expect(result).toBeNull();
  });

  it("stores multiple credentials independently", async () => {
    await vaultSetServerBlob("KEY_A", "srv:blob-a");
    await vaultSetServerBlob("KEY_B", "srv:blob-b");
    expect(await vaultGetBlob("KEY_A")).toBe("srv:blob-a");
    expect(await vaultGetBlob("KEY_B")).toBe("srv:blob-b");
  });
});

// ============================================
// vaultHas
// ============================================

describe("vaultHas", () => {
  it("returns true for existing key", async () => {
    await vaultSetServerBlob("EXISTS", "srv:val");
    expect(await vaultHas("EXISTS")).toBe(true);
  });

  it("returns false for nonexistent key", async () => {
    expect(await vaultHas("NOPE")).toBe(false);
  });

  it("returns false after deletion", async () => {
    await vaultSetServerBlob("TEMP", "srv:val");
    await vaultDelete("TEMP");
    expect(await vaultHas("TEMP")).toBe(false);
  });
});

// ============================================
// isServerEncrypted
// ============================================

describe("isServerEncrypted", () => {
  it("returns true for srv: blobs", async () => {
    await vaultSetServerBlob("SRV_KEY", "srv:encrypted-data");
    expect(await isServerEncrypted("SRV_KEY")).toBe(true);
  });

  it("returns false for nonexistent key", async () => {
    expect(await isServerEncrypted("MISSING")).toBe(false);
  });
});

// ============================================
// vaultList
// ============================================

describe("vaultList", () => {
  it("returns empty array when vault is empty", async () => {
    const keys = await vaultList();
    expect(keys).toEqual([]);
  });

  it("returns all stored key names", async () => {
    await vaultSetServerBlob("KEY_A", "srv:a");
    await vaultSetServerBlob("KEY_B", "srv:b");
    await vaultSetServerBlob("KEY_C", "srv:c");
    const keys = await vaultList();
    expect(keys.sort()).toEqual(["KEY_A", "KEY_B", "KEY_C"]);
  });

  it("never returns blob values — only names", async () => {
    await vaultSetServerBlob("SECRET", "srv:super-secret-blob");
    const keys = await vaultList();
    expect(keys).toEqual(["SECRET"]);
    expect(keys.join("")).not.toContain("super-secret-blob");
  });
});

// ============================================
// vaultDelete
// ============================================

describe("vaultDelete", () => {
  it("deletes an existing key and returns true", async () => {
    await vaultSetServerBlob("DOOMED", "srv:val");
    const deleted = await vaultDelete("DOOMED");
    expect(deleted).toBe(true);
    expect(await vaultGetBlob("DOOMED")).toBeNull();
  });

  it("returns false for nonexistent key", async () => {
    const deleted = await vaultDelete("GHOST");
    expect(deleted).toBe(false);
  });

  it("does not affect other keys", async () => {
    await vaultSetServerBlob("KEEP", "srv:keep-val");
    await vaultSetServerBlob("DELETE", "srv:del-val");
    await vaultDelete("DELETE");
    expect(await vaultGetBlob("KEEP")).toBe("srv:keep-val");
    expect(await vaultGetBlob("DELETE")).toBeNull();
  });

  it("persists deletion to disk", async () => {
    await vaultSetServerBlob("GONE", "srv:val");
    await vaultDelete("GONE");
    const content = await fs.readFile(tempVaultPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.credentials.GONE).toBeUndefined();
  });
});

// ============================================
// SECURITY: vault file structure
// ============================================

describe("vault file security", () => {
  it("vault file has version field", async () => {
    await vaultSetServerBlob("KEY", "srv:val");
    const content = JSON.parse(await fs.readFile(tempVaultPath, "utf-8"));
    expect(content.version).toBe("1");
  });

  it("handles malformed vault file gracefully (starts fresh)", async () => {
    await fs.writeFile(tempVaultPath, "not json at all!!!", "utf-8");
    invalidateCache();
    const keys = await vaultList();
    expect(keys).toEqual([]);
  });

  it("handles vault with wrong version gracefully", async () => {
    await fs.writeFile(tempVaultPath, JSON.stringify({ version: "99", credentials: { x: "y" } }), "utf-8");
    invalidateCache();
    const keys = await vaultList();
    expect(keys).toEqual([]);
  });
});

// ============================================
// CACHE BEHAVIOR
// ============================================

describe("cache behavior", () => {
  it("setServerBlob invalidates cache — subsequent reads see new data", async () => {
    await vaultSetServerBlob("CACHED", "srv:v1");
    expect(await vaultGetBlob("CACHED")).toBe("srv:v1");
    await vaultSetServerBlob("CACHED", "srv:v2");
    expect(await vaultGetBlob("CACHED")).toBe("srv:v2");
  });

  it("delete invalidates cache — subsequent reads don't see deleted key", async () => {
    await vaultSetServerBlob("TEMP", "srv:val");
    expect(await vaultHas("TEMP")).toBe(true);
    await vaultDelete("TEMP");
    expect(await vaultHas("TEMP")).toBe(false);
  });
});
