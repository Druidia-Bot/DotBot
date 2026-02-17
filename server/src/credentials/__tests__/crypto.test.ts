/**
 * Tests for Server-Side Credential Encryption (crypto.ts)
 * 
 * Covers: master key init, encrypt/decrypt round-trip, per-user key isolation,
 * tamper detection, blob validation, error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";
import {
  encryptCredential,
  decryptCredential,
  isServerEncryptedBlob,
  _setMasterKeyForTesting,
  _clearMasterKey,
} from "../crypto.js";

// Use a fixed test key so tests are deterministic and don't touch disk
const TEST_MASTER_KEY = randomBytes(32);

describe("credentials/crypto", () => {
  beforeEach(() => {
    _setMasterKeyForTesting(TEST_MASTER_KEY);
  });

  afterEach(() => {
    _clearMasterKey();
  });

  // ============================================
  // ROUND-TRIP ENCRYPT/DECRYPT
  // ============================================

  describe("encrypt → decrypt round-trip", () => {
    it("encrypts and decrypts a simple string", () => {
      const plaintext = "my-secret-api-key-12345";
      const blob = encryptCredential("user_demo", plaintext, "discord.com");
      const result = decryptCredential(blob);
      expect(result).toBe(plaintext);
    });

    it("handles empty string", () => {
      const blob = encryptCredential("user_demo", "", "discord.com");
      expect(decryptCredential(blob)).toBe("");
    });

    it("handles unicode characters", () => {
      const plaintext = "pässwörd-日本語-🔑";
      const blob = encryptCredential("user_demo", plaintext, "api.example.com");
      expect(decryptCredential(blob)).toBe(plaintext);
    });

    it("handles long values (Discord token length)", () => {
      const plaintext = "MTE5NTY1Nzc5MDI3MDk5NjU5Mg.GqZKlc.abc123def456ghi789jkl012mno345pqr678stu901";
      const blob = encryptCredential("user_demo", plaintext, "discord.com");
      expect(decryptCredential(blob)).toBe(plaintext);
    });

    it("produces different ciphertext each time (random IV)", () => {
      const plaintext = "same-value";
      const blob1 = encryptCredential("user_demo", plaintext, "discord.com");
      const blob2 = encryptCredential("user_demo", plaintext, "discord.com");
      expect(blob1).not.toBe(blob2); // Different IVs → different blobs
      // But both decrypt to the same value
      expect(decryptCredential(blob1)).toBe(plaintext);
      expect(decryptCredential(blob2)).toBe(plaintext);
    });
  });

  // ============================================
  // BLOB FORMAT
  // ============================================

  describe("blob format", () => {
    it("starts with srv: prefix", () => {
      const blob = encryptCredential("user_demo", "test", "discord.com");
      expect(blob.startsWith("srv:")).toBe(true);
    });

    it("contains valid base64 after prefix", () => {
      const blob = encryptCredential("user_demo", "test", "discord.com");
      const b64 = blob.slice(4);
      expect(() => Buffer.from(b64, "base64")).not.toThrow();
    });

    it("contains valid JSON structure inside base64", () => {
      const blob = encryptCredential("user_demo", "test", "discord.com");
      const json = JSON.parse(Buffer.from(blob.slice(4), "base64").toString("utf-8"));
      expect(json.v).toBe(1);
      expect(json.u).toBe("user_demo");
      expect(json.d).toBe("discord.com");
      expect(typeof json.iv).toBe("string");
      expect(typeof json.tag).toBe("string");
      expect(typeof json.ct).toBe("string");
    });
  });

  // ============================================
  // PER-USER KEY ISOLATION
  // ============================================

  describe("per-user key isolation", () => {
    it("different users cannot decrypt each other's credentials", () => {
      const blob = encryptCredential("user_alice", "alice-secret", "discord.com");
      // Manually change the userId in the blob to simulate cross-user attack
      const parsed = JSON.parse(Buffer.from(blob.slice(4), "base64").toString("utf-8"));
      parsed.u = "user_bob"; // Attacker tries to use Bob's key
      const tampered = "srv:" + Buffer.from(JSON.stringify(parsed)).toString("base64");
      expect(() => decryptCredential(tampered)).toThrow();
    });

    it("same user can decrypt their own credentials", () => {
      const blob = encryptCredential("user_alice", "alice-secret", "discord.com");
      expect(decryptCredential(blob)).toBe("alice-secret");
    });
  });

  // ============================================
  // TAMPER DETECTION (GCM auth tag)
  // ============================================

  describe("tamper detection", () => {
    it("detects modified ciphertext", () => {
      const blob = encryptCredential("user_demo", "secret", "discord.com");
      const parsed = JSON.parse(Buffer.from(blob.slice(4), "base64").toString("utf-8"));
      // Flip a byte in the ciphertext
      const ctBuf = Buffer.from(parsed.ct, "hex");
      ctBuf[0] ^= 0xFF;
      parsed.ct = ctBuf.toString("hex");
      const tampered = "srv:" + Buffer.from(JSON.stringify(parsed)).toString("base64");
      expect(() => decryptCredential(tampered)).toThrow();
    });

    it("detects modified auth tag", () => {
      const blob = encryptCredential("user_demo", "secret", "discord.com");
      const parsed = JSON.parse(Buffer.from(blob.slice(4), "base64").toString("utf-8"));
      const tagBuf = Buffer.from(parsed.tag, "hex");
      tagBuf[0] ^= 0xFF;
      parsed.tag = tagBuf.toString("hex");
      const tampered = "srv:" + Buffer.from(JSON.stringify(parsed)).toString("base64");
      expect(() => decryptCredential(tampered)).toThrow();
    });

    it("detects modified IV", () => {
      const blob = encryptCredential("user_demo", "secret", "discord.com");
      const parsed = JSON.parse(Buffer.from(blob.slice(4), "base64").toString("utf-8"));
      const ivBuf = Buffer.from(parsed.iv, "hex");
      ivBuf[0] ^= 0xFF;
      parsed.iv = ivBuf.toString("hex");
      const tampered = "srv:" + Buffer.from(JSON.stringify(parsed)).toString("base64");
      expect(() => decryptCredential(tampered)).toThrow();
    });
  });

  // ============================================
  // ERROR HANDLING
  // ============================================

  describe("error handling", () => {
    it("rejects blob without srv: prefix", () => {
      expect(() => decryptCredential("not-a-valid-blob")).toThrow("Not a server-encrypted blob");
    });

    it("rejects malformed base64", () => {
      expect(() => decryptCredential("srv:!!!not-base64!!!")).toThrow();
    });

    it("rejects blob with wrong version", () => {
      const blob = encryptCredential("user_demo", "test", "discord.com");
      const parsed = JSON.parse(Buffer.from(blob.slice(4), "base64").toString("utf-8"));
      parsed.v = 99;
      const bad = "srv:" + Buffer.from(JSON.stringify(parsed)).toString("base64");
      expect(() => decryptCredential(bad)).toThrow("Unsupported blob version");
    });

    it("rejects blob with missing fields", () => {
      const bad = "srv:" + Buffer.from(JSON.stringify({ v: 1 })).toString("base64");
      expect(() => decryptCredential(bad)).toThrow("missing required fields");
    });

    it("throws if master key not initialized", () => {
      _clearMasterKey();
      expect(() => encryptCredential("user_demo", "test", "discord.com")).toThrow("Master key not initialized");
    });
  });

  // ============================================
  // isServerEncryptedBlob
  // ============================================

  describe("isServerEncryptedBlob", () => {
    it("returns true for valid server blobs", () => {
      const blob = encryptCredential("user_demo", "test", "discord.com");
      expect(isServerEncryptedBlob(blob)).toBe(true);
    });

    it("returns false for non-srv strings", () => {
      expect(isServerEncryptedBlob("dpapi-encrypted-stuff")).toBe(false);
    });

    it("returns false for malformed srv blobs", () => {
      expect(isServerEncryptedBlob("srv:not-valid-json")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isServerEncryptedBlob("")).toBe(false);
    });
  });

  // ============================================
  // DIFFERENT MASTER KEYS
  // ============================================

  describe("master key dependency", () => {
    it("cannot decrypt with a different master key", () => {
      const blob = encryptCredential("user_demo", "secret", "discord.com");

      // Switch to a different master key
      _setMasterKeyForTesting(randomBytes(32));

      expect(() => decryptCredential(blob)).toThrow();
    });
  });

  // ============================================
  // DOMAIN-SCOPED ENCRYPTION
  // ============================================

  describe("domain-scoped encryption", () => {
    it("credential encrypted for discord.com can only decrypt for discord.com", () => {
      const blob = encryptCredential("user_demo", "token", "discord.com");
      expect(decryptCredential(blob, "discord.com")).toBe("token");
    });

    it("rejects domain mismatch with clear error", () => {
      const blob = encryptCredential("user_demo", "token", "discord.com");
      expect(() => decryptCredential(blob, "attacker.com")).toThrow("Domain mismatch");
    });

    it("domain is case-insensitive", () => {
      const blob = encryptCredential("user_demo", "token", "Discord.Com");
      expect(decryptCredential(blob, "discord.com")).toBe("token");
      expect(decryptCredential(blob, "DISCORD.COM")).toBe("token");
    });

    it("tampered domain field causes decryption failure", () => {
      const blob = encryptCredential("user_demo", "token", "discord.com");
      const parsed = JSON.parse(Buffer.from(blob.slice(4), "base64").toString("utf-8"));
      parsed.d = "attacker.com"; // Tamper with the domain metadata
      const tampered = "srv:" + Buffer.from(JSON.stringify(parsed)).toString("base64");
      // Even though blob.d now says attacker.com, the HKDF key was derived with discord.com
      // So decryption will fail because the derived key is wrong
      expect(() => decryptCredential(tampered)).toThrow();
    });

    it("different domains produce different keys for same user", () => {
      const blob1 = encryptCredential("user_demo", "token", "discord.com");
      const blob2 = encryptCredential("user_demo", "token", "api.openai.com");
      // Both decrypt with their own domain
      expect(decryptCredential(blob1, "discord.com")).toBe("token");
      expect(decryptCredential(blob2, "api.openai.com")).toBe("token");
      // But cross-decryption fails
      expect(() => decryptCredential(blob1, "api.openai.com")).toThrow("Domain mismatch");
    });

    it("requires allowedDomain on encryption", () => {
      expect(() => encryptCredential("user_demo", "token", "")).toThrow("allowedDomain is required");
    });

    it("allows decryption without requestDomain check", () => {
      const blob = encryptCredential("user_demo", "token", "discord.com");
      // No requestDomain = skip the domain mismatch check (still uses blob.d for key derivation)
      expect(decryptCredential(blob)).toBe("token");
    });
  });
});
