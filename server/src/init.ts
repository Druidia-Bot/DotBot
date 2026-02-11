/**
 * Server Initialization
 * 
 * Creates required directories and default files in ~/.bot/
 * This runs on server startup to ensure the environment is properly configured.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomBytes } from "crypto";
import { createInviteToken, hasAnyTokens } from "./auth/invite-tokens.js";
import { hasAnyDevices } from "./auth/device-store.js";

// ============================================
// PATHS
// ============================================

const BOT_DIR = path.join(os.homedir(), ".bot");
const REQUIRED_DIRS = [
  "personas",
  "councils", 
  "memory",
  "server-data",
  "server-logs"
];

// ============================================
// INITIALIZATION
// ============================================

export function initBotEnvironment(): void {
  console.log("[Init] Checking ~/.bot/ environment...");
  
  // Create base directory
  if (!fs.existsSync(BOT_DIR)) {
    console.log("[Init] Creating ~/.bot/ directory");
    fs.mkdirSync(BOT_DIR, { recursive: true });
  }
  
  // Create required subdirectories
  for (const dir of REQUIRED_DIRS) {
    const dirPath = path.join(BOT_DIR, dir);
    if (!fs.existsSync(dirPath)) {
      console.log(`[Init] Creating ~/.bot/${dir}/`);
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
  
  // Check if personas exist, copy defaults if not
  const personasDir = path.join(BOT_DIR, "personas");
  const personaFiles = fs.readdirSync(personasDir).filter(f => f.endsWith(".md"));
  
  if (personaFiles.length === 0) {
    console.log("[Init] No user personas found - using server personas only");
    // User can add custom personas to ~/.bot/personas/ later
    // Server-side personas in server/src/personas/ are always loaded
  }
  
  // Check councils
  const councilsDir = path.join(BOT_DIR, "councils");
  const councilFiles = fs.readdirSync(councilsDir).filter(f => f.endsWith(".md"));
  
  if (councilFiles.length === 0) {
    console.log("[Init] No user councils found - using defaults");
    // Create a default council file
    const defaultCouncil = `---
id: general
name: General Council
description: Default council for general requests
personas:
  - writer
  - researcher
triggers:
  - help
  - question
  - explain
---

# General Council

The default council for handling general user requests.
`;
    fs.writeFileSync(path.join(councilsDir, "general.md"), defaultCouncil);
    console.log("[Init] Created default general.md council");
  }
  
  // Initialize memory index if it doesn't exist
  const memoryDir = path.join(BOT_DIR, "memory");
  const memoryIndex = path.join(memoryDir, "index.json");
  
  if (!fs.existsSync(memoryIndex)) {
    console.log("[Init] Creating memory index");
    fs.writeFileSync(memoryIndex, JSON.stringify({
      version: 1,
      threads: [],
      mentalModels: [],
      lastUpdated: new Date().toISOString()
    }, null, 2));
  }
  
  // First-boot: generate an invite token if no devices are registered yet
  if (!hasAnyDevices() && !hasAnyTokens()) {
    const { token, expiresAt } = createInviteToken({ label: "First boot token", expiryDays: 30 });
    console.log("\n╔═══════════════════════════════════════════════════════════════╗");
    console.log("║  🔑 FIRST BOOT — Invite Token Generated                      ║");
    console.log("║                                                               ║");
    console.log(`║     ${token}                                ║`);
    console.log("║                                                               ║");
    console.log(`║  Expires: ${expiresAt.substring(0, 10)}                                        ║`);
    console.log("║  Set DOTBOT_INVITE_TOKEN on the agent to register.            ║");
    console.log("╚═══════════════════════════════════════════════════════════════╝\n");
  }

  // Initialize web auth token for browser clients
  initWebAuthToken();

  console.log("[Init] Environment ready");
}

// ============================================
// WEB AUTH TOKEN
// ============================================

let webAuthToken: string | null = null;

function initWebAuthToken(): void {
  // Explicit env var takes priority
  if (process.env.WEB_AUTH_TOKEN) {
    webAuthToken = process.env.WEB_AUTH_TOKEN;
    console.log("[Init] Web auth token loaded from environment");
    return;
  }

  // Check for persisted token
  const tokenPath = path.join(BOT_DIR, "server-data", "web-auth-token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf-8").trim();
    if (existing) {
      webAuthToken = existing;
      console.log("[Init] Web auth token loaded from file");
      return;
    }
  } catch {
    // File doesn't exist yet
  }

  // Generate new token
  webAuthToken = randomBytes(24).toString("base64url");
  try {
    fs.writeFileSync(tokenPath, webAuthToken, "utf-8");
  } catch (err) {
    console.error("[Init] Could not save web auth token:", err);
  }

  console.log("");
  console.log("  ========================================");
  console.log("  Web Auth Token (for browser clients):");
  console.log("");
  console.log(`    ${webAuthToken}`);
  console.log("");
  console.log("  Save this token! Browser clients need it to connect.");
  console.log(`  Stored in: ${tokenPath}`);
  console.log("  ========================================");
  console.log("");
}

export function getWebAuthToken(): string | null {
  return webAuthToken;
}

/**
 * Get the bot directory path
 */
export function getBotDir(): string {
  return BOT_DIR;
}

/**
 * Get path to a specific subdirectory
 */
export function getBotPath(subdir: string): string {
  return path.join(BOT_DIR, subdir);
}
