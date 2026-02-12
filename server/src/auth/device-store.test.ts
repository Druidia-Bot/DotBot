/**
 * Device Store Tests
 * 
 * Uses in-memory SQLite — no filesystem mocks needed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  registerDevice,
  authenticateDevice,
  revokeDevice,
  listDevices,
  getDevice,
  getActiveDeviceCount,
  hasAnyDevices,
  isDeviceAdmin,
  logAuthEvent,
  getRecentFailures,
} from "./device-store.js";

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
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      hw_fingerprint TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      is_admin INTEGER DEFAULT 0,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_auth_at DATETIME,
      last_ip TEXT,
      revoked_at DATETIME,
      revoke_reason TEXT
    );
    CREATE TABLE auth_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      device_id TEXT,
      ip TEXT,
      reason TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

describe("device-store", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  describe("registerDevice", () => {
    it("creates a device with dev_ prefix", () => {
      const { deviceId, deviceSecret } = registerDevice({
        label: "Test PC",
        hwFingerprint: "abc123",
        ip: "127.0.0.1",
      });
      expect(deviceId).toMatch(/^dev_[a-f0-9]{16}$/);
      expect(deviceSecret).toBeTruthy();
      expect(deviceSecret.length).toBeGreaterThan(20);
    });

    it("stores the secret as a hash, not plaintext", () => {
      const { deviceId, deviceSecret } = registerDevice({
        label: "Test PC",
        hwFingerprint: "abc123",
        ip: "127.0.0.1",
      });
      const device = getDevice(deviceId)!;
      expect(device.secretHash).not.toBe(deviceSecret);
      expect(device.secretHash).toHaveLength(64); // SHA-256 hex
    });

    it("first registered device is admin", () => {
      const { deviceId } = registerDevice({
        label: "First PC",
        hwFingerprint: "abc123",
        ip: "127.0.0.1",
      });
      expect(isDeviceAdmin(deviceId)).toBe(true);
    });

    it("second registered device is not admin", () => {
      registerDevice({ label: "First", hwFingerprint: "abc", ip: "1.1.1.1" });
      const { deviceId: secondId } = registerDevice({ label: "Second", hwFingerprint: "def", ip: "2.2.2.2" });
      expect(isDeviceAdmin(secondId)).toBe(false);
    });

    it("SEC-05: does NOT auto-promote after admin is revoked", () => {
      const { deviceId: adminId } = registerDevice({ label: "Admin PC", hwFingerprint: "fp1", ip: "1.1.1.1" });
      expect(isDeviceAdmin(adminId)).toBe(true);

      revokeDevice(adminId);
      expect(getActiveDeviceCount()).toBe(0);

      const { deviceId: newId } = registerDevice({ label: "Attacker PC", hwFingerprint: "fp_evil", ip: "6.6.6.6" });
      expect(isDeviceAdmin(newId)).toBe(false);
    });

    it("stores hardware fingerprint and metadata", () => {
      const { deviceId } = registerDevice({
        label: "Wallace Desktop",
        hwFingerprint: "fingerprint123",
        ip: "192.168.1.100",
      });
      const device = getDevice(deviceId)!;
      expect(device.hwFingerprint).toBe("fingerprint123");
      expect(device.label).toBe("Wallace Desktop");
      expect(device.lastSeenIp).toBe("192.168.1.100");
      expect(device.status).toBe("active");
    });

    it("logs a register auth event", () => {
      registerDevice({ label: "Test PC", hwFingerprint: "abc123", ip: "127.0.0.1" });
      const events = testDb.prepare("SELECT * FROM auth_events WHERE event_type = 'register'").all() as any[];
      expect(events).toHaveLength(1);
    });
  });

  describe("authenticateDevice", () => {
    it("authenticates with valid credentials and matching fingerprint", () => {
      const { deviceId, deviceSecret } = registerDevice({
        label: "Test PC",
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });

      const result = authenticateDevice({
        deviceId,
        deviceSecret,
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });
      expect(result.success).toBe(true);
      expect(result.device).toBeDefined();
      expect(result.device!.label).toBe("Test PC");
    });

    it("rejects unknown device ID", () => {
      const result = authenticateDevice({
        deviceId: "dev_nonexistent",
        deviceSecret: "anything",
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });
      expect(result.success).toBe(false);
      expect(result.reason).toBe("unknown_device");
    });

    it("rejects wrong secret", () => {
      const { deviceId } = registerDevice({
        label: "Test PC",
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });

      const result = authenticateDevice({
        deviceId,
        deviceSecret: "wrong_secret",
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });
      expect(result.success).toBe(false);
      expect(result.reason).toBe("invalid_credentials");
    });

    it("allows auth on fingerprint mismatch but flags the change", () => {
      const { deviceId, deviceSecret } = registerDevice({
        label: "Test PC",
        hwFingerprint: "original_fp",
        ip: "127.0.0.1",
      });

      const result = authenticateDevice({
        deviceId,
        deviceSecret,
        hwFingerprint: "different_machine_fp",
        ip: "666.666.666.666",
      });
      expect(result.success).toBe(true);
      expect(result.fingerprintChanged).toBe(true);

      // Device should still be active with updated fingerprint
      const device = getDevice(deviceId)!;
      expect(device.status).toBe("active");
      expect(device.hwFingerprint).toBe("different_machine_fp");
    });

    it("rejects revoked device even with correct credentials", () => {
      const { deviceId, deviceSecret } = registerDevice({
        label: "Test PC",
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });
      revokeDevice(deviceId);

      const result = authenticateDevice({
        deviceId,
        deviceSecret,
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });
      expect(result.success).toBe(false);
      expect(result.reason).toBe("device_revoked");
    });

    it("updates lastSeenAt and lastSeenIp on success", () => {
      const { deviceId, deviceSecret } = registerDevice({
        label: "Test PC",
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });

      authenticateDevice({
        deviceId,
        deviceSecret,
        hwFingerprint: "fp123",
        ip: "10.0.0.50",
      });

      const device = getDevice(deviceId)!;
      expect(device.lastSeenIp).toBe("10.0.0.50");
    });

    it("logs auth events for successes and failures", () => {
      const { deviceId, deviceSecret } = registerDevice({
        label: "Test PC",
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });
      authenticateDevice({ deviceId, deviceSecret, hwFingerprint: "fp123", ip: "127.0.0.1" });
      authenticateDevice({ deviceId, deviceSecret: "wrong", hwFingerprint: "fp123", ip: "127.0.0.1" });

      const successes = testDb.prepare("SELECT * FROM auth_events WHERE event_type = 'auth_success'").all();
      const failures = testDb.prepare("SELECT * FROM auth_events WHERE event_type = 'auth_failure'").all();
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
    });
  });

  describe("revokeDevice", () => {
    it("revokes an active device", () => {
      const { deviceId } = registerDevice({
        label: "Test PC",
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });
      const result = revokeDevice(deviceId);
      expect(result).toBe(true);
      expect(getDevice(deviceId)!.status).toBe("revoked");
    });

    it("returns false for already-revoked device", () => {
      const { deviceId } = registerDevice({
        label: "Test PC",
        hwFingerprint: "fp123",
        ip: "127.0.0.1",
      });
      revokeDevice(deviceId);
      expect(revokeDevice(deviceId)).toBe(false);
    });

    it("returns false for nonexistent device", () => {
      expect(revokeDevice("dev_nonexistent")).toBe(false);
    });
  });

  describe("utility functions", () => {
    it("getActiveDeviceCount returns count of active devices", () => {
      registerDevice({ label: "PC1", hwFingerprint: "fp1", ip: "1.1.1.1" });
      registerDevice({ label: "PC2", hwFingerprint: "fp2", ip: "2.2.2.2" });
      expect(getActiveDeviceCount()).toBe(2);
    });

    it("hasAnyDevices returns false for empty store", () => {
      expect(hasAnyDevices()).toBe(false);
    });

    it("hasAnyDevices returns true when devices exist", () => {
      registerDevice({ label: "PC1", hwFingerprint: "fp1", ip: "1.1.1.1" });
      expect(hasAnyDevices()).toBe(true);
    });

    it("listDevices returns all devices", () => {
      registerDevice({ label: "PC1", hwFingerprint: "fp1", ip: "1.1.1.1" });
      registerDevice({ label: "PC2", hwFingerprint: "fp2", ip: "2.2.2.2" });
      expect(listDevices()).toHaveLength(2);
    });
  });

  describe("getRecentFailures", () => {
    it("counts recent auth failures by IP", () => {
      logAuthEvent({ eventType: "auth_failure", ip: "1.2.3.4", reason: "bad_creds" });
      logAuthEvent({ eventType: "auth_failure", ip: "1.2.3.4", reason: "bad_creds" });
      logAuthEvent({ eventType: "auth_failure", ip: "5.6.7.8", reason: "bad_creds" });
      expect(getRecentFailures("1.2.3.4")).toBe(2);
      expect(getRecentFailures("5.6.7.8")).toBe(1);
      expect(getRecentFailures("9.9.9.9")).toBe(0);
    });
  });
});
