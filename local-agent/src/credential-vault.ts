/**
 * Credential Vault — Server-Encrypted Credential Storage
 * 
 * Security architecture:
 * - All credentials are encrypted server-side (AES-256-GCM, HKDF domain-scoped keys)
 * - The client stores only opaque encrypted blobs ("srv:" prefix)
 * - The LLM/server only ever sees credential NAMES (references), never values
 * - When a tool needs a credential, the encrypted blob is sent to the server
 *   for proxied execution — plaintext credential NEVER exists on the client
 * - Stored in ~/.bot/vault.json as server-encrypted blob strings
 * 
 * The vault replaces plain-text ~/.bot/.env for sensitive credentials.
 * Non-sensitive config (DOTBOT_SERVER, guild IDs, etc.) can stay in .env.
 */

import { promises as fs } from "fs";
import { resolve, dirname } from "path";
import { platform } from "os";

// ============================================
// TYPES
// ============================================

interface VaultFile {
  version: "1";
  /** Map of credential name → server-encrypted blob string ("srv:" prefix) */
  credentials: Record<string, string>;
}

// ============================================
// PATH
// ============================================

function getVaultPath(): string {
  const profile = process.env.USERPROFILE || process.env.HOME || "";
  return resolve(profile, ".bot", "vault.json");
}

// ============================================
// VAULT FILE I/O
// ============================================

async function readVaultFile(): Promise<VaultFile> {
  const vaultPath = getVaultPath();
  try {
    const content = await fs.readFile(vaultPath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed.version === "1" && typeof parsed.credentials === "object") {
      return parsed as VaultFile;
    }
  } catch {
    // File doesn't exist or is malformed — start fresh
  }
  return { version: "1", credentials: {} };
}

async function writeVaultFile(vault: VaultFile): Promise<void> {
  const vaultPath = getVaultPath();
  await fs.mkdir(dirname(vaultPath), { recursive: true });

  // M-08 fix: Set restrictive permissions (Unix only — mode is ignored on Windows)
  // Note: While encrypted blobs can't be decrypted by the client, credential names
  // and existence are visible if the file is world-readable.
  await fs.writeFile(vaultPath, JSON.stringify(vault, null, 2), {
    encoding: "utf-8",
    mode: 0o600, // Owner read/write only
  });

  // Windows limitation: Unix permissions are ignored. The file may be readable by other users.
  // This is documented but not warned on every write (unlike master.key) since vault.json
  // changes frequently. To lock down on Windows, run:
  //   icacls "%USERPROFILE%\.bot\vault.json" /inheritance:r /grant:r "%USERNAME%:F"
}

// ============================================
// IN-MEMORY CACHE
// ============================================

// Cache the vault file in memory to avoid re-reading disk on every has/list call.
// Encrypted blobs only — never plaintext values.
let cachedVault: VaultFile | null = null;

async function getVault(): Promise<VaultFile> {
  if (!cachedVault) {
    cachedVault = await readVaultFile();
  }
  return cachedVault;
}

/** @internal Exported for testing only — clears the in-memory vault cache. */
export function invalidateCache(): void {
  cachedVault = null;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Store a server-encrypted blob in the vault.
 * The blob is already encrypted by the server — we just store it as-is.
 * Must start with "srv:" prefix.
 */
export async function vaultSetServerBlob(name: string, blob: string): Promise<void> {
  if (!blob.startsWith("srv:")) {
    throw new Error("Server-encrypted blobs must start with 'srv:' prefix");
  }
  const vault = await getVault();
  const updated: VaultFile = {
    version: vault.version,
    credentials: { ...vault.credentials, [name]: blob },
  };
  await writeVaultFile(updated);
  invalidateCache();
}

/**
 * Get the raw encrypted blob string for a credential.
 * Used by the credential proxy to send the blob to the server for decryption.
 */
export async function vaultGetBlob(name: string): Promise<string | null> {
  const vault = await getVault();
  return vault.credentials[name] || null;
}

/**
 * Check if a credential is server-encrypted.
 * All credentials should be server-encrypted ("srv:" prefix).
 */
export async function isServerEncrypted(name: string): Promise<boolean> {
  const vault = await getVault();
  const blob = vault.credentials[name];
  return !!blob && blob.startsWith("srv:");
}

/**
 * Check if a credential exists in the vault.
 * Safe to share with server — reveals name only, never value.
 */
export async function vaultHas(name: string): Promise<boolean> {
  const vault = await getVault();
  return name in vault.credentials;
}

/**
 * List all credential names in the vault.
 * Safe to share with server — names only, never values.
 */
export async function vaultList(): Promise<string[]> {
  const vault = await getVault();
  return Object.keys(vault.credentials);
}

/**
 * Delete a credential from the vault.
 */
export async function vaultDelete(name: string): Promise<boolean> {
  const vault = await getVault();
  if (!(name in vault.credentials)) return false;
  // Clone before mutating — if writeVaultFile throws, the cache stays clean
  const { [name]: _removed, ...rest } = vault.credentials;
  const updated: VaultFile = { version: vault.version, credentials: rest };
  await writeVaultFile(updated);
  invalidateCache();
  return true;
}

