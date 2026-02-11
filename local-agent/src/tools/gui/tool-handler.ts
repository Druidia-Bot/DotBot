/**
 * GUI Tool Handler
 * 
 * Dispatches gui.* tool calls to the correct track:
 * - Browser track: HeadlessBrowserBridge (Playwright, Node-native)
 * - Desktop track: Python subprocess (pywinauto + pyautogui)
 * 
 * Auto-detection: if args.app_name is set and isn't a browser name,
 * routes to the desktop track. Otherwise defaults to headless browser.
 * 
 * Phase 1: Headless Browser Track (Playwright)
 * Phase 2: Set-of-Marks + Visual Grounding
 * Phase 3: Network Interception / API Schema Learning
 * Phase 4: Desktop Track (Python subprocess)
 */

import { headlessBridge } from "./headless-bridge.js";
import { isDesktopTarget, callDesktopTool } from "./python-bridge.js";
import type { ToolExecResult } from "../tool-executor.js";

// ============================================
// SCREENSHOT UPLOAD (HTTP POST instead of base64 over WebSocket)
// ============================================

/** Server HTTP URL derived from WS URL (ws://localhost:3001 → http://localhost:3000, wss://server.example.com/ws → https://server.example.com) */
const SERVER_HTTP_URL = (() => {
  const wsUrl = process.env.DOTBOT_SERVER || "ws://localhost:3001";
  const parsed = new URL(wsUrl);
  const isSecure = parsed.protocol === "wss:";
  const host = parsed.hostname;
  if (isSecure) return `https://${host}`;
  const httpPort = parseInt(process.env.PORT || "3000");
  return `http://${host}:${httpPort}`;
})();

/**
 * If a tool result contains image_base64, upload the binary to the server
 * via HTTP POST and replace the base64 blob with a tiny screenshot_ref.
 * Falls back to returning original output if upload fails.
 */
async function uploadScreenshotIfPresent(output: string): Promise<string> {
  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }

  if (!parsed.image_base64 || typeof parsed.image_base64 !== "string") {
    return output;
  }

  const base64Data = parsed.image_base64;
  const mediaType = parsed.format === "png" ? "image/png" : "image/jpeg";

  try {
    const binaryBuffer = Buffer.from(base64Data, "base64");

    const response = await fetch(`${SERVER_HTTP_URL}/api/screenshot`, {
      method: "POST",
      headers: {
        "Content-Type": mediaType,
        "X-Screenshot-Width": String(parsed.width || 0),
        "X-Screenshot-Height": String(parsed.height || 0),
      },
      body: binaryBuffer,
    });

    if (!response.ok) {
      console.warn(`[GUI] Screenshot upload failed (${response.status}), falling back to inline`);
      return output;
    }

    const result = await response.json() as { id: string; size_kb: number };

    // Replace base64 blob with tiny reference
    const compact = { ...parsed, screenshot_ref: result.id };
    delete compact.image_base64;

    return JSON.stringify(compact);
  } catch (err) {
    console.warn(`[GUI] Screenshot upload error, falling back to inline:`, err instanceof Error ? err.message : err);
    return output;
  }
}

// ============================================
// GUI TOOL DISPATCHER
// ============================================

/**
 * Handle all gui.* tool calls by routing to the correct track.
 */
