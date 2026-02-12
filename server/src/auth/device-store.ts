/**
 * Device Store
 * 
 * Manages registered devices — persistent storage of device credentials,
 * hardware fingerprints, and metadata.
 * 
 * Stored in SQLite (dotbot.db, devices table).
 * Device secrets are stored as SHA-256 hashes — plaintext never persisted.
 */

import { randomBytes, createHash } from "crypto";
import { nanoid } from "nanoid";
import { getDatabase } from "../db/index.js";
import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("auth.device-store");

// ============================================
// TYPES
// ============================================

export interface RegisteredDevice {
  deviceId: string;
  secretHash: string;
  hwFingerprint: string;
  label: string;
  registeredAt: string;
  lastSeenAt: string;
  lastSeenIp: string;
  status: "active" | "revoked";
  isAdmin: boolean;
}

// ============================================
// CONSTANTS
// ============================================

const DEVICE_ID_PREFIX = "dev_";
const DEVICE_SECRET_BYTES = 32; // 256-bit

// ============================================
// HELPERS
// ============================================

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function rowToDevice(row: any): RegisteredDevice {
  return {
    deviceId: row.id,
    secretHash: row.secret_hash,
    hwFingerprint: row.hw_fingerprint,
    label: row.label,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_auth_at || row.registered_at,
    lastSeenIp: row.last_ip || "unknown",
    status: row.status,
    isAdmin: !!row.is_admin,
  };
}

// ============================================
// AUTH EVENT LOGGING
// ============================================

export function logAuthEvent(event: {
  eventType: "auth_success" | "auth_failure" | "register" | "revoke" | "fingerprint_mismatch";
  deviceId?: string;
  ip?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}): void {
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO auth_events (id, event_type, device_id, ip, reason, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `evt_${nanoid(12)}`,
      event.eventType,
      event.deviceId || null,
      event.ip || null,
      event.reason || null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      new Date().toISOString(),
    );
  } catch (err) {
    log.warn("Failed to log auth event", { error: err });
  }
}

export function getRecentFailures(ip: string, windowMinutes: number = 15): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM auth_events
    WHERE ip = ? AND event_type = 'auth_failure' AND created_at > ?
  `).get(ip, cutoff) as any;
  return row?.cnt || 0;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Register a new device. Returns the device ID and plaintext secret
 * (the secret is only returned ONCE — it's stored as a hash).
 */
export function registerDevice(options: {
  label: string;
  hwFingerprint: string;
  ip: string;
}): { deviceId: string; deviceSecret: string } {
  const db = getDatabase();

  const deviceId = `${DEVICE_ID_PREFIX}${randomBytes(8).toString("hex")}`;
  const deviceSecret = randomBytes(DEVICE_SECRET_BYTES).toString("base64url");

  // SEC-05: Only auto-promote to admin if no device has EVER been admin.
  // Checking active count alone allows re-promotion after revoking all devices.
  const hasEverHadAdmin = (db.prepare(
    "SELECT COUNT(*) as cnt FROM devices WHERE is_admin = 1"
  ).get() as any)?.cnt || 0;
  const isAdmin = hasEverHadAdmin === 0;

  db.prepare(`
    INSERT INTO devices (id, secret_hash, hw_fingerprint, label, status, is_admin, last_ip)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(deviceId, hashSecret(deviceSecret), options.hwFingerprint, options.label, isAdmin ? 1 : 0, options.ip);

  logAuthEvent({ eventType: "register", deviceId, ip: options.ip, metadata: { label: options.label, isAdmin } });
  log.info("Device registered", { deviceId, label: options.label, isAdmin });
  return { deviceId, deviceSecret };
}

/**
 * Authenticate a device. Validates secret AND hardware fingerprint.
 * Returns the reason for failure if auth fails.
 * 
 * On fingerprint mismatch: auth SUCCEEDS but fingerprint is updated
 * and a security warning is logged + admin notified. The device secret
 * (256-bit) is the real auth factor; the fingerprint is defense-in-depth
 * monitoring. Code updates that change the hash computation shouldn't
 * brick all devices.
 */
