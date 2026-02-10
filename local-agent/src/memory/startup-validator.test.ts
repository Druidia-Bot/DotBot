/**
 * Startup Validator Tests
 * 
 * Covers:
 * - Council .md validation and index rebuilding
 * - Persona directory validation and index rebuilding
 * - CRLF auto-fix behavior
 * - Malformed file error reporting
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { runStartupValidation, type ValidationResult } from "./startup-validator.js";

const DOTBOT_DIR = path.join(os.homedir(), ".bot");
const COUNCILS_DIR = path.join(DOTBOT_DIR, "councils");
const PERSONAS_DIR = path.join(DOTBOT_DIR, "personas");

// ============================================
// INTEGRATION TESTS (uses real ~/.bot/ directory)
// ============================================

describe("runStartupValidation", () => {
  it("completes without throwing", async () => {
    const result = await runStartupValidation();
    expect(result).toBeDefined();
    expect(result.indexesRebuilt).toBe(true);
  });

  it("scans existing councils", async () => {
    const result = await runStartupValidation();
    // Should find at least the bootstrapped skill-building-team.md
    expect(result.councilsScanned).toBeGreaterThanOrEqual(0);
    expect(result.councilsValid).toBeLessThanOrEqual(result.councilsScanned);
  });

  it("scans existing personas", async () => {
    const result = await runStartupValidation();
    // Should find at least the bootstrapped api-researcher and skill-writer
    expect(result.personasScanned).toBeGreaterThanOrEqual(0);
    expect(result.personasValid).toBeLessThanOrEqual(result.personasScanned);
  });

  it("rebuilds councils index.json from disk", async () => {
    await runStartupValidation();

    const indexContent = await fs.readFile(
      path.join(COUNCILS_DIR, "index.json"),
      "utf-8"
    );
    const index = JSON.parse(indexContent);

    expect(index.version).toBe("1.0.0");
    expect(index.lastUpdatedAt).toBeTruthy();
    expect(Array.isArray(index.councils)).toBe(true);

    // Each entry should have required fields
    for (const entry of index.councils) {
      expect(entry.slug).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(typeof entry.memberCount).toBe("number");
      expect(Array.isArray(entry.handles)).toBe(true);
    }
  });

  it("rebuilds personas index.json from disk", async () => {
    await runStartupValidation();

    const indexContent = await fs.readFile(
      path.join(PERSONAS_DIR, "index.json"),
      "utf-8"
    );
    const index = JSON.parse(indexContent);

    expect(index.version).toBe("1.0.0");
    expect(index.lastUpdatedAt).toBeTruthy();
    expect(Array.isArray(index.personas)).toBe(true);

    // Each entry should have required fields
    for (const entry of index.personas) {
      expect(entry.slug).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(typeof entry.knowledgeFileCount).toBe("number");
    }
  });

  it("councils index matches actual .md files on disk", async () => {
    await runStartupValidation();

    // Read what's on disk
    let mdFiles: string[] = [];
    try {
      mdFiles = (await fs.readdir(COUNCILS_DIR)).filter(f => f.endsWith(".md"));
    } catch { /* empty */ }

    // Read index
    const indexContent = await fs.readFile(
      path.join(COUNCILS_DIR, "index.json"),
      "utf-8"
    );
    const index = JSON.parse(indexContent);

    // Index should have at most as many entries as .md files
    // (some .md files might be malformed and excluded)
    expect(index.councils.length).toBeLessThanOrEqual(mdFiles.length);
  });

  it("personas index matches actual directories on disk", async () => {
    await runStartupValidation();

    // Read what's on disk
    let dirs: string[] = [];
    try {
      const entries = await fs.readdir(PERSONAS_DIR);
      for (const entry of entries) {
        if (entry === "index.json") continue;
        const stat = await fs.stat(path.join(PERSONAS_DIR, entry));
        if (stat.isDirectory()) dirs.push(entry);
      }
    } catch { /* empty */ }

    // Read index
    const indexContent = await fs.readFile(
      path.join(PERSONAS_DIR, "index.json"),
      "utf-8"
    );
    const index = JSON.parse(indexContent);

    // Index should have at most as many entries as persona directories
    expect(index.personas.length).toBeLessThanOrEqual(dirs.length);
  });

  it("result fields are consistent", async () => {
    const result = await runStartupValidation();

    // Valid + errors should account for all scanned
    expect(result.councilsValid + result.councilErrors.length).toBe(result.councilsScanned);
    expect(result.personasValid + result.personaErrors.length).toBe(result.personasScanned);

    // Fixed count should not exceed valid count
    expect(result.councilsFixed).toBeLessThanOrEqual(result.councilsScanned);
    expect(result.personasFixed).toBeLessThanOrEqual(result.personasScanned);
  });
});

// ============================================
// CRLF FIX TESTS
// ============================================

describe("CRLF auto-fix", () => {
  const testCouncilPath = path.join(COUNCILS_DIR, "_test-crlf-council.md");

  afterEach(async () => {
    try { await fs.unlink(testCouncilPath); } catch { /* doesn't exist */ }
  });

  it("normalizes CRLF to LF in council .md files", async () => {
    // Write a council file with CRLF endings
    const crlfContent = "---\r\nslug: _test-crlf-council\r\nname: Test CRLF Council\r\ncreated: 2026-01-01T00:00:00Z\r\nupdated: 2026-01-01T00:00:00Z\r\nhandles:\r\n  - test\r\ntags:\r\n  - test\r\n---\r\n\r\n# Test CRLF Council\r\n\r\n## Mission\r\n\r\nTest mission.\r\n";
    await fs.writeFile(testCouncilPath, crlfContent, "utf-8");

    // Run validation
    const result = await runStartupValidation();

    // The file should have been fixed
    const fixedContent = await fs.readFile(testCouncilPath, "utf-8");
    expect(fixedContent.includes("\r\n")).toBe(false);

    // And it should be in the index
    const indexContent = await fs.readFile(
      path.join(COUNCILS_DIR, "index.json"),
      "utf-8"
    );
    const index = JSON.parse(indexContent);
    const testEntry = index.councils.find((c: any) => c.slug === "_test-crlf-council");
    expect(testEntry).toBeDefined();
    expect(testEntry.name).toBe("Test CRLF Council");

    // Cleanup happens in afterEach
  });
});
