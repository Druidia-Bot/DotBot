/**
 * Tests for Credential Entry Sessions (sessions.ts)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createSession,
  getSession,
  consumeSession,
  getActiveSessionCount,
  _clearAllSessions,
  stopSessionCleanup,
} from "./sessions.js";

describe("credentials/sessions", () => {
  beforeEach(() => {
    _clearAllSessions();
  });

  afterEach(() => {
    _clearAllSessions();
    stopSessionCleanup();
  });

  it("creates a session with a random token", () => {
    const session = createSession({
      userId: "user_demo",
      deviceId: "device_1",
      keyName: "DISCORD_BOT_TOKEN",
      prompt: "Enter your Discord bot token",
      allowedDomain: "discord.com",
    });

    expect(session.token).toHaveLength(64); // 32 bytes hex
    expect(session.userId).toBe("user_demo");
    expect(session.keyName).toBe("DISCORD_BOT_TOKEN");
    expect(session.allowedDomain).toBe("discord.com");
    expect(session.consumed).toBe(false);
  });

  it("retrieves a valid session by token", () => {
    const created = createSession({
      userId: "user_demo",
      deviceId: "device_1",
      keyName: "KEY",
      prompt: "Enter key",
      allowedDomain: "api.example.com",
    });

    const retrieved = getSession(created.token);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.keyName).toBe("KEY");
  });

  it("returns null for unknown token", () => {
    expect(getSession("nonexistent-token")).toBeNull();
  });

  it("returns null for consumed session", () => {
    const session = createSession({
      userId: "user_demo",
      deviceId: "device_1",
      keyName: "KEY",
      prompt: "Enter key",
      allowedDomain: "api.example.com",
    });

    consumeSession(session.token);
    expect(getSession(session.token)).toBeNull();
  });

  it("counts active sessions", () => {
    expect(getActiveSessionCount()).toBe(0);

    createSession({ userId: "u1", deviceId: "d1", keyName: "K1", prompt: "P1", allowedDomain: "a.com" });
    createSession({ userId: "u2", deviceId: "d2", keyName: "K2", prompt: "P2", allowedDomain: "b.com" });

    expect(getActiveSessionCount()).toBe(2);
  });

  it("consumed sessions don't count as active", () => {
    const s1 = createSession({ userId: "u1", deviceId: "d1", keyName: "K1", prompt: "P1", allowedDomain: "a.com" });
    createSession({ userId: "u2", deviceId: "d2", keyName: "K2", prompt: "P2", allowedDomain: "b.com" });

    consumeSession(s1.token);
    expect(getActiveSessionCount()).toBe(1);
  });

  it("uses custom title when provided", () => {
    const session = createSession({
      userId: "user_demo",
      deviceId: "device_1",
      keyName: "KEY",
      prompt: "Enter key",
      title: "Custom Title",
      allowedDomain: "api.example.com",
    });

    expect(session.title).toBe("Custom Title");
  });

  it("uses default title when not provided", () => {
    const session = createSession({
      userId: "user_demo",
      deviceId: "device_1",
      keyName: "KEY",
      prompt: "Enter key",
      allowedDomain: "api.example.com",
    });

    expect(session.title).toContain("DotBot");
  });

  it("each session gets a unique token", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const s = createSession({ userId: "u", deviceId: "d", keyName: "K", prompt: "P", allowedDomain: "x.com" });
      tokens.add(s.token);
    }
    expect(tokens.size).toBe(10);
  });
});
