/**
 * Tool Executor Tests — Security Blocklist
 * 
 * Tests the sensitive file blocklist that prevents LLM/tools
 * from reading device credentials, vault, .env files, etc.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { isAllowedRead, isAllowedWrite } from "./tool-executor.js";
import { homedir } from "os";
import { join } from "path";

const HOME = homedir();

describe("isAllowedRead — sensitive file blocklist", () => {
  it("blocks ~/.bot/device.json", () => {
    expect(isAllowedRead("~/.bot/device.json")).toBe(false);
    expect(isAllowedRead(join(HOME, ".bot", "device.json"))).toBe(false);
  });

  it("blocks ~/.bot/vault.json", () => {
    expect(isAllowedRead("~/.bot/vault.json")).toBe(false);
    expect(isAllowedRead(join(HOME, ".bot", "vault.json"))).toBe(false);
  });

  it("blocks ~/.bot/server-data/ directory", () => {
    expect(isAllowedRead("~/.bot/server-data/invite-tokens.json")).toBe(false);
    expect(isAllowedRead("~/.bot/server-data/devices.json")).toBe(false);
  });

  it("blocks .env files anywhere", () => {
    expect(isAllowedRead("~/.bot/.env")).toBe(false);
    expect(isAllowedRead(join(HOME, "DotBot", ".env"))).toBe(false);
  });

  it("blocks master.key", () => {
    expect(isAllowedRead("~/.bot/server-data/master.key")).toBe(false);
  });

  it("allows normal files in ~/.bot/", () => {
    expect(isAllowedRead("~/.bot/memory/index.json")).toBe(true);
    expect(isAllowedRead("~/.bot/HEARTBEAT.md")).toBe(true);
    expect(isAllowedRead("~/.bot/reminders.json")).toBe(true);
  });

  it("allows reading files in user home", () => {
    expect(isAllowedRead(join(HOME, "Desktop", "readme.txt"))).toBe(true);
    expect(isAllowedRead("~/Documents/notes.md")).toBe(true);
  });

  it("allows reading project source files", () => {
    expect(isAllowedRead(join(HOME, "projects", "myapp", "src", "index.ts"))).toBe(true);
  });
});

describe("isAllowedWrite — sensitive file blocklist", () => {
  it("blocks writing to ~/.bot/device.json", () => {
    expect(isAllowedWrite("~/.bot/device.json")).toBe(false);
    expect(isAllowedWrite(join(HOME, ".bot", "device.json"))).toBe(false);
  });

  it("blocks writing to ~/.bot/vault.json", () => {
    expect(isAllowedWrite("~/.bot/vault.json")).toBe(false);
  });

  it("blocks writing to ~/.bot/server-data/", () => {
    expect(isAllowedWrite("~/.bot/server-data/devices.json")).toBe(false);
    expect(isAllowedWrite("~/.bot/server-data/invite-tokens.json")).toBe(false);
  });

  it("blocks writing to .env files", () => {
    expect(isAllowedWrite("~/.bot/.env")).toBe(false);
    expect(isAllowedWrite(join(HOME, "DotBot", ".env"))).toBe(false);
  });

  it("blocks writing to master.key", () => {
    expect(isAllowedWrite("~/.bot/server-data/master.key")).toBe(false);
  });

  it("allows writing normal files", () => {
    expect(isAllowedWrite(join(HOME, "Desktop", "test.txt"))).toBe(true);
    expect(isAllowedWrite("~/.bot/memory/index.json")).toBe(true);
    expect(isAllowedWrite("~/.bot/reminders.json")).toBe(true);
  });
});

// ============================================
// SEC-04: Dangerous PowerShell Command Blocklist
// ============================================

describe("SEC-04 — dangerous PowerShell command blocklist", () => {
  // The pattern matcher is internal, so we test it indirectly via executeTool.
  // Dangerous commands are blocked before spawning a PowerShell process.

  let executeTool: (toolId: string, args: Record<string, any>) => Promise<any>;

  beforeAll(async () => {
    const mod = await import("./tool-executor.js");
    executeTool = mod.executeTool;
  });

  it("blocks Format-Volume", async () => {
    const result = await executeTool("shell.powershell", { command: "Format-Volume -DriveLetter D -FileSystem NTFS" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("disk formatting");
  });

  it("blocks Format-Disk", async () => {
    const result = await executeTool("shell.powershell", { command: "Format-Disk -Number 1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("disk formatting");
  });

  it("blocks Clear-Disk", async () => {
    const result = await executeTool("shell.powershell", { command: "Clear-Disk -Number 0 -RemoveData" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("disk wiping");
  });

  it("blocks bcdedit", async () => {
    const result = await executeTool("shell.powershell", { command: "bcdedit /set safeboot minimal" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("boot configuration");
  });

  it("blocks recursive deletion of C:\\Windows", async () => {
    const result = await executeTool("shell.powershell", { command: "Remove-Item C:\\Windows\\Temp -Recurse -Force" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("recursive deletion");
  });

  it("blocks Stop-Computer", async () => {
    const result = await executeTool("shell.powershell", { command: "Stop-Computer -Force" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("computer shutdown");
  });

  it("blocks Restart-Computer", async () => {
    const result = await executeTool("shell.powershell", { command: "Restart-Computer" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("computer restart");
  });

  it("blocks Set-ExecutionPolicy Unrestricted", async () => {
    const result = await executeTool("shell.powershell", { command: "Set-ExecutionPolicy Unrestricted -Force" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("execution policy");
  });

  it("blocks Disable-NetAdapter", async () => {
    const result = await executeTool("shell.powershell", { command: "Disable-NetAdapter -Name 'Ethernet'" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("network adapter");
  });

  it("blocks registry hive manipulation", async () => {
    const result = await executeTool("shell.powershell", { command: "reg delete HKLM\\SYSTEM\\CurrentControlSet" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("registry hive");
  });
});
