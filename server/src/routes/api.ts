/**
 * API Routes
 *
 * Health check, memory, devices, test endpoints,
 * knowledge test, and thread search.
 */

import type { Hono } from "hono";
import * as memory from "../memory/manager.js";
import { getConnectedDevices } from "../ws/server.js";

// ============================================
// PUBLIC / BASIC API
// ============================================

export function registerApiRoutes(app: Hono, config: { llmProvider: string; llmApiKey: string }): void {
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
  // MEMORY
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

  // Search threads
  app.get("/api/memory/:userId/search", (c) => {
    const userId = c.req.param("userId");
    const query = c.req.query("q") || "";
    
    const results = memory.searchThreads(userId, query);
    return c.json(results);
  });

  // ============================================
  // TEST ENDPOINTS (development only)
  // ============================================

  // Test prompt (HTTP endpoint for debugging) — runs the FULL pipeline
  // DEVELOPMENT ONLY: Bypasses auth and uses incomplete options
  app.post("/api/test/prompt", async (c) => {
    if (process.env.NODE_ENV !== "development") {
      return c.json({ error: "This endpoint is only available in development mode" }, 403);
    }

    const body = await c.req.json();
    const { prompt } = body;

    if (!prompt) {
      return c.json({ error: "prompt is required" }, 400);
    }

    const { createLLMClient } = await import("../llm/providers.js");
    const { getConnectedDevices, getDeviceForUser } = await import("../ws/devices.js");
    const { runPipeline } = await import("../pipeline/pipeline.js");

    const llm = createLLMClient({
      provider: config.llmProvider as any,
      apiKey: config.llmApiKey,
    });

    // Find first connected local-agent user to pull real context
    const sessions = getConnectedDevices();
    const agentSession = sessions.find(s => s.capabilities?.includes("memory"));
    const userId = agentSession?.userId || "user_test";
    const deviceId = agentSession ? getDeviceForUser(userId) : null;

    if (!deviceId) {
      return c.json({ error: "No local agent connected — cannot run full pipeline" }, 503);
    }

    console.log(`[Test] Running full pipeline: userId=${userId}, deviceId=${deviceId}`);

    const result = await runPipeline({
      llm,
      userId,
      deviceId,
      prompt,
      messageId: "test_http",
      source: "test_http",
    });

    return c.json(result);
  });

  // Test knowledge loading for a persona
  // DEVELOPMENT ONLY: Bypasses auth and uses hardcoded userId
  app.get("/api/test/knowledge/:personaSlug", async (c) => {
    if (process.env.NODE_ENV !== "development") {
      return c.json({ error: "This endpoint is only available in development mode" }, 403);
    }

    const personaSlug = c.req.param("personaSlug");
    const query = c.req.query("q") || "";

    try {
      const { loadKnowledgeBase, queryKnowledge, injectRelevantKnowledge } = await import("../knowledge/index.js");
      const { getDeviceForUser } = await import("../ws/server.js");

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
}
