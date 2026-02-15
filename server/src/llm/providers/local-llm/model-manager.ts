/**
 * Local LLM — Model Manager
 *
 * Handles model downloading, probing, and lazy loading into memory.
 * State is module-scoped — only one model instance exists at a time.
 */

import * as fs from "fs";
import { createComponentLogger } from "#logging.js";
import { MODEL_URI, MODELS_DIR, MODEL_NAME } from "./config.js";

const log = createComponentLogger("local-llm.model");

// ============================================
// STATE
// ============================================

let modelPath: string | null = null;
let llamaInstance: any = null;   // Llama
let loadedModel: any = null;     // LlamaModel
let modelReady = false;
let modelDownloading = false;

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
export async function ensureModelLoaded(): Promise<void> {
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

/**
 * Get the loaded model instance. Throws if not loaded.
 */
export function getLoadedModel(): any {
  if (!loadedModel) throw new Error("Local model not loaded — call ensureModelLoaded() first");
  return loadedModel;
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
