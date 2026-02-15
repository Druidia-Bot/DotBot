/**
 * DotBot Local Agent — Entry Point
 *
 * Thin startup orchestrator. All logic lives in core/ and handler modules:
 *
 *   core/env.ts             — ~/.bot/.env loading
 *   core/config.ts          — Server URL, device constants, credentials
 *   core/ws-client.ts       — WebSocket connection, send/receive, reconnect
 *   core/auth.ts            — Device authentication / registration
 *   core/message-router.ts  — Message dispatch (thin switch)
 *   core/post-auth-init.ts  — Post-auth subsystem wiring (periodic, Discord, hooks)
 *   core/run-log.ts         — Execution trace persistence
 *   core/restart-queue.ts   — Pre-restart prompt preservation
 *   core/cli.ts             — Interactive terminal prompt
 *
 *   handlers/memory-handlers.ts    — memory + skill requests
 *   handlers/discovery-handlers.ts — persona, council, knowledge
 *   handlers/resource-handlers.ts  — execution, schema, threads, assets
 */

import * as memory from "./memory/index.js";
import { loadBotEnv } from "./core/env.js";
import { SERVER_URL, DEVICE_NAME, deviceCredentials } from "./core/config.js";
import { initWsClient, connect, startKeepalivePing, send } from "./core/ws-client.js";
import { authenticate } from "./core/auth.js";
import { handleMessage, setPendingFormatFixes } from "./core/message-router.js";
import { initCli, promptUser } from "./core/cli.js";
import { initToolRegistry } from "./tools/registry.js";
import { stopPeriodicManager } from "./periodic/index.js";
import { stopHeartbeat } from "./heartbeat/heartbeat.js";
import { stopSleepCycle } from "./memory/sleep-cycle.js";
import { stopDiscordAdapter } from "./discord/adapter.js";

// ============================================
// LOAD ~/.bot/.env BEFORE anything reads process.env
// ============================================

loadBotEnv();

// ============================================
// STARTUP
// ============================================

async function startup(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🖥️  DotBot Local Agent                              ║
║                                                       ║
║   Your PC, Cloud-powered intelligence.                ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝

Device: ${DEVICE_NAME}
ID: ${deviceCredentials?.deviceId ?? "unregistered"}
Server: ${SERVER_URL}
`);

  // Initialize CLI (readline) early — needed for validation prompts
  const rl = await initCli();

  // Initialize local memory store
  console.log("[Agent] Initializing local memory store...");
  try {
    await memory.initializeMemoryStore();
    console.log("[Agent] Memory store ready.");

    // Bootstrap default council + personas (Skill Building Team)
    await memory.bootstrapInitialData();

    // Bootstrap agent identity (me.json) if it doesn't exist, then reconcile paths
    await memory.bootstrapIdentity();
    await memory.reconcileIdentityPaths();

    // Probe local LLM (non-blocking — just checks if model is downloaded)
    try {
      const { probeLocalModel } = await import("./llm/local-llm.js");
      await probeLocalModel();
    } catch (err) {
      console.log("[Agent] Local LLM probe skipped:", err instanceof Error ? err.message : err);
    }

    // Bootstrap knowledge files for personas that have them
    const { knowledgeCreated } = await memory.bootstrapDefaults();
    if (knowledgeCreated > 0) {
      console.log(`[Agent] Created ${knowledgeCreated} knowledge documents in ~/.bot/`);
    }

    // Bootstrap default skills (SKILL.md directories)
    const skillsCreated = await memory.bootstrapDefaultSkills();
    if (skillsCreated > 0) {
      console.log(`[Agent] Created ${skillsCreated} default skills in ~/.bot/skills/`);
    }

    // Validate all persona + council files and rebuild indexes from disk
    const validationResult = await memory.runStartupValidation();
    memory.printValidationReport(validationResult);

    // If malformed files found, ask user whether to attempt AI correction
    if (validationResult.malformedFiles.length > 0) {
      const answer = await new Promise<string>(resolve => {
        rl.question(
          `\nWould you like AI to attempt to correct ${validationResult.malformedFiles.length} malformed file(s) after connecting? (y/n): `,
          resolve
        );
      });
      if (answer.toLowerCase().startsWith("y")) {
        setPendingFormatFixes(validationResult.malformedFiles);
        console.log("[Validator] Will attempt AI correction after server connection.");
      } else {
        console.log("[Validator] Malformed files were left out. Fix them manually and restart.");
      }
    }

    // Initialize tool registry
    console.log("[Agent] Initializing tool registry...");
    await initToolRegistry();

    // Ensure Playwright Chromium is installed (auto-downloads if missing)
    try {
      const { ensurePlaywrightBrowser } = await import("./tools/gui/ensure-browser.js");
      await ensurePlaywrightBrowser();
    } catch (err) {
      console.log("[Agent] Playwright browser check skipped:", err instanceof Error ? err.message : err);
    }

    // Tesseract OCR: NOT installed at startup. If DotBot needs OCR (Tier 2/3)
    // and Tesseract isn't found, the tool returns a clear error. DotBot can then
    // install it herself using shell.powershell — she has full computer access.
  } catch (error) {
    console.error("[Agent] Failed to initialize memory store:", error);
    console.log("[Agent] Continuing without persistent memory.");
  }

  console.log(`
Commands:
  - Type anything to send to the AI
  - 'status' - Check connection status  
  - 'memory' - View memory status
  - 'quit' - Exit the agent
`);

  // Wire up WebSocket client
  initWsClient({
    onMessage: handleMessage,
    onConnected: () => authenticate(send),
  });
  connect();
  startKeepalivePing();

  // Clean shutdown: stop background systems + kill Python daemon on exit
  const cleanup = () => {
    stopPeriodicManager();
    stopHeartbeat();
    stopSleepCycle();
    stopDiscordAdapter();
    import("./tools/gui/python-bridge.js")
      .then(({ shutdownDaemon }) => shutdownDaemon())
      .catch(() => {});
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  // Wait for connection before showing prompt
  setTimeout(() => {
    promptUser();
  }, 1000);
}

startup();
