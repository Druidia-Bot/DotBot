/**
 * DotBot Server — Main Entry Point
 *
 * Slim bootstrap: loads config, creates app, mounts routes, starts servers.
 * Business logic lives in route files and the pipeline.
 */

// Config must be imported first — it loads .env and registers API keys
import { PORT, WS_PORT, PUBLIC_URL, LLM_PROVIDER, LLM_API_KEY } from "./config.js";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { initWSServer, createWSServer } from "./ws/server.js";
import * as memory from "./memory/manager.js";
import { initBotEnvironment } from "./init.js";
import { initKnowledgeService } from "./knowledge/index.js";
import {
  startScheduler,
  stopScheduler,
  onSchedulerEvent,
  startRecurringScheduler,
  stopRecurringScheduler,
  onRecurringEvent,
  pruneOldCancelledTasks,
} from "./scheduler/index.js";
import { stopWorkspaceCleanup } from "./agents/workspace.js";
import { initDatabase } from "./db/index.js";

// Route registrations
import { registerIngestUploadRoute } from "./knowledge/upload-handler.js";
import { registerScreenshotRoute } from "./gui/screenshot-store.js";
import { registerAuthMiddleware, registerAuthRoutes } from "./routes/auth.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerSchedulerRoutes } from "./routes/scheduler.js";

// ============================================
// INIT
// ============================================

initDatabase();
initBotEnvironment();

// ============================================
// HTTP APP
// ============================================

const app = new Hono();
app.use("*", cors());

// Mount routes
registerAuthMiddleware(app);
registerIngestUploadRoute(app);
registerScreenshotRoute(app);
registerAuthRoutes(app, { publicUrl: PUBLIC_URL, wsPort: String(WS_PORT) });
registerApiRoutes(app, { llmProvider: LLM_PROVIDER, llmApiKey: LLM_API_KEY });
registerSchedulerRoutes(app);

// ============================================
// STARTUP
// ============================================

console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   ☁️  DotBot Server                                ║
║                                                       ║
║   Think in the cloud. Act locally.                    ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
`);

// Start HTTP server
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`📡 HTTP API running on http://localhost:${PORT}`);
});

// Initialize WebSocket server components (personas, database)
initWSServer();

// Start WebSocket server
createWSServer({ port: WS_PORT, apiKey: LLM_API_KEY, provider: LLM_PROVIDER, httpBaseUrl: PUBLIC_URL });
console.log(`🔌 WebSocket server running on ws://localhost:${WS_PORT}`);

// Initialize knowledge service (must be after WebSocket server)
initKnowledgeService();

// Start task schedulers
startScheduler();
onSchedulerEvent((event) => {
  console.log(`[Scheduler] ${event.type}: ${event.taskId}`);
});

startRecurringScheduler();
onRecurringEvent((event) => {
  console.log(`[Recurring] ${event.type}: ${event.taskName} (${event.taskId})`);
});
pruneOldCancelledTasks();

// Start memory cache cleanup (LRU + TTL eviction)
memory.startMemoryCleanup();
console.log("🧹 Memory cleanup started (LRU: 100 threads/user, TTL: 7 days)");

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

const shutdown = async () => {
  await stopScheduler();
  await stopRecurringScheduler();
  stopWorkspaceCleanup();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`
Ready for connections!

Test with:
  curl -X POST http://localhost:${PORT}/api/test/prompt \\
    -H "Content-Type: application/json" \\
    -d '{"prompt": "What can you help me with?"}'
`);
