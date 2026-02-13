/**
 * Server-Side Credential Encryption
 * 
 * Split-knowledge architecture:
 * - Encrypted blob stored on CLIENT (can't decrypt without server key)
 * - Encryption key stored on SERVER only (useless without client blob)
 * - Decryption happens ONLY on the server during proxied API calls
 * - Real credential NEVER exists in plaintext on the client
 * 
 * Encryption: AES-256-GCM (authenticated encryption — integrity + confidentiality)
 * Key derivation: HKDF(SHA-512, masterKey, userId+domain) — unique key per user+domain
 * Master key: 32 bytes random, generated once on first server start
 */

import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { platform } from "os";
import { getBotPath } from "../init.js";

// ============================================
// CONSTANTS
// ============================================

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;       // 128-bit IV for AES-GCM
const TAG_LENGTH = 16;      // 128-bit authentication tag
const KEY_LENGTH = 32;      // 256-bit key
const HKDF_INFO = "dotbot-credential-v1";
const BLOB_VERSION = 1;

// ============================================
// MASTER KEY MANAGEMENT
// ============================================

let masterKey: Buffer | null = null;

function getMasterKeyPath(): string {
  return join(getBotPath("server-data"), "master.key");
}

/**
 * Initialize the master key. Generates a new one on first run.
 * Must be called once at server startup.
 */
export function initMasterKey(): void {
  const keyPath = getMasterKeyPath();

  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath);
    if (raw.length !== KEY_LENGTH) {
      throw new Error(`Master key file is corrupt (expected ${KEY_LENGTH} bytes, got ${raw.length}). Delete ${keyPath} to regenerate — WARNING: this will invalidate all existing encrypted credentials.`);
    }
    masterKey = raw;
    console.log("[Credentials] Master key loaded");
  } else {
    // First run — generate a new master key
    masterKey = randomBytes(KEY_LENGTH);
    mkdirSync(join(getBotPath("server-data")), { recursive: true });

    // Set restrictive permissions (Unix only — mode is ignored on Windows)
    writeFileSync(keyPath, masterKey, { mode: 0o600 });

    if (platform() === "win32") {
      console.warn("[Credentials] WARNING: Running on Windows — Unix file permissions (mode 0o600) are ignored.");
      console.warn("[Credentials] Master key file may be readable by other users. Consider using icacls to restrict ACLs:");
      console.warn(`[Credentials]   icacls "${keyPath}" /inheritance:r /grant:r "%USERNAME%:F"`);
    }

    console.log("[Credentials] Generated new master key");
  }
}

/**
 * Get the master key. Throws if not initialized.
 */
function requireMasterKey(): Buffer {
  if (!masterKey) {
    throw new Error("Master key not initialized. Call initMasterKey() at server startup.");
  }
  return masterKey;
}

// ============================================
// KEY DERIVATION
// ============================================

/**
 * Derive a per-user, per-domain encryption key from the master key.
 * Uses HKDF (HMAC-based Key Derivation Function) with SHA-512.
 * 
 * Each (user, domain) pair gets a unique key — the credential is
 * cryptographically bound to its intended API domain.
 */
function deriveUserKey(userId: string, allowedDomain: string): Buffer {
  const master = requireMasterKey();
  // info includes domain so the key is intrinsically bound to it
  const info = `${HKDF_INFO}:${allowedDomain}`;
  // hkdfSync(digest, ikm, salt, info, keyLength)
  return Buffer.from(
    hkdfSync("sha512", master, userId, info, KEY_LENGTH)
  );
}

// ============================================
// ENCRYPT / DECRYPT
// ============================================

/**
 * Encrypted blob format (JSON, then base64-encoded):
 * {
 *   v: 1,           // blob version (for future key rotation)
 *   u: "user_demo", // userId (needed to derive the correct key)
 *   d: "discord.com", // allowed domain (baked into key derivation)
 *   iv: "hex...",    // initialization vector
 *   tag: "hex...",   // GCM authentication tag
 *   ct: "hex..."     // ciphertext
 * }
 */
export interface EncryptedBlob {
  v: number;
  u: string;
  d: string;
  iv: string;
  tag: string;
  ct: string;
}

