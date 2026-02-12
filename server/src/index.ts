/**
 * DotBot Server - Main Entry Point
 * 
 * Starts the HTTP API and WebSocket servers.
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from project root (ESM compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../../.env") });
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createWSServer, getConnectedDevices } from "./ws/server.js";
import { createInviteToken } from "./auth/invite-tokens.js";
import * as memory from "./memory/manager.js";
import { initBotEnvironment } from "./init.js";
import { initKnowledgeService } from "./knowledge/index.js";
import { registerApiKeys } from "./llm/providers.js";
import { probeLocalModel, downloadLocalModel } from "./llm/local-llm.js";
import {
  startScheduler,
  stopScheduler,
  getUserTasks,
  cancelTask,
  getStats as getSchedulerStats,
  onSchedulerEvent,
  startRecurringScheduler,
  stopRecurringScheduler,
  setRecurringExecuteCallback,
  onRecurringEvent,
  listRecurringTasks,
  getRecurringTask,
  createRecurringTask,
  cancelRecurringTask,
  pauseRecurringTask,
  resumeRecurringTask,
  getRecurringStats,
  pruneOldCancelledTasks,
} from "./scheduler/index.js";
import { stopWorkspaceCleanup } from "./agents/workspace.js";

// Initialize ~/.bot/ environment first
initBotEnvironment();

// ============================================
// CONFIGURATION
// ============================================

const PORT = parseInt(process.env.PORT || "3000");
const WS_PORT = parseInt(process.env.WS_PORT || "3001");
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// INSTALL-01: Validate PUBLIC_URL in production
if (process.env.NODE_ENV === "production") {
  if (!process.env.PUBLIC_URL) {
    console.error("FATAL: PUBLIC_URL must be set in production (e.g. https://dotbot.yourdomain.com)");
    console.error("  Without it, QR codes, credential pages, and client links all point to localhost.");
    process.exit(1);
  }
  const publicHost = new URL(PUBLIC_URL).hostname;
  if (publicHost === "localhost" || publicHost === "127.0.0.1" || publicHost === "0.0.0.0") {
    console.error(`FATAL: PUBLIC_URL cannot be ${publicHost} in production (got ${PUBLIC_URL})`);
    console.error("  Set PUBLIC_URL to your server's public domain (e.g. https://dotbot.yourdomain.com)");
    process.exit(1);
  }
}

// LLM Provider Configuration (DeepSeek is default)
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";

// Determine which provider to use
let LLM_PROVIDER: "deepseek" | "anthropic" | "openai" | "gemini" = "deepseek";
let LLM_API_KEY = DEEPSEEK_API_KEY;

if (DEEPSEEK_API_KEY) {
  LLM_PROVIDER = "deepseek";
  LLM_API_KEY = DEEPSEEK_API_KEY;
} else if (ANTHROPIC_API_KEY) {
  LLM_PROVIDER = "anthropic";
  LLM_API_KEY = ANTHROPIC_API_KEY;
} else if (GEMINI_API_KEY) {
  LLM_PROVIDER = "gemini";
  LLM_API_KEY = GEMINI_API_KEY;
} else if (OPENAI_API_KEY) {
  LLM_PROVIDER = "openai";
  LLM_API_KEY = OPENAI_API_KEY;
} else {
  console.error("⚠️  No LLM API key set. Set one of:");
  console.error("   DEEPSEEK_API_KEY=your_key (recommended, default)");
  console.error("   ANTHROPIC_API_KEY=your_key");
  console.error("   GEMINI_API_KEY=your_key");
  console.error("   OPENAI_API_KEY=your_key");
  process.exit(1);
}

// Register ALL available API keys so the model selector can route to any provider.
// The primary provider (LLM_PROVIDER) is just the default — the selector will
// escalate to Gemini/Claude/local when task characteristics require it.
registerApiKeys({
  deepseek: DEEPSEEK_API_KEY,
  anthropic: ANTHROPIC_API_KEY,
  openai: OPENAI_API_KEY,
  gemini: GEMINI_API_KEY,
  xai: XAI_API_KEY,
});

const availableProviders = [
  DEEPSEEK_API_KEY && "DeepSeek V3.2 (workhorse)",
  GEMINI_API_KEY && "Gemini 3 Pro (deep context)",
  ANTHROPIC_API_KEY && "Claude Opus 4.6 (architect)",
  OPENAI_API_KEY && "OpenAI (fallback)",
  XAI_API_KEY && "xAI Grok 4.1 (oracle / deep_context fallback)",
  "Qwen 2.5 0.5B (local, node-llama-cpp)",
].filter(Boolean);

console.log(`🤖 Primary provider: ${LLM_PROVIDER.toUpperCase()}`);
console.log(`📋 Available models: ${availableProviders.join(", ")}`);

// Probe local LLM for offline fallback (non-blocking, non-fatal)
// Skip if cloud API keys are available — local model is only useful when offline
const hasCloudKeys = !!(DEEPSEEK_API_KEY || ANTHROPIC_API_KEY || OPENAI_API_KEY || GEMINI_API_KEY || XAI_API_KEY);
if (!hasCloudKeys) {
  (async () => {
    const probe = await probeLocalModel();
    if (probe.modelAvailable) {
      console.log(`🏠 Local LLM ready — ${probe.modelName}`);
    } else {
      console.log(`📥 Downloading ${probe.modelName} for offline fallback (~350 MB)...`);
      const ok = await downloadLocalModel();
      if (ok) console.log(`✅ ${probe.modelName} ready for offline use`);
      else console.log(`⚠️  Local model download failed — offline fallback unavailable`);
    }
  })().catch(err => console.error("Local LLM setup failed:", err));
}

// ============================================
// HTTP API
// ============================================

const app = new Hono();

// Middleware
app.use("*", cors());

// Knowledge ingest upload endpoint (multipart file upload — no files touch disk)
import { registerIngestUploadRoute } from "./knowledge/upload-handler.js";
registerIngestUploadRoute(app);

// Screenshot upload endpoint (binary POST — avoids base64 over WebSocket)
import { registerScreenshotRoute } from "./gui/screenshot-store.js";
registerScreenshotRoute(app);

// Credential entry routes (secure page for entering API keys)
import { registerCredentialRoutes } from "./credentials/routes.js";
import { initMasterKey } from "./credentials/crypto.js";
import { startSessionCleanup } from "./credentials/sessions.js";
initMasterKey();
startSessionCleanup();
registerCredentialRoutes(app);

// Invite page (public — serves install instructions for new users)
import { registerInviteRoutes } from "./auth/invite-page.js";
registerInviteRoutes(app, { publicUrl: PUBLIC_URL, wsPort: String(WS_PORT) });

// Health check
app.get("/", (c) => c.json({ 
  service: "DotBot Server",
  version: "0.1.0",
  status: "running"
}));

// Council configuration — councils are loaded from local agent, not server
app.get("/api/council/config", (c) => {
  return c.json({ message: "Councils are loaded from the local agent via WebSocket" });
});

// Get connected devices (live WebSocket sessions)
app.get("/api/devices", (c) => {
  return c.json(getConnectedDevices());
});

// ============================================
// ADMIN — via WebSocket only (see ws/admin-handler.ts)
// HTTP admin endpoints removed — all admin ops require authenticated WS connection.
// ============================================

// Get user memory (threads + mental models)
app.get("/api/memory/:userId", (c) => {
  const userId = c.req.param("userId");
  return c.json(memory.exportUserMemory(userId));
});

// Clear user memory
app.delete("/api/memory/:userId", (c) => {
  const userId = c.req.param("userId");
  memory.clearUserMemory(userId);
  return c.json({ success: true });
});

// Test prompt (HTTP endpoint for debugging) — uses AgentRunner with tool loop
app.post("/api/test/prompt", async (c) => {
  const body = await c.req.json();
  const { prompt, userId = "user_test" } = body;
  
  if (!prompt) {
    return c.json({ error: "prompt is required" }, 400);
  }

  const { AgentRunner } = await import("./agents/runner.js");
  const { getDeviceForUser } = await import("./ws/server.js");
  const { sendExecutionCommand } = await import("./ws/server.js");

  const chunks: { personaId: string; content: string }[] = [];
  const toolCalls: { tool: string; result: string; success: boolean }[] = [];

  const runner = new AgentRunner({
    apiKey: LLM_API_KEY,
    provider: LLM_PROVIDER as "deepseek" | "anthropic" | "openai",
    onStream: (personaId, chunk, done) => {
      if (chunk) {
        chunks.push({ personaId, content: chunk });
      }
    },
    onExecuteCommand: async (command) => {
      const agentDeviceId = getDeviceForUser(userId);
      if (!agentDeviceId) {
        throw new Error("No local-agent connected to execute commands");
      }
      return sendExecutionCommand(agentDeviceId, command);
    },
  });

  const result = await runner.run(
    {
      type: "prompt",
      prompt,
      recentHistory: [],
      activeThreadId: null,
      threadIndex: { threads: [] },
      matchedCouncils: [],
    },
    userId
  );

  return c.json({
    ...result,
    streamChunks: chunks,
  });
});

// Test knowledge loading for a persona
app.get("/api/test/knowledge/:personaSlug", async (c) => {
  const personaSlug = c.req.param("personaSlug");
  const query = c.req.query("q") || "";

  try {
    const { loadKnowledgeBase, queryKnowledge, injectRelevantKnowledge } = await import("./knowledge/index.js");
    const { getDeviceForUser } = await import("./ws/server.js");

    const deviceId = getDeviceForUser("user_demo");
    if (!deviceId) {
      return c.json({ error: "No device connected", personaSlug }, 503);
    }

    // Load knowledge base
    const knowledgeBase = await loadKnowledgeBase(personaSlug);

    if (query) {
      // Query knowledge with relevance scoring
      const results = await queryKnowledge({
        personaSlug,
        query,
        maxResults: 10,
        maxCharacters: 8000,
      });
      const injection = await injectRelevantKnowledge(personaSlug, query, {
        maxCharacters: 4000,
        format: "markdown"
      });

      return c.json({
        personaSlug,
        query,
        totalDocuments: knowledgeBase.documents.length,
        queryResults: results,
        injection: {
          content: injection.content,
          characterCount: injection.characterCount,
          includedDocuments: injection.includedDocuments,
          excludedDocuments: injection.excludedDocuments,
        }
      });
    }

    return c.json({
      personaSlug,
      totalDocuments: knowledgeBase.documents.length,
      documents: knowledgeBase.documents.map(d => ({
        id: d.id,
        filename: d.filename,
        title: d.title,
        description: d.description,
        tags: d.tags,
        characterCount: d.characterCount,
      }))
    });
  } catch (error) {
    return c.json({ 
      error: error instanceof Error ? error.message : "Unknown error",
      personaSlug 
    }, 500);
  }
});

// Search threads
app.get("/api/memory/:userId/search", (c) => {
  const userId = c.req.param("userId");
  const query = c.req.query("q") || "";
  
  const results = memory.searchThreads(userId, query);
  return c.json(results);
});

// ============================================
// SCHEDULER API
// ============================================

// Get scheduler stats
app.get("/api/scheduler/stats", (c) => {
  return c.json(getSchedulerStats());
});

// Get deferred tasks for a user
app.get("/api/scheduler/tasks/:userId", (c) => {
  const userId = c.req.param("userId");
  const status = c.req.query("status") || undefined;
  const tasks = getUserTasks(userId, status);
  return c.json({ userId, tasks, count: tasks.length });
});

// Cancel a deferred task
app.delete("/api/scheduler/tasks/:taskId", (c) => {
  const taskId = c.req.param("taskId");
  const cancelled = cancelTask(taskId);
  return c.json({ taskId, cancelled });
});

// ============================================
// RECURRING SCHEDULER API
// ============================================

// Get recurring scheduler stats
app.get("/api/recurring/stats", (c) => {
  return c.json(getRecurringStats());
});

// List recurring tasks for a user
app.get("/api/recurring/tasks/:userId", (c) => {
  const userId = c.req.param("userId");
  const status = c.req.query("status") || undefined;
  const tasks = listRecurringTasks(userId, status);
  return c.json({ userId, tasks, count: tasks.length });
});

// Get a single recurring task
app.get("/api/recurring/task/:taskId", (c) => {
  const taskId = c.req.param("taskId");
  const task = getRecurringTask(taskId);
  if (!task) return c.json({ error: "Task not found" }, 404);
  return c.json(task);
});

// Create a recurring task
app.post("/api/recurring/tasks", async (c) => {
  const body = await c.req.json();
  const { userId, name, prompt, schedule, personaHint, timezone, priority, maxFailures, deviceId } = body;

  if (!userId || !name || !prompt || !schedule?.type) {
    return c.json({ error: "userId, name, prompt, and schedule.type are required" }, 400);
  }

  const task = createRecurringTask({
    userId,
    deviceId,
    name,
    prompt,
    personaHint,
    schedule,
    timezone,
    priority,
    maxFailures,
  });
  return c.json(task, 201);
});

// Cancel a recurring task
app.delete("/api/recurring/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const { userId } = await c.req.json().catch(() => ({ userId: "" }));
  if (!userId) return c.json({ error: "userId is required in body" }, 400);
  const cancelled = cancelRecurringTask(taskId, userId);
  return c.json({ taskId, cancelled });
});

// Pause a recurring task
app.post("/api/recurring/tasks/:taskId/pause", async (c) => {
  const taskId = c.req.param("taskId");
  const { userId } = await c.req.json().catch(() => ({ userId: "" }));
  if (!userId) return c.json({ error: "userId is required in body" }, 400);
  const paused = pauseRecurringTask(taskId, userId);
  return c.json({ taskId, paused });
});

// Resume a recurring task
app.post("/api/recurring/tasks/:taskId/resume", async (c) => {
  const taskId = c.req.param("taskId");
  const { userId } = await c.req.json().catch(() => ({ userId: "" }));
  if (!userId) return c.json({ error: "userId is required in body" }, 400);
  const resumed = resumeRecurringTask(taskId, userId);
  return c.json({ taskId, resumed });
});

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

// Start recurring task scheduler
startRecurringScheduler();

// NOTE: Recurring task execution callback is wired in ws/server.ts via setRecurringExecuteCallback()
// It routes through the V2 pipeline (handlePrompt → receptionist → persona writer → orchestrator → judge)
// This ensures recurring tasks use the full V2 architecture, not the old V1 AgentRunner

onRecurringEvent((event) => {
  console.log(`[Recurring] ${event.type}: ${event.taskName} (${event.taskId})`);
});

// Prune old cancelled recurring tasks on startup
pruneOldCancelledTasks();

// Graceful shutdown
process.on("SIGINT", async () => {
  await stopScheduler();
  await stopRecurringScheduler();
  stopWorkspaceCleanup();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await stopScheduler();
  await stopRecurringScheduler();
  stopWorkspaceCleanup();
  process.exit(0);
});

console.log(`
Ready for connections!

Test with:
  curl -X POST http://localhost:${PORT}/api/test/prompt \\
    -H "Content-Type: application/json" \\
    -d '{"prompt": "What can you help me with?"}'
`);
