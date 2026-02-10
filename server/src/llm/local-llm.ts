/**
 * Local LLM Client (node-llama-cpp)
 *
 * Runs Qwen 2.5 0.5B locally via llama.cpp — no Ollama or external
 * services required.  The GGUF model is auto-downloaded from HuggingFace
 * on first use and cached at ~/.bot/models/.
 *
 * This module also owns the cloud connectivity check used by selectModel()
 * to decide when to fall back to local inference.
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { createComponentLogger } from "../logging.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMProvider,
} from "./types.js";

const log = createComponentLogger("local-llm");

// ============================================
// CONFIGURATION
// ============================================

/** HuggingFace URI — resolved by node-llama-cpp's model downloader */
const MODEL_URI = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";

/** Where downloaded models are cached */
const MODELS_DIR = path.join(os.homedir(), ".bot", "models");

/** Display name for logging */
const MODEL_NAME = "Qwen 2.5 0.5B Instruct (Q4_K_M)";

// ============================================
// STATE
// ============================================

let modelPath: string | null = null;
let llamaInstance: any = null;   // Llama
let loadedModel: any = null;     // LlamaModel
let modelReady = false;
let modelDownloading = false;

// Cloud connectivity state
let cloudReachable = true;
let lastConnectivityCheck = 0;
const CONNECTIVITY_CHECK_INTERVAL_MS = 60_000;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Ensure the models directory exists.
 */
function ensureModelsDir(): void {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    log.info(`Created models directory: ${MODELS_DIR}`);
  }
}

/**
 * Probe the local LLM: check if the model file exists, optionally
 * trigger a background download.  Non-blocking, non-fatal.
 *
 * Call once at server startup.
 */
export async function probeLocalModel(): Promise<{
  modelAvailable: boolean;
  modelName: string;
  downloading: boolean;
}> {
  ensureModelsDir();

  try {
    // Dynamic import — node-llama-cpp is optional at module load time
    const { resolveModelFile } = await import("node-llama-cpp");

    // resolveModelFile checks if the file exists locally first.
    // If not, it downloads it.  We run this with cli:false so no
    // progress bar is printed.
    modelPath = await resolveModelFile(MODEL_URI, { directory: MODELS_DIR, cli: false });
    modelReady = true;
    log.info(`Local model ready: ${modelPath}`);
    return { modelAvailable: true, modelName: MODEL_NAME, downloading: false };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // If it failed because the file doesn't exist and download failed,
    // we can try again later.
    log.warn(`Local model not available: ${errMsg}`);
    return { modelAvailable: false, modelName: MODEL_NAME, downloading: false };
  }
}

/**
 * Download the model file if it hasn't been downloaded yet.
 * Shows progress in the console.  Safe to call multiple times.
 */
export async function downloadLocalModel(): Promise<boolean> {
  if (modelReady) return true;
  if (modelDownloading) {
    log.info("Model download already in progress");
    return false;
  }

  ensureModelsDir();
  modelDownloading = true;

  try {
    const { resolveModelFile } = await import("node-llama-cpp");
    log.info(`Downloading ${MODEL_NAME} — this may take a few minutes (~350 MB)...`);
    modelPath = await resolveModelFile(MODEL_URI, { directory: MODELS_DIR });
    modelReady = true;
    log.info(`Download complete: ${modelPath}`);
    return true;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error(`Model download failed: ${errMsg}`);
    return false;
  } finally {
    modelDownloading = false;
  }
}

/**
 * Load the model into memory.  Called lazily on first chat request.
 * Subsequent calls reuse the loaded model.
 */
async function ensureModelLoaded(): Promise<void> {
  if (loadedModel) return;

  if (!modelPath || !modelReady) {
    // Try downloading first
    const ok = await downloadLocalModel();
    if (!ok || !modelPath) {
      throw new Error("Local model not available — download failed or not started");
    }
  }

  const { getLlama } = await import("node-llama-cpp");
  llamaInstance = await getLlama();
  loadedModel = await llamaInstance.loadModel({ modelPath });
  log.info("Local model loaded into memory");
}

// ============================================
// CLIENT IMPLEMENTATION
// ============================================

export class LocalLLMClient implements ILLMClient {
  provider: LLMProvider = "local" as LLMProvider;

