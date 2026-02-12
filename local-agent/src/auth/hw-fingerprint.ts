/**
 * Hardware Fingerprint Collector
 * 
 * Collects hardware identifiers and hashes them into a single fingerprint.
 * Used as a defense-in-depth monitoring signal for device authentication.
 * The device secret (256-bit) is the primary auth factor; this fingerprint
 * provides an audit trail when hardware changes.
 * 
 * Signals (Windows — via Get-CimInstance, not deprecated wmic):
 * - Motherboard serial (survives OS reinstall)
 * - CPU ID (survives everything short of CPU swap)
 * - Boot drive serial only (Index=0 — deterministic, ignores USB/secondary disks)
 * - Windows Machine GUID (changes on OS reinstall — the tripwire)
 * - BIOS serial (burned into firmware)
 * 
 * Signals (Linux — via /sys and /proc):
 * - Board serial, CPU model, /dev/sda serial, machine-id, product UUID
 */

import { createHash } from "crypto";
import { execSync } from "child_process";

const TIMEOUT_MS = 5000;

function runShell(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: TIMEOUT_MS, windowsHide: true }).trim() || "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

function runPS(script: string): string {
  try {
    const raw = execSync(
      `powershell -NoProfile -Command "${script}"`,
      { encoding: "utf8", timeout: TIMEOUT_MS, windowsHide: true },
    );
    return raw.trim() || "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

function collectWindowsSignals(): string[] {
  return [
    runPS("(Get-CimInstance Win32_BaseBoard).SerialNumber"),
    runPS("(Get-CimInstance Win32_Processor).ProcessorId"),
    runPS("(Get-CimInstance Win32_DiskDrive | Sort-Object Index | Select-Object -First 1).SerialNumber"),
    runPS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid"),
    runPS("(Get-CimInstance Win32_BIOS).SerialNumber"),
  ];
}

function collectLinuxSignals(): string[] {
  return [
    runShell("cat /sys/class/dmi/id/board_serial 2>/dev/null || echo UNAVAILABLE"),
    runShell("grep -m1 'model name' /proc/cpuinfo 2>/dev/null || echo UNAVAILABLE"),
    runShell("lsblk -no SERIAL /dev/sda 2>/dev/null || echo UNAVAILABLE"),
    runShell("cat /etc/machine-id 2>/dev/null || echo UNAVAILABLE"),
    runShell("cat /sys/class/dmi/id/product_uuid 2>/dev/null || echo UNAVAILABLE"),
  ];
}

export function collectHardwareFingerprint(): string {
  const signals = process.platform === "win32"
    ? collectWindowsSignals()
    : collectLinuxSignals();

  return createHash("sha256")
    .update(signals.join("|"))
    .digest("hex");
}
