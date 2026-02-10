/**
 * Local LLM — Qwen 2.5 0.5B via node-llama-cpp
 * 
 * Runs entirely on the local agent's machine. No server connection needed.
 * The GGUF model is auto-downloaded from HuggingFace on first use
 * and cached at ~/.bot/models/.
 * 
 * Used by the llm.local_query tool for cheap sub-tasks:
 * classification, keyword extraction, summarization, formatting, etc.
 */

import * as path from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

// ============================================
// CONFIGURATION
// ============================================

const MODEL_URI = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";
const MODELS_DIR = path.join(homedir(), ".bot", "models");
const MODEL_NAME = "Qwen 2.5 0.5B Instruct (Q4_K_M)";

// ============================================
// STATE
// ============================================

let modelPath: string | null = null;
let llamaInstance: any = null;
let loadedModel: any = null;
let modelReady = false;
let modelDownloading = false;

// ============================================
// INITIALIZATION
// ============================================

function ensureModelsDir(): void {
  if (!existsSync(MODELS_DIR)) {
    mkdirSync(MODELS_DIR, { recursive: true });
    console.log(`[LocalLLM] Created models directory: ${MODELS_DIR}`);
  }
}

/**
 * Probe whether the model is already downloaded.
 * Non-blocking, non-fatal. Call at startup.
 */
export async function probeLocalModel(): Promise<boolean> {
  ensureModelsDir();
  try {
    const { resolveModelFile } = await import("node-llama-cpp");
    modelPath = await resolveModelFile(MODEL_URI, { directory: MODELS_DIR, cli: false });
    modelReady = true;
    console.log(`[LocalLLM] Model ready: ${MODEL_NAME}`);
    return true;
  } catch {
    console.log(`[LocalLLM] Model not yet downloaded (will download on first use)`);
    return false;
  }
}

/**
 * Download the model if not already present. Safe to call multiple times.
 */
async function downloadModel(): Promise<boolean> {
  if (modelReady) return true;
  if (modelDownloading) return false;

  ensureModelsDir();
  modelDownloading = true;

  try {
    const { resolveModelFile } = await import("node-llama-cpp");
    console.log(`[LocalLLM] Downloading ${MODEL_NAME} — this may take a few minutes (~350 MB)...`);
    modelPath = await resolveModelFile(MODEL_URI, { directory: MODELS_DIR });
    modelReady = true;
    console.log(`[LocalLLM] Download complete: ${modelPath}`);
    return true;
  } catch (error) {
    console.error(`[LocalLLM] Download failed:`, error instanceof Error ? error.message : error);
    return false;
  } finally {
    modelDownloading = false;
  }
}

/**
 * Lazy-load the model into memory on first use.
 */
async function ensureModelLoaded(): Promise<void> {
  if (loadedModel) return;

  if (!modelPath || !modelReady) {
    const ok = await downloadModel();
    if (!ok || !modelPath) {
      throw new Error("Local model not available — download failed or not started");
    }
  }

  const { getLlama } = await import("node-llama-cpp");
  llamaInstance = await getLlama();
  loadedModel = await llamaInstance.loadModel({ modelPath });
  console.log("[LocalLLM] Model loaded into memory");
}

// ============================================
// QUERY
// ============================================

/**
 * Send a prompt to the local LLM and get a response.
 * This is the only function the tool handler needs.
 */
export async function queryLocalLLM(
  prompt: string,
  systemPrompt?: string,
  maxTokens?: number,
): Promise<string> {
  await ensureModelLoaded();

  const { LlamaChatSession } = await import("node-llama-cpp");

  const context = await loadedModel.createContext();
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: systemPrompt || "",
  });

  try {
    const response = await session.prompt(prompt, {
      maxTokens: maxTokens ?? 512,
      temperature: 0.3,
    });
    return response;
  } finally {
    await context.dispose();
  }
}

// ============================================
// STATUS
// ============================================

export function isLocalModelReady(): boolean {
  return modelReady;
}

export function getLocalModelName(): string {
  return MODEL_NAME;
}
