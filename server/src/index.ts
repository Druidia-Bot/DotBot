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
} from "./scheduler/index.js";

// Initialize ~/.bot/ environment first
initBotEnvironment();

// ============================================
// CONFIGURATION
// ============================================

const PORT = parseInt(process.env.PORT || "3000");
const WS_PORT = parseInt(process.env.WS_PORT || "3001");

// LLM Provider Configuration (DeepSeek is default)
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";

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
});

const availableProviders = [
  DEEPSEEK_API_KEY && "DeepSeek V3.2 (workhorse)",
  GEMINI_API_KEY && "Gemini 3 Pro (deep context)",
  ANTHROPIC_API_KEY && "Claude Opus 4.6 (architect)",
  OPENAI_API_KEY && "OpenAI (fallback)",
  "Qwen 2.5 0.5B (local, node-llama-cpp)",
].filter(Boolean);

console.log(`🤖 Primary provider: ${LLM_PROVIDER.toUpperCase()}`);
console.log(`📋 Available models: ${availableProviders.join(", ")}`);

// Probe local LLM for offline fallback (non-blocking, non-fatal)
// Skip if cloud API keys are available — local model is only useful when offline
const hasCloudKeys = !!(DEEPSEEK_API_KEY || ANTHROPIC_API_KEY || OPENAI_API_KEY || GEMINI_API_KEY);
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
  })();
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
createWSServer({ port: WS_PORT, apiKey: LLM_API_KEY, provider: LLM_PROVIDER, httpBaseUrl: `http://localhost:${PORT}` });
console.log(`🔌 WebSocket server running on ws://localhost:${WS_PORT}`);

// Initialize knowledge service (must be after WebSocket server)
initKnowledgeService();

// Start task scheduler
startScheduler();
onSchedulerEvent((event) => {
  console.log(`[Scheduler] ${event.type}: ${event.taskId}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  stopScheduler();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopScheduler();
  process.exit(0);
});

console.log(`
Ready for connections!

Test with:
  curl -X POST http://localhost:${PORT}/api/test/prompt \\
    -H "Content-Type: application/json" \\
    -d '{"prompt": "What can you help me with?"}'
`);