export function authenticateDevice(options: {
  deviceId: string;
  deviceSecret: string;
  hwFingerprint: string;
  ip: string;
}): { success: boolean; reason?: string; device?: RegisteredDevice; fingerprintChanged?: boolean } {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM devices WHERE id = ?").get(options.deviceId) as any;

  if (!row) {
    logAuthEvent({ eventType: "auth_failure", deviceId: options.deviceId, ip: options.ip, reason: "unknown_device" });
    return { success: false, reason: "unknown_device" };
  }

  const device = rowToDevice(row);

  if (device.status === "revoked") {
    logAuthEvent({ eventType: "auth_failure", deviceId: options.deviceId, ip: options.ip, reason: "device_revoked" });
    return { success: false, reason: "device_revoked" };
  }

  // Validate secret
  const secretHash = hashSecret(options.deviceSecret);
  if (secretHash !== device.secretHash) {
    logAuthEvent({ eventType: "auth_failure", deviceId: options.deviceId, ip: options.ip, reason: "invalid_credentials" });
    return { success: false, reason: "invalid_credentials" };
  }

  // Check hardware fingerprint — warn + update on mismatch (don't revoke)
  let fingerprintChanged = false;
  if (options.hwFingerprint !== device.hwFingerprint) {
    fingerprintChanged = true;
    db.prepare(
      "UPDATE devices SET hw_fingerprint = ? WHERE id = ?"
    ).run(options.hwFingerprint, options.deviceId);
    logAuthEvent({ eventType: "fingerprint_mismatch", deviceId: options.deviceId, ip: options.ip,
      metadata: { oldPrefix: device.hwFingerprint.slice(0, 8), newPrefix: options.hwFingerprint.slice(0, 8) },
    });
    log.warn("SECURITY: Hardware fingerprint changed — updated and allowing auth", {
      deviceId: device.deviceId,
      label: device.label,
      ip: options.ip,
    });
  }

  // Auth success — update last seen
  const now = new Date().toISOString();
  db.prepare("UPDATE devices SET last_auth_at = ?, last_ip = ? WHERE id = ?").run(now, options.ip, options.deviceId);
  logAuthEvent({ eventType: "auth_success", deviceId: options.deviceId, ip: options.ip });

  // Return updated device
  device.lastSeenAt = now;
  device.lastSeenIp = options.ip;
  if (fingerprintChanged) device.hwFingerprint = options.hwFingerprint;
  return { success: true, device, fingerprintChanged };
}

export function revokeDevice(deviceId: string): boolean {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM devices WHERE id = ? AND status = 'active'").get(deviceId) as any;
  if (!row) return false;

  const now = new Date().toISOString();
  db.prepare("UPDATE devices SET status = 'revoked', revoked_at = ?, revoke_reason = 'admin' WHERE id = ?").run(now, deviceId);
  logAuthEvent({ eventType: "revoke", deviceId, reason: "admin" });
  log.info("Device revoked", { deviceId, label: row.label });
  return true;
}

export function listDevices(): RegisteredDevice[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM devices ORDER BY registered_at DESC").all() as any[];
  return rows.map(rowToDevice);
}

export function getDevice(deviceId: string): RegisteredDevice | undefined {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as any;
  return row ? rowToDevice(row) : undefined;
}

export function getActiveDeviceCount(): number {
  const db = getDatabase();
  return (db.prepare("SELECT COUNT(*) as cnt FROM devices WHERE status = 'active'").get() as any)?.cnt || 0;
}

export function hasAnyDevices(): boolean {
  const db = getDatabase();
  return ((db.prepare("SELECT COUNT(*) as cnt FROM devices").get() as any)?.cnt || 0) > 0;
}

export function isDeviceAdmin(deviceId: string): boolean {
  const db = getDatabase();
  const row = db.prepare("SELECT is_admin FROM devices WHERE id = ?").get(deviceId) as any;
  return !!row?.is_admin;
}

/**
 * Un-revoke a device and update its fingerprint.
 * Used for admin recovery when a device was revoked due to
 * fingerprint mismatch (e.g., code update changed hash computation).
 */
export function unrevokeDevice(deviceId: string, newFingerprint?: string): boolean {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM devices WHERE id = ? AND status = 'revoked'").get(deviceId) as any;
  if (!row) return false;

  if (newFingerprint) {
    db.prepare(
      "UPDATE devices SET status = 'active', revoked_at = NULL, revoke_reason = NULL, hw_fingerprint = ? WHERE id = ?"
    ).run(newFingerprint, deviceId);
  } else {
    db.prepare(
      "UPDATE devices SET status = 'active', revoked_at = NULL, revoke_reason = NULL WHERE id = ?"
    ).run(deviceId);
  }
  logAuthEvent({ eventType: "register", deviceId, reason: "unrevoked_by_admin" });
  log.info("Device un-revoked", { deviceId, label: row.label, fingerprintUpdated: !!newFingerprint });
  return true;
}