export async function handleGui(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  try {
    let output: string;

    // --- Phase 4: Desktop track routing ---
    // If the tool targets a native desktop app, route through Python bridge
    if (isDesktopTarget(toolId, args)) {
      output = await callDesktopTool(toolId, args);
    } else {
      // --- Browser track ---
      switch (toolId) {
        // --- Phase 1: Core browser automation ---

        case "gui.read_state": {
          const mode = args.mode || "text";
          output = mode === "visual"
            ? await headlessBridge.readStateVisual(args)
            : await headlessBridge.readState(args);
          break;
        }

        case "gui.click":
          output = await headlessBridge.click(args);
          break;

        case "gui.type_text":
          output = await headlessBridge.typeText(args);
          break;

        case "gui.hotkey":
          output = await headlessBridge.hotkey(args);
          break;

        case "gui.switch_tab":
          output = await headlessBridge.switchTab(args);
          break;

        case "gui.wait_for":
          output = await headlessBridge.waitFor(args);
          break;

        case "gui.navigate":
          output = await headlessBridge.navigate(args);
          break;

        case "gui.screenshot_region":
          output = await headlessBridge.screenshotRegion(args);
          break;

        case "gui.open_in_browser":
          output = await headlessBridge.openInBrowser(args);
          break;

        // --- Compound tools (reduce cloud round-trips) ---

        case "gui.batch":
          output = await handleBatch(args);
          break;

        case "gui.search_website":
          output = await headlessBridge.searchWebsite(args);
          break;

        case "gui.fill_and_submit":
          output = await headlessBridge.fillAndSubmit(args);
          break;

        // --- Phase 2: Set-of-Marks + Visual Grounding ---

        case "gui.find_element":
          output = await headlessBridge.findElement(args);
          break;

        // --- Phase 3: Network Interception ---

        case "gui.start_recording":
          output = await headlessBridge.startRecording(args);
          break;

        case "gui.stop_recording":
          output = await headlessBridge.stopRecording(args);
          break;

        case "gui.list_schemas":
          output = await headlessBridge.listSchemas(args);
          break;

        case "gui.read_schema":
          output = await headlessBridge.readSchema(args);
          break;

        default:
          return { success: false, output: "", error: `Unknown gui tool: ${toolId}` };
      }
    }

    // Post-process: upload screenshots via HTTP POST instead of sending
    // large base64 blobs over the WebSocket message queue
    output = await uploadScreenshotIfPresent(output);

    return { success: true, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Include the tool ID in the error for easier debugging
    return { success: false, output: "", error: `[${toolId}] ${message}` };
  }
}

// ============================================
// BATCH EXECUTION
// ============================================

/**
 * Execute multiple gui.* actions sequentially without cloud round-trips.
 * Returns combined results from all steps.
 */
async function handleBatch(args: Record<string, any>): Promise<string> {
  const steps = args.steps as Array<{ tool: string; args: Record<string, any> }>;
  const continueOnError = args.continue_on_error === true;

  if (!Array.isArray(steps) || steps.length === 0) {
    return JSON.stringify({ error: "No steps provided", steps_completed: 0 });
  }

  // Cap at 20 steps to prevent runaway sequences
  const maxSteps = Math.min(steps.length, 20);
  const results: Array<{ step: number; tool: string; success: boolean; output: any }> = [];
  let stoppedAt: number | null = null;

  for (let i = 0; i < maxSteps; i++) {
    const step = steps[i];
    const toolId = step.tool;
    const toolArgs = step.args || {};

    // Only allow gui.* tools in batch (security boundary)
    if (!toolId || !toolId.startsWith("gui.")) {
      results.push({ step: i, tool: toolId, success: false, output: "Only gui.* tools allowed in batch" });
      if (!continueOnError) { stoppedAt = i; break; }
      continue;
    }

    // Prevent recursive batching
    if (toolId === "gui.batch") {
      results.push({ step: i, tool: toolId, success: false, output: "Cannot nest gui.batch calls" });
      if (!continueOnError) { stoppedAt = i; break; }
      continue;
    }

    try {
      const result = await handleGui(toolId, toolArgs);
      let parsedOutput: any;
      try { parsedOutput = JSON.parse(result.output); } catch { parsedOutput = result.output; }
      results.push({ step: i, tool: toolId, success: result.success, output: parsedOutput });

      if (!result.success && !continueOnError) {
        stoppedAt = i;
        break;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({ step: i, tool: toolId, success: false, output: errMsg });
      if (!continueOnError) { stoppedAt = i; break; }
    }
  }

  return JSON.stringify({
    steps_completed: results.length,
    steps_total: maxSteps,
    stopped_at: stoppedAt,
    results,
  });
}
