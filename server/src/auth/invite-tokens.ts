/**
 * Invite Token Store
 * 
 * Generates and manages invite tokens for device registration.
 * Stored in SQLite (dotbot.db, invite_tokens table).
 * 
 * Token format: dbot-XXXX-XXXX-XXXX-XXXX (base32, human-readable)
 * Only the SHA-256 hash is persisted — plaintext returned once at creation.
 */

import { randomBytes, createHash } from "crypto";
import { nanoid } from "nanoid";
import { getDatabase } from "../db/index.js";
import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("auth.invite-tokens");

// ============================================
// TYPES
// ============================================

export interface InviteToken {
  tokenHash: string;
  createdAt: string;
  createdBy: string;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  label: string;
  status: "active" | "consumed" | "revoked" | "expired";
}

// ============================================
// CONSTANTS
// ============================================

const TOKEN_PREFIX = "dbot";
const TOKEN_SEGMENT_LENGTH = 4;
const TOKEN_SEGMENTS = 4;
const DEFAULT_EXPIRY_DAYS = 7;
const DEFAULT_MAX_USES = 1;

// Base32 alphabet without ambiguous chars (0/O, 1/l/I)
const BASE32_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// ============================================
// TOKEN GENERATION
// ============================================

function generateTokenString(): string {
  const segments: string[] = [];
  for (let s = 0; s < TOKEN_SEGMENTS; s++) {
    let segment = "";
    const bytes = randomBytes(TOKEN_SEGMENT_LENGTH);
    for (let i = 0; i < TOKEN_SEGMENT_LENGTH; i++) {
      segment += BASE32_CHARS[bytes[i] % BASE32_CHARS.length];
    }
    segments.push(segment);
  }
  return `${TOKEN_PREFIX}-${segments.join("-")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ============================================
// HELPERS
// ============================================

function rowToToken(row: any): InviteToken {
  return {
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    createdBy: row.created_by,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    label: row.label || "Invite token",
    status: row.status,
  };
}

/**
 * Expire any active tokens whose expiry has passed.
 * Called before reads to keep status accurate.
 */
function expireTokens(): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE invite_tokens SET status = 'expired' WHERE status = 'active' AND expires_at < ?"
  ).run(now);
}

// ============================================
// PUBLIC API
// ============================================

export function createInviteToken(options?: {
  maxUses?: number;
  expiryDays?: number;
  label?: string;
  createdBy?: string;
}): { token: string; expiresAt: string } {
  const db = getDatabase();
  expireTokens();

  const token = generateTokenString();
  const expiryDays = options?.expiryDays ?? DEFAULT_EXPIRY_DAYS;
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();
  const label = options?.label ?? "Invite token";
  const createdBy = options?.createdBy ?? "admin";
  const maxUses = options?.maxUses ?? DEFAULT_MAX_USES;

  db.prepare(`
    INSERT INTO invite_tokens (id, token_hash, created_by, max_uses, expires_at, label, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(`tok_${nanoid(12)}`, hashToken(token), createdBy, maxUses, expiresAt, label);

  log.info("Created invite token", { label, maxUses, expiresAt });
  return { token, expiresAt };
}

export function validateAndConsumeToken(token: string): { valid: boolean; reason?: string } {
  const db = getDatabase();
  expireTokens();

  const hash = hashToken(token);
  const row = db.prepare("SELECT * FROM invite_tokens WHERE token_hash = ?").get(hash) as any;

  if (!row) {
    return { valid: false, reason: "invalid_token" };
  }

  if (row.status === "revoked") {
    return { valid: false, reason: "token_revoked" };
  }

  if (row.status === "expired") {
    return { valid: false, reason: "token_expired" };
  }

  if (row.status === "consumed") {
    return { valid: false, reason: "token_consumed" };
  }

  if (row.used_count >= row.max_uses) {
    db.prepare("UPDATE invite_tokens SET status = 'consumed' WHERE id = ?").run(row.id);
    return { valid: false, reason: "token_consumed" };
  }

  // Consume the token
  const newCount = row.used_count + 1;
  const newStatus = newCount >= row.max_uses ? "consumed" : "active";
  db.prepare("UPDATE invite_tokens SET used_count = ?, status = ? WHERE id = ?").run(newCount, newStatus, row.id);

  log.info("Invite token consumed", { label: row.label, usedCount: newCount, maxUses: row.max_uses });
  return { valid: true };
}

export function revokeToken(token: string): boolean {
  const db = getDatabase();
  const hash = hashToken(token);
  const row = db.prepare("SELECT * FROM invite_tokens WHERE token_hash = ? AND status != 'revoked'").get(hash) as any;

  if (!row) return false;

  db.prepare("UPDATE invite_tokens SET status = 'revoked' WHERE id = ?").run(row.id);
  log.info("Invite token revoked", { label: row.label });
  return true;
}

export function listTokens(): InviteToken[] {
  const db = getDatabase();
  expireTokens();
  const rows = db.prepare("SELECT * FROM invite_tokens ORDER BY created_at DESC").all() as any[];
  return rows.map(rowToToken);
}

export function getActiveTokenCount(): number {
  const db = getDatabase();
  expireTokens();
  return (db.prepare("SELECT COUNT(*) as cnt FROM invite_tokens WHERE status = 'active'").get() as any)?.cnt || 0;
}

export function hasAnyTokens(): boolean {
  const db = getDatabase();
  return ((db.prepare("SELECT COUNT(*) as cnt FROM invite_tokens").get() as any)?.cnt || 0) > 0;
}

export function peekToken(token: string): { valid: boolean; label?: string; expiresAt?: string } {
  const db = getDatabase();
  expireTokens();

  const hash = hashToken(token);
  const row = db.prepare("SELECT * FROM invite_tokens WHERE token_hash = ?").get(hash) as any;

  if (!row || row.status !== "active") {
    return { valid: false };
  }
  if (row.used_count >= row.max_uses) {
    return { valid: false };
  }
  return { valid: true, label: row.label, expiresAt: row.expires_at };
}
