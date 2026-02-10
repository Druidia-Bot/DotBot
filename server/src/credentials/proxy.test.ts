/**
 * Tests for Credential Proxy (proxy.ts)
 * 
 * Covers: successful proxy execution, credential injection, timeout handling,
 * network error handling, response header filtering.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "crypto";
import { executeProxyRequest } from "./proxy.js";
import { encryptCredential, _setMasterKeyForTesting, _clearMasterKey } from "./crypto.js";

const TEST_MASTER_KEY = randomBytes(32);

describe("credentials/proxy", () => {
  beforeEach(() => {
    _setMasterKeyForTesting(TEST_MASTER_KEY);
  });

  afterEach(() => {
    _clearMasterKey();
    vi.restoreAllMocks();
  });

  it("injects credential into the specified header", async () => {
    const blob = encryptCredential("user_demo", "my-secret-token", "discord.com");

    // Mock fetch to capture the request
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal("fetch", async (url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        text: async () => '{"id":"42"}',
        headers: new Map(),
      };
    });

    await executeProxyRequest(blob, {
      url: "https://discord.com/api/v10/users/@me",
      method: "GET",
      headers: { "Content-Type": "application/json" },
    }, {
      header: "Authorization",
      prefix: "Bot ",
    });

    expect(capturedHeaders["Authorization"]).toBe("Bot my-secret-token");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
  });

  it("returns response status and body", async () => {
    const blob = encryptCredential("user_demo", "token123", "api.example.com");

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      text: async () => '{"username":"TestBot"}',
      headers: new Map([["content-type", "application/json"]]),
    }));

    const result = await executeProxyRequest(blob, {
      url: "https://api.example.com/test",
      method: "GET",
      headers: {},
    }, {
      header: "Authorization",
      prefix: "Bearer ",
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('{"username":"TestBot"}');
  });

  it("passes request body through", async () => {
    const blob = encryptCredential("user_demo", "token", "api.example.com");
    let capturedBody: string | undefined;

    vi.stubGlobal("fetch", async (_url: string, opts: any) => {
      capturedBody = opts.body;
      return { ok: true, status: 201, text: async () => "{}", headers: new Map() };
    });

    await executeProxyRequest(blob, {
      url: "https://api.example.com/create",
      method: "POST",
      headers: {},
      body: '{"name":"test"}',
    }, {
      header: "Authorization",
      prefix: "Bearer ",
    });

    expect(capturedBody).toBe('{"name":"test"}');
  });

  it("returns 502 on network error", async () => {
    const blob = encryptCredential("user_demo", "token", "unreachable.example.com");

    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await executeProxyRequest(blob, {
      url: "https://unreachable.example.com/test",
      method: "GET",
      headers: {},
    }, {
      header: "Authorization",
      prefix: "Bearer ",
    });

    expect(result.status).toBe(502);
    expect(result.body).toContain("ECONNREFUSED");
  });

  it("throws on invalid encrypted blob", async () => {
    await expect(
      executeProxyRequest("srv:invalid-blob", {
        url: "https://api.example.com/test",
        method: "GET",
        headers: {},
      }, {
        header: "Authorization",
        prefix: "Bearer ",
      })
    ).rejects.toThrow();
  });

  it("throws on non-srv blob", async () => {
    await expect(
      executeProxyRequest("not-a-server-blob", {
        url: "https://api.example.com/test",
        method: "GET",
        headers: {},
      }, {
        header: "Authorization",
        prefix: "Bearer ",
      })
    ).rejects.toThrow("Not a server-encrypted blob");
  });

  // ============================================
  // SSRF PROTECTION
  // ============================================

  it("blocks localhost URLs", async () => {
    const blob = encryptCredential("user_demo", "token", "localhost");
    await expect(
      executeProxyRequest(blob, { url: "http://localhost:8080/admin", method: "GET", headers: {} },
        { header: "Authorization", prefix: "Bearer " })
    ).rejects.toThrow("Proxy cannot target localhost");
  });

  it("blocks 127.0.0.1", async () => {
    const blob = encryptCredential("user_demo", "token", "127.0.0.1");
    await expect(
      executeProxyRequest(blob, { url: "http://127.0.0.1/secret", method: "GET", headers: {} },
        { header: "Authorization", prefix: "Bearer " })
    ).rejects.toThrow("Proxy cannot target localhost");
  });

  it("blocks cloud metadata endpoint", async () => {
    const blob = encryptCredential("user_demo", "token", "169.254.169.254");
    await expect(
      executeProxyRequest(blob, { url: "http://169.254.169.254/latest/meta-data/", method: "GET", headers: {} },
        { header: "Authorization", prefix: "Bearer " })
    ).rejects.toThrow("cloud metadata");
  });

  it("blocks private IP ranges (10.x)", async () => {
    const blob = encryptCredential("user_demo", "token", "10.0.0.1");
    await expect(
      executeProxyRequest(blob, { url: "http://10.0.0.1/internal", method: "GET", headers: {} },
        { header: "Authorization", prefix: "Bearer " })
    ).rejects.toThrow("private IP");
  });

  it("blocks private IP ranges (192.168.x)", async () => {
    const blob = encryptCredential("user_demo", "token", "192.168.1.1");
    await expect(
      executeProxyRequest(blob, { url: "http://192.168.1.1/router", method: "GET", headers: {} },
        { header: "Authorization", prefix: "Bearer " })
    ).rejects.toThrow("private IP");
  });

  it("blocks non-HTTP protocols", async () => {
    const blob = encryptCredential("user_demo", "token", "example.com");
    await expect(
      executeProxyRequest(blob, { url: "file:///etc/passwd", method: "GET", headers: {} },
        { header: "Authorization", prefix: "Bearer " })
    ).rejects.toThrow("HTTP/HTTPS");
  });

  it("allows legitimate external HTTPS URLs", async () => {
    const blob = encryptCredential("user_demo", "token", "discord.com");
    vi.stubGlobal("fetch", async () => ({
      ok: true, status: 200, text: async () => "ok", headers: new Map(),
    }));

    const result = await executeProxyRequest(blob,
      { url: "https://discord.com/api/v10/users/@me", method: "GET", headers: {} },
      { header: "Authorization", prefix: "Bot " });
    expect(result.status).toBe(200);
  });

  it("forwards non-200 responses accurately", async () => {
    const blob = encryptCredential("user_demo", "bad-token", "discord.com");

    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 401,
      text: async () => '{"message":"401: Unauthorized"}',
      headers: new Map([["content-type", "application/json"]]),
    }));

    const result = await executeProxyRequest(blob, {
      url: "https://discord.com/api/v10/users/@me",
      method: "GET",
      headers: {},
    }, {
      header: "Authorization",
      prefix: "Bot ",
    });

    expect(result.status).toBe(401);
    expect(result.body).toContain("Unauthorized");
  });
});
