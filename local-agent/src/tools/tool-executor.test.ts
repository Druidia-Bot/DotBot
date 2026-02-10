/**
 * Tool Executor Tests — Security Blocklist
 * 
 * Tests the sensitive file blocklist that prevents LLM/tools
 * from reading device credentials, vault, .env files, etc.
 */

import { describe, it, expect } from "vitest";
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