/**
 * Encrypt a credential value for a specific user, scoped to a specific API domain.
 * The domain is baked into the key derivation — the credential can ONLY be decrypted
 * when the proxy request targets the correct domain.
 * 
 * @param userId - The user who owns this credential
 * @param plaintext - The credential value to encrypt
 * @param allowedDomain - The API domain this credential is scoped to (e.g., "discord.com")
 * @returns A base64-encoded blob string (prefixed with "srv:" for client-side identification)
 */
export function encryptCredential(userId: string, plaintext: string, allowedDomain: string): string {
  if (!allowedDomain) {
    throw new Error("allowedDomain is required — credentials must be scoped to a specific API domain");
  }
  const domain = allowedDomain.toLowerCase();
  const key = deriveUserKey(userId, domain);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const blob: EncryptedBlob = {
    v: BLOB_VERSION,
    u: userId,
    d: domain,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ct: encrypted.toString("hex"),
  };

  // "srv:" prefix tells the client this is server-encrypted (not DPAPI)
  return "srv:" + Buffer.from(JSON.stringify(blob)).toString("base64");
}

/**
 * Decrypt a credential blob back to plaintext.
 * Only works on the server (requires master key).
 * 
 * @param blobString - The full blob string including "srv:" prefix
 * @param requestDomain - Optional: the domain of the actual proxy request.
 *   If provided, must match the blob's allowed domain. This is a belt-and-suspenders
 *   check — even without it, a domain mismatch causes decryption failure because
 *   the domain is baked into the HKDF key derivation.
 * @returns The plaintext credential value
 * @throws If blob is malformed, tampered with, domain mismatched, or key is wrong
 */
export function decryptCredential(blobString: string, requestDomain?: string): string {
  if (!blobString.startsWith("srv:")) {
    throw new Error("Not a server-encrypted blob (missing srv: prefix)");
  }

  const b64 = blobString.slice(4);

  let blob: EncryptedBlob;
  try {
    blob = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    throw new Error("Malformed encrypted blob — base64 or JSON parse failed");
  }

  if (blob.v !== BLOB_VERSION) {
    throw new Error(`Unsupported blob version: ${blob.v} (expected ${BLOB_VERSION})`);
  }
  if (blob.u == null || blob.d == null || blob.iv == null || blob.tag == null || blob.ct == null) {
    throw new Error("Malformed encrypted blob — missing required fields");
  }

  // Belt-and-suspenders: check domain before attempting decryption
  // Even without this check, wrong domain → wrong HKDF key → auth tag failure
  if (requestDomain && requestDomain.toLowerCase() !== blob.d) {
    throw new Error(
      `Domain mismatch: credential is scoped to "${blob.d}" but request targets "${requestDomain.toLowerCase()}". ` +
      `This credential cannot be used with a different API domain.`
    );
  }

  const key = deriveUserKey(blob.u, blob.d);
  const iv = Buffer.from(blob.iv, "hex");
  const tag = Buffer.from(blob.tag, "hex");
  const ciphertext = Buffer.from(blob.ct, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf-8");
  } catch {
    throw new Error("Decryption failed — blob may be tampered with or encrypted with a different key");
  }
}

/**
 * Extract the allowed domain from an encrypted blob without decrypting.
 * Useful for logging and validation.
 */
export function getBlobDomain(blobString: string): string | null {
  if (!blobString.startsWith("srv:")) return null;
  try {
    const blob = JSON.parse(Buffer.from(blobString.slice(4), "base64").toString("utf-8"));
    return blob.d || null;
  } catch {
    return null;
  }
}

/**
 * Validate that a blob string looks like a server-encrypted credential.
 * Does NOT attempt decryption — just checks structure.
 */
export function isServerEncryptedBlob(blobString: string): boolean {
  if (!blobString.startsWith("srv:")) return false;
  try {
    const blob = JSON.parse(Buffer.from(blobString.slice(4), "base64").toString("utf-8"));
    return blob.v === BLOB_VERSION && blob.u != null && blob.d != null && blob.iv != null && blob.tag != null && blob.ct != null;
  } catch {
    return false;
  }
}

// ============================================
// TESTING SUPPORT
// ============================================

/** @internal For testing only — set a specific master key */
export function _setMasterKeyForTesting(key: Buffer): void {
  masterKey = key;
}

/** @internal For testing only — clear the master key */
export function _clearMasterKey(): void {
  masterKey = null;
}
