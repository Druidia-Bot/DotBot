/**
 * Local LLM — Configuration Constants
 */

import * as path from "path";
import * as os from "os";

/** HuggingFace URI — resolved by node-llama-cpp's model downloader */
export const MODEL_URI = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";

/** Where downloaded models are cached */
export const MODELS_DIR = path.join(os.homedir(), ".bot", "models");

/** Display name for logging */
export const MODEL_NAME = "Qwen 2.5 0.5B Instruct (Q4_K_M)";

/** How often to re-check cloud connectivity (ms) */
export const CONNECTIVITY_CHECK_INTERVAL_MS = 60_000;
