/**
 * Python Bridge — Node.js → Python subprocess for desktop GUI automation.
 * 
 * Maintains a persistent Python daemon process (gui_agent.py --daemon) that
 * communicates via JSON-RPC over stdin/stdout. This eliminates the ~300ms
 * Python startup overhead per tool call, reducing latency to ~10ms.
 * 
 * Design:
 * - Persistent daemon: spawned on first call, kept alive across calls
 * - JSON-RPC protocol: newline-delimited JSON over stdin/stdout
 * - Session state: window handles cached across calls in the Python process
 * - Auto-restart: if daemon dies, respawns on next call
 * - Fallback: if daemon can't start, falls back to one-shot mode
 */

import { spawn, execFile, type ChildProcess } from "child_process";
import { promisify } from "util";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import { nanoid } from "nanoid";
import { createInterface, type Interface as ReadlineInterface } from "readline";

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Path to the Python GUI agent script */
const GUI_AGENT_PATH = join(__dirname, "desktop", "gui_agent.py");

/** Default timeout for Python subprocess calls (ms) */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Per-tool timeout overrides */
const TOOL_TIMEOUTS: Record<string, number> = {
  "gui.navigate": 20_000,    // App launch + up to 8s window-find retry
  "gui.wait_for": 125_000,   // Up to 2 min + buffer
  "gui.screenshot_region": 10_000,
  "gui.read_state": 10_000,
};

/**
 * Check if Python is available and the gui_agent.py script exists.
 */
export async function checkDesktopAvailability(): Promise<{
  available: boolean;
  python: string | null;
  error?: string;
}> {
  // Check Python
  try {
    const { stdout } = await execFileP("python", ["--version"], { timeout: 5_000 });
    const version = stdout.trim();

    // Check gui_agent.py exists
    try {
      await fs.access(GUI_AGENT_PATH);
    } catch {
      return { available: false, python: version, error: `gui_agent.py not found at ${GUI_AGENT_PATH}` };
    }

    // Check pywinauto + pyautogui
    try {
      await execFileP("python", ["-c", "import pywinauto; import pyautogui"], { timeout: 10_000 });
    } catch {
      return { available: false, python: version, error: "Missing Python packages: pywinauto and/or pyautogui. Run: pip install pywinauto pyautogui" };
    }

    return { available: true, python: version };
  } catch {
    return { available: false, python: null, error: "Python not found. Desktop GUI automation requires Python 3.9+." };
  }
}

// ============================================
// PERSISTENT DAEMON PROCESS
// ============================================

let daemonProcess: ChildProcess | null = null;
let daemonRL: ReadlineInterface | null = null;
let daemonReady = false;
let daemonFailed = false; // True if daemon couldn't start — use one-shot fallback

/** Pending responses: id → { resolve, reject, timer } */
const pendingCalls = new Map<string, {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/**
 * Ensure the daemon process is running. Spawns it on first call.
 */
async function ensureDaemon(): Promise<boolean> {
  if (daemonFailed) return false;
  if (daemonProcess && daemonReady) return true;

  // Already starting — wait for ready
  if (daemonProcess && !daemonReady) {
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (daemonReady || daemonFailed) { clearInterval(check); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(check); resolve(); }, 10_000);
    });
    return daemonReady;
  }

  return new Promise<boolean>((resolve) => {
    console.log("[PythonBridge] Starting daemon process...");

    const proc = spawn("python", [GUI_AGENT_PATH, "--daemon"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    daemonProcess = proc;

    // Read stdout line by line
    const rl = createInterface({ input: proc.stdout! });
    daemonRL = rl;

    let readyResolved = false;

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const msg = JSON.parse(trimmed);

        // Ready signal
        if (msg.ready && !readyResolved) {
          readyResolved = true;
          daemonReady = true;
          console.log(`[PythonBridge] Daemon ready (PID ${msg.pid})`);
          resolve(true);
          return;
        }

        // Response to a pending call
        if (msg.id && pendingCalls.has(msg.id)) {
          const pending = pendingCalls.get(msg.id)!;
          clearTimeout(pending.timer);
          pendingCalls.delete(msg.id);
          pending.resolve(JSON.stringify(msg.result || {}));
        }
      } catch {
        // Not valid JSON — ignore
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.warn("[PythonBridge] stderr:", text.slice(0, 300));
    });

    proc.on("exit", (code) => {
      console.warn(`[PythonBridge] Daemon exited (code ${code})`);
      daemonProcess = null;
      daemonRL = null;
      daemonReady = false;

      // Reject all pending calls
      for (const [id, pending] of pendingCalls) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Daemon exited with code ${code}`));
      }
      pendingCalls.clear();

      if (!readyResolved) {
        readyResolved = true;
        daemonFailed = true;
        console.warn("[PythonBridge] Daemon failed to start — falling back to one-shot mode");
        resolve(false);
      }
    });

    proc.on("error", (err) => {
      console.error("[PythonBridge] Daemon spawn error:", err.message);
      daemonProcess = null;
      daemonFailed = true;
      if (!readyResolved) {
        readyResolved = true;
        resolve(false);
      }
    });

    // Startup timeout
    setTimeout(() => {
      if (!readyResolved) {
        readyResolved = true;
        console.warn("[PythonBridge] Daemon startup timed out (10s)");
        daemonFailed = true;
        try { proc.kill(); } catch {}
        resolve(false);
      }
    }, 10_000);
  });
}

/**
 * Send a command to the daemon and wait for the response.
 */
async function daemonCall(toolId: string, args: Record<string, any>): Promise<string> {
  if (!daemonProcess?.stdin?.writable) {
    throw new Error("Daemon not available");
  }

  const id = `call_${nanoid(8)}`;
  const timeout = TOOL_TIMEOUTS[toolId] || DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Daemon call ${toolId} timed out after ${timeout}ms`));
    }, timeout);

    pendingCalls.set(id, { resolve, reject, timer });

    const msg = JSON.stringify({ id, tool: toolId, args }) + "\n";
    daemonProcess!.stdin!.write(msg);
  });
}

