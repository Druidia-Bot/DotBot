/**
 * Invite Token Store Tests
 * 
 * Uses in-memory SQLite — no filesystem mocks needed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  createInviteToken,
  validateAndConsumeToken,
  revokeToken,
  listTokens,
  getActiveTokenCount,
  hasAnyTokens,
} from "./invite-tokens.js";

let testDb: Database.Database;

vi.mock("../db/index.js", () => ({
  getDatabase: () => testDb,
}));
vi.mock("../logging.js", () => ({
  createComponentLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE invite_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT DEFAULT 'admin',
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      expires_at DATETIME NOT NULL,
      label TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

describe("invite-tokens", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  describe("createInviteToken", () => {
    it("creates a token with dbot- prefix and 4 segments", () => {
      const { token } = createInviteToken();
      expect(token).toMatch(/^dbot-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    it("inserts a row into the database", () => {
      createInviteToken();
      const rows = testDb.prepare("SELECT * FROM invite_tokens").all();
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).status).toBe("active");
    });

    it("stores only the hash, never the plaintext", () => {
      const { token } = createInviteToken();
      const row = testDb.prepare("SELECT * FROM invite_tokens").get() as any;
      expect(row.token_hash).toBeDefined();
      expect(row.token_hash).toHaveLength(64); // SHA-256 hex
      expect(row.token_hash).not.toBe(token);
    });

    it("respects custom maxUses and expiryDays", () => {
      createInviteToken({ maxUses: 5, expiryDays: 14, label: "batch" });
      const row = testDb.prepare("SELECT * FROM invite_tokens").get() as any;
      expect(row.max_uses).toBe(5);
      expect(row.label).toBe("batch");
    });

    it("returns expiresAt timestamp", () => {
      const { expiresAt } = createInviteToken({ expiryDays: 7 });
      const expires = new Date(expiresAt);
      const now = Date.now();
      expect(expires.getTime()).toBeGreaterThan(now + 6 * 24 * 60 * 60 * 1000);
      expect(expires.getTime()).toBeLessThan(now + 8 * 24 * 60 * 60 * 1000);
    });
  });

  describe("validateAndConsumeToken", () => {
    it("validates and consumes a valid single-use token", () => {
      const { token } = createInviteToken();
      const result = validateAndConsumeToken(token);
      expect(result.valid).toBe(true);

      // Check consumed in DB
      const row = testDb.prepare("SELECT * FROM invite_tokens").get() as any;
      expect(row.status).toBe("consumed");
      expect(row.used_count).toBe(1);
    });

    it("rejects an invalid token", () => {
      const result = validateAndConsumeToken("dbot-XXXX-XXXX-XXXX-XXXX");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_token");
    });

    it("rejects a revoked token", () => {
      const { token } = createInviteToken();
      revokeToken(token);

      const result = validateAndConsumeToken(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("token_revoked");
    });

    it("rejects an expired token", () => {
      const { token } = createInviteToken({ expiryDays: 1 });
      // Manually set expiry to yesterday
      testDb.prepare("UPDATE invite_tokens SET expires_at = ?").run(
        new Date(Date.now() - 86400000).toISOString()
      );

      const result = validateAndConsumeToken(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("token_expired");
    });

    it("allows multi-use tokens until maxUses reached", () => {
      const { token } = createInviteToken({ maxUses: 3 });

      expect(validateAndConsumeToken(token).valid).toBe(true); // use 1
      expect(validateAndConsumeToken(token).valid).toBe(true); // use 2
      expect(validateAndConsumeToken(token).valid).toBe(true); // use 3 → consumed

      // 4th use should fail
      expect(validateAndConsumeToken(token).valid).toBe(false);
      expect(validateAndConsumeToken(token).reason).toBe("token_consumed");
    });
  });

  describe("revokeToken", () => {
    it("revokes an active token", () => {
      const { token } = createInviteToken();
      const result = revokeToken(token);
      expect(result).toBe(true);

      const row = testDb.prepare("SELECT * FROM invite_tokens").get() as any;
      expect(row.status).toBe("revoked");
    });

    it("returns false for already-revoked token", () => {
      const { token } = createInviteToken();
      revokeToken(token);
      expect(revokeToken(token)).toBe(false);
    });
  });

  describe("listTokens", () => {
    it("returns tokens with hash but no plaintext", () => {
      createInviteToken({ label: "test-token" });
      const tokens = listTokens();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].label).toBe("test-token");
      expect(tokens[0].tokenHash).toBeDefined();
      expect((tokens[0] as any).token).toBeUndefined();
    });

    it("returns multiple tokens", () => {
      createInviteToken({ label: "first" });
      createInviteToken({ label: "second" });
      expect(listTokens()).toHaveLength(2);
    });
  });

  describe("getActiveTokenCount", () => {
    it("returns 0 for empty store", () => {
      expect(getActiveTokenCount()).toBe(0);
    });

    it("counts only active tokens", () => {
      const { token: t1 } = createInviteToken();
      createInviteToken();
      revokeToken(t1);
      expect(getActiveTokenCount()).toBe(1);
    });
  });

  describe("hasAnyTokens", () => {
    it("returns false for empty store", () => {
      expect(hasAnyTokens()).toBe(false);
    });

    it("returns true when tokens exist", () => {
      createInviteToken();
      expect(hasAnyTokens()).toBe(true);
    });
  });
});
