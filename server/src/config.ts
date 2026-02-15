/**
 * Server Configuration
 *
 * Environment variables, LLM provider selection, API key registration,
 * and local model probing. Importable by any module that needs config
 * without pulling in the full server.
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from project root (ESM compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../../.env") });

import { registerApiKeys } from "#llm/selection/model-selector.js";
import { probeLocalModel, downloadLocalModel } from "#llm/providers/local-llm/index.js";

// ============================================
// NETWORK
// ============================================

export const PORT = parseInt(process.env.PORT || "3000");
export const WS_PORT = parseInt(process.env.WS_PORT || "3001");
export const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

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

// ============================================
// LLM PROVIDERS
// ============================================

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";

// Determine which provider to use
export let LLM_PROVIDER: "deepseek" | "anthropic" | "openai" | "gemini" = "deepseek";
export let LLM_API_KEY = DEEPSEEK_API_KEY;

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