  async chat(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    await ensureModelLoaded();

    const { LlamaChatSession } = await import("node-llama-cpp");

    // Extract system prompt
    const systemMsg = messages.find((m) => m.role === "system");
    const systemPrompt = systemMsg?.content || "";

    // Create a fresh context + session per call
    const context = await loadedModel.createContext();
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt,
    });

    try {
      // Replay conversation: feed each user message through the session.
      // For a 0.5B fallback model we only care about getting a reasonable
      // response to the latest turn.
      const userMessages = messages.filter((m) => m.role === "user");
      let response = "";

      if (userMessages.length === 0) {
        response = "I'm the local offline assistant. How can I help?";
      } else if (userMessages.length === 1) {
        response = await session.prompt(userMessages[0].content || "", {
          maxTokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.3,
        });
      } else {
        // Multi-turn: replay all but the last silently, then get final response
        for (let i = 0; i < userMessages.length - 1; i++) {
          await session.prompt(userMessages[i].content || "", {
            maxTokens: 256, // Short responses for history replay
            temperature: 0.3,
          });
        }
        const lastMsg = userMessages[userMessages.length - 1];
        response = await session.prompt(lastMsg.content || "", {
          maxTokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.3,
        });
      }

      return {
        content: response,
        model: "qwen2.5-0.5b-instruct-q4_k_m",
        provider: "local" as LLMProvider,
        usage: undefined,
        toolCalls: undefined,
      };
    } finally {
      await context.dispose();
    }
  }

  async *stream(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamChunk, void, unknown> {
    await ensureModelLoaded();

    const { LlamaChatSession } = await import("node-llama-cpp");

    const systemMsg = messages.find((m) => m.role === "system");
    const systemPrompt = systemMsg?.content || "";
    const userMessages = messages.filter((m) => m.role === "user");
    const lastMsg = userMessages[userMessages.length - 1]?.content || "";

    const context = await loadedModel.createContext();
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt,
    });

    try {
      // Replay history silently
      for (let i = 0; i < userMessages.length - 1; i++) {
        await session.prompt(userMessages[i].content || "", {
          maxTokens: 256,
          temperature: 0.3,
        });
      }

      // Stream the final response via onTextChunk callback
      let fullText = "";
      const chunks: string[] = [];
      let resolveChunk: ((value: string | null) => void) | null = null;
      let done = false;

      // Kick off generation in background
      const genPromise = session
        .prompt(lastMsg, {
          maxTokens: options?.maxTokens ?? 1024,
          temperature: options?.temperature ?? 0.3,
          onTextChunk: (chunk: string) => {
            if (resolveChunk) {
              resolveChunk(chunk);
              resolveChunk = null;
            } else {
              chunks.push(chunk);
            }
          },
        })
        .then((text: string) => {
          fullText = text;
          done = true;
          if (resolveChunk) {
            resolveChunk(null); // Signal completion
            resolveChunk = null;
          }
        });

      // Yield chunks as they arrive
      while (!done || chunks.length > 0) {
        if (chunks.length > 0) {
          const chunk = chunks.shift()!;
          yield { content: chunk, done: false };
        } else if (!done) {
          // Wait for next chunk
          const chunk = await new Promise<string | null>((resolve) => {
            resolveChunk = resolve;
          });
          if (chunk !== null) {
            yield { content: chunk, done: false };
          }
        }
      }

      await genPromise;
      yield { content: "", done: true };
    } finally {
      await context.dispose();
    }
  }
}

// ============================================
// CONNECTIVITY MONITORING
// ============================================

/**
 * Check if cloud LLM providers are reachable.
 * Uses a lightweight HEAD request to the DeepSeek API.
 * Caches result for CONNECTIVITY_CHECK_INTERVAL_MS.
 */
export async function isCloudReachable(): Promise<boolean> {
  const now = Date.now();

  // Use cached result if recent
  if (now - lastConnectivityCheck < CONNECTIVITY_CHECK_INTERVAL_MS) {
    return cloudReachable;
  }

  lastConnectivityCheck = now;

  try {
    // Quick connectivity check against DeepSeek's API endpoint
    const response = await fetch("https://api.deepseek.com/models", {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    cloudReachable = response.ok || response.status === 401; // 401 = reachable but no key
    return cloudReachable;
  } catch {
    // Network error — probably offline
    cloudReachable = false;
    log.warn("Cloud connectivity check failed — marking as offline");
    return false;
  }
}

// ============================================
// STATUS ACCESSORS
// ============================================

export function isLocalModelReady(): boolean {
  return modelReady;
}

/**
 * Get a summary of the local fallback status for startup logging.
 */
export function getLocalStatus(): {
  modelReady: boolean;
  modelName: string;
  modelsDir: string;
} {
  return {
    modelReady,
    modelName: MODEL_NAME,
    modelsDir: MODELS_DIR,
  };
}
