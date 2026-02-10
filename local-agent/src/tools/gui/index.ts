/**
 * GUI Automation Module
 * 
 * Phase 1: Headless Browser Track (Playwright)
 * - HeadlessBrowserBridge: manages headless Chromium with persistent context
 * - Network-level ad/tracker blocking
 * - Tool handler for gui.* tool dispatch
 * - Tool definitions for the gui category
 */

export { headlessBridge, HeadlessBrowserBridge } from "./headless-bridge.js";
export { handleGui } from "./tool-handler.js";
export { guiTools } from "./tool-defs.js";
export { applyNetworkBlocklist, clearBlocklistCache } from "./adblock.js";
export { ensurePlaywrightBrowser } from "./ensure-browser.js";
export { injectSetOfMarks, captureSetOfMarks, cleanupSetOfMarks } from "./set-of-marks.js";
export type { SoMElement, SoMResult } from "./set-of-marks.js";
export { networkInterceptor, NetworkInterceptor } from "./network-interceptor.js";
export type { RecordedEndpoint, JsonSchemaNode, RecordingSession } from "./network-interceptor.js";
export { callDesktopTool, isDesktopTarget, checkDesktopAvailability } from "./python-bridge.js";
export { ensureTesseract, findTesseract, getTesseractPath, TESSERACT_INSTALL_DIR } from "./ensure-tesseract.js";