/**
 * One-shot fallback: spawn a fresh Python process (legacy mode).
 */
async function oneshotCall(toolId: string, args: Record<string, any>): Promise<string> {
  const timeout = TOOL_TIMEOUTS[toolId] || DEFAULT_TIMEOUT_MS;
  const argsJson = JSON.stringify(args);

  try {
    const { stdout, stderr } = await execFileP(
      "python",
      [GUI_AGENT_PATH, "--tool", toolId, "--args", argsJson],
      {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
    );

    if (stderr?.trim()) {
      console.warn(`[PythonBridge] stderr for ${toolId}:`, stderr.trim().slice(0, 200));
    }

    const trimmed = stdout.trim();
    if (!trimmed) return JSON.stringify({ error: `Empty output for ${toolId}` });

    try { JSON.parse(trimmed); } catch {
      return JSON.stringify({ error: `Invalid JSON for ${toolId}: ${trimmed.slice(0, 200)}` });
    }
    return trimmed;
  } catch (err: any) {
    if (err.killed || err.signal === "SIGTERM") {
      return JSON.stringify({ error: `${toolId} timed out after ${timeout}ms` });
    }
    if (err.stdout?.trim()) {
      try { JSON.parse(err.stdout.trim()); return err.stdout.trim(); } catch {}
    }
    return JSON.stringify({ error: `[${toolId}] ${err.message || err}` });
  }
}

/**
 * Send a tool call to the Python agent. Uses daemon if available, falls back to one-shot.
 */
async function rawPythonCall(toolId: string, args: Record<string, any>): Promise<string> {
  // Try daemon first
  const daemonOk = await ensureDaemon();
  if (daemonOk) {
    try {
      return await daemonCall(toolId, args);
    } catch (err) {
      console.warn(`[PythonBridge] Daemon call failed, retrying one-shot:`, err instanceof Error ? err.message : err);
      // Daemon died mid-call — reset so next call retries daemon
      daemonFailed = false;
    }
  }

  // Fallback to one-shot
  return oneshotCall(toolId, args);
}

/**
 * Shutdown the daemon process (called on agent exit).
 */
export function shutdownDaemon(): void {
  if (daemonProcess) {
    try {
      daemonProcess.stdin?.write(JSON.stringify({ id: "shutdown", tool: "_quit", args: {} }) + "\n");
      setTimeout(() => { try { daemonProcess?.kill(); } catch {} }, 2000);
    } catch {}
  }
}

/**
 * Tier 3 LLM fallback: when Python OCR scan finds text but can't match
 * the target element, send the OCR dump to the local LLM for interpretation.
 * Returns the index of the best-matching OCR item, or -1.
 */
async function llmInterpretOcrDump(
  elementText: string,
  ocrDump: Array<{ index: number; text: string; rect: { x: number; y: number; w: number; h: number } }>,
): Promise<number> {
  try {
    const { queryLocalLLM } = await import("../../llm/local-llm.js");

    const itemList = ocrDump
      .map((it) => `[${it.index}] "${it.text}"`)
      .join("\n");

    const prompt = `The user is looking for a UI element labeled "${elementText}".
Here are all visible text elements found via OCR on the screen:

${itemList}

Which item index is the best match for "${elementText}"? Reply with ONLY the numeric index. If none match, reply -1.`;

    const system = "You are a UI element matcher. Given a target label and a list of OCR text items, pick the best matching index. Reply with only the number.";

    const response = await queryLocalLLM(prompt, system, 16);
    const parsed = parseInt(response.trim(), 10);
    return Number.isNaN(parsed) ? -1 : parsed;
  } catch (err) {
    console.warn("[PythonBridge] LLM OCR interpretation failed:", err instanceof Error ? err.message : err);
    return -1;
  }
}

/**
 * Call a desktop GUI tool via the Python subprocess bridge.
 * 
 * Includes Tier 3 LLM fallback: if the Python script returns needs_llm=true
 * with an ocr_dump (OCR found text but couldn't match), the bridge calls
 * the local LLM to interpret which item matches, then issues a second
 * Python call to click at those coordinates.
 * 
 * @param toolId - The gui.* tool ID
 * @param args - Tool arguments (will be JSON-serialized)
 * @returns JSON string result from the Python script
 */
/** Track whether we've already attempted Tesseract install this session */
let tesseractInstallAttempted = false;

export async function callDesktopTool(
  toolId: string,
  args: Record<string, any>,
): Promise<string> {
  const result = await rawPythonCall(toolId, args);

  // Auto-install Tesseract if needed: when a tool result says tesseract_available: false,
  // install it transparently and retry. Each Python subprocess detects Tesseract fresh.
  if (!tesseractInstallAttempted) {
    try {
      const parsed = JSON.parse(result);
      if (parsed.tesseract_available === false) {
        tesseractInstallAttempted = true;
        console.log("[PythonBridge] Tesseract OCR not found — auto-installing...");
        try {
          const { ensureTesseract } = await import("./ensure-tesseract.js");
          const installResult = await ensureTesseract();
          if (installResult.available) {
            console.log(`[PythonBridge] Tesseract installed at ${installResult.path} — retrying tool call`);
            return callDesktopTool(toolId, args); // Retry with Tesseract now available
          } else {
            console.warn(`[PythonBridge] Tesseract auto-install failed: ${installResult.error}`);
            // Surface the failure to the LLM so it can relay instructions to the user
            return JSON.stringify({
              ...parsed,
              tesseract_install_failed: true,
              install_instructions: installResult.error,
            });
          }
        } catch (err) {
          console.warn("[PythonBridge] Tesseract auto-install error:", err instanceof Error ? err.message : err);
        }
      }
    } catch { /* not JSON */ }
  }

  // Check for Tier 3 LLM fallback opportunity
  try {
    const parsed = JSON.parse(result);
    if (
      parsed.needs_llm === true &&
      Array.isArray(parsed.ocr_dump) &&
      parsed.ocr_dump.length > 0 &&
      (toolId === "gui.click" || toolId === "gui.find_element")
    ) {
      const elementText = args.element_text || "";
      if (!elementText) return result;

      console.log(`[PythonBridge] Tier 3 LLM fallback: interpreting ${parsed.ocr_dump.length} OCR items for "${elementText}"`);
      const matchIndex = await llmInterpretOcrDump(elementText, parsed.ocr_dump);

      if (matchIndex >= 0) {
        const matchedItem = parsed.ocr_dump.find((it: any) => it.index === matchIndex);
        if (matchedItem) {
          const rect = matchedItem.rect;
          const cx = rect.x + Math.round(rect.w / 2);
          const cy = rect.y + Math.round(rect.h / 2);

          if (toolId === "gui.click") {
            // Issue a coordinate click via Python
            const clickResult = await rawPythonCall("gui.click", {
              ...args,
              coordinates: { x: cx, y: cy },
              element_text: undefined, // Use coordinates instead
            });
            // Augment with LLM info
            try {
              const clickParsed = JSON.parse(clickResult);
              clickParsed.method = "ocr_llm";
              clickParsed.llm_matched_text = matchedItem.text;
              clickParsed.llm_matched_index = matchIndex;
              return JSON.stringify(clickParsed);
            } catch {
              return clickResult;
            }
          } else {
            // gui.find_element — return the match info
            return JSON.stringify({
              found: true,
              method: "ocr_llm",
              text: matchedItem.text,
              rect: matchedItem.rect,
              center: { x: cx, y: cy },
              llm_matched_index: matchIndex,
              track: "desktop",
            });
          }
        }
      }

      // LLM couldn't match either — return original "not found" result
      console.log("[PythonBridge] LLM fallback: no match found");
    }
  } catch {
    // Not valid JSON or no LLM needed — return as-is
  }

  return result;
}

/**
 * Determine if a tool call should be routed to the desktop track.
 * 
 * Rules:
 * - If app_name is set and is NOT a browser name → desktop
 * - If no app_name → browser (default)
 * - Network interception / SoM tools → always browser
 */
export function isDesktopTarget(toolId: string, args: Record<string, any>): boolean {
  // These tools are browser-only (no desktop equivalent)
  const browserOnlyTools = new Set([
    "gui.start_recording",
    "gui.stop_recording",
    "gui.list_schemas",
    "gui.read_schema",
    "gui.open_in_browser",
    "gui.switch_tab",
  ]);

  if (browserOnlyTools.has(toolId)) return false;

  const appName = (args.app_name || "").toLowerCase().trim();

  // No app_name → default to browser track
  if (!appName) return false;

  // Known browser names → browser track
  const browserNames = new Set([
    "chrome", "chromium", "edge", "firefox", "safari",
    "browser", "brave", "opera", "vivaldi",
  ]);

  // Check if any browser name is in the app_name
  for (const name of browserNames) {
    if (appName.includes(name)) return false;
  }

  // Everything else → desktop track
  return true;
}
