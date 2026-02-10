/**
 * Hardware Fingerprint Collector
 * 
 * Collects hardware identifiers and hashes them into a single fingerprint.
 * Used to bind device credentials to the physical machine — if the fingerprint
 * changes (OS reinstall, hardware swap), auth is rejected and the device is revoked.
 * 
 * Signals:
 * - Motherboard serial (survives OS reinstall)
 * - CPU ID (survives everything short of CPU swap)
 * - Primary disk serial (changes if drive replaced)
 * - Windows Machine GUID (changes on OS reinstall — the tripwire)
 * - BIOS serial (burned into firmware)
 */

import { createHash } from "crypto";
import { execSync } from "child_process";

const TIMEOUT_MS = 5000;

const WMIC_NOISE = new Set([
  "serialnumber", "processorid", "machineguid",
  "caption", "description", "name", "status",
]);

function run(cmd: string): string {
  try {
    const raw = execSync(cmd, { encoding: "utf8", timeout: TIMEOUT_MS, windowsHide: true });
    const lines = raw
      .trim()
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => {
        if (l.length === 0) return false;
        if (WMIC_NOISE.has(l.toLowerCase())) return false;
        // Filter reg query metadata lines
        if (l.startsWith("HKEY_")) return false;
        if (l === "REG_SZ") return false;
        // Extract just the value from "MachineGuid    REG_SZ    <value>" lines
        const regMatch = l.match(/REG_SZ\s+(.+)/);
        if (regMatch) return true; // keep — will be cleaned below
        return true;
      })
      .map(l => {
        // Clean reg query output: "MachineGuid    REG_SZ    <value>" → just <value>
        const regMatch = l.match(/REG_SZ\s+(.+)/);
        if (regMatch) return regMatch[1].trim();
        return l;
      });
    return lines.join("|") || "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

function collectWindowsSignals(): string[] {
  return [
    run("wmic baseboard get serialnumber"),
    run("wmic cpu get processorid"),
    run("wmic diskdrive get serialnumber"),
    run('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid'),
    run("wmic bios get serialnumber"),
  ];
}

function collectLinuxSignals(): string[] {
  return [
    run("cat /sys/class/dmi/id/board_serial 2>/dev/null || echo UNAVAILABLE"),
    run("grep -m1 'model name' /proc/cpuinfo 2>/dev/null || echo UNAVAILABLE"),
    run("lsblk -no SERIAL /dev/sda 2>/dev/null || echo UNAVAILABLE"),
    run("cat /etc/machine-id 2>/dev/null || echo UNAVAILABLE"),
    run("cat /sys/class/dmi/id/product_uuid 2>/dev/null || echo UNAVAILABLE"),
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
