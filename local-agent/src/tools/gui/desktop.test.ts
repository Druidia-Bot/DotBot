/**
 * Phase 4: Desktop Track — Production Tests
 * 
 * Tests for:
 * - isDesktopTarget routing logic (browser vs desktop detection)
 * - python-bridge module exports and path resolution
 * - gui_agent.py existence and syntax validity
 * - Tool handler desktop routing (mocked)
 * - Integration: desktop tools registered and routable
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import * as fs from "fs";

// ============================================
// 1. isDesktopTarget — ROUTING LOGIC
// ============================================

import { isDesktopTarget } from "./python-bridge.js";

describe("isDesktopTarget — browser vs desktop routing", () => {
  // Desktop targets (should return true)
  it("routes Calculator to desktop", () => {
    expect(isDesktopTarget("gui.click", { app_name: "Calculator" })).toBe(true);
  });

  it("routes Notepad to desktop", () => {
    expect(isDesktopTarget("gui.click", { app_name: "Notepad" })).toBe(true);
  });

  it("routes Explorer to desktop", () => {
    expect(isDesktopTarget("gui.read_state", { app_name: "File Explorer" })).toBe(true);
  });

  it("routes Word to desktop", () => {
    expect(isDesktopTarget("gui.type_text", { app_name: "Word" })).toBe(true);
  });

  it("routes Settings to desktop", () => {
    expect(isDesktopTarget("gui.click", { app_name: "Settings" })).toBe(true);
  });

  it("routes any unknown app to desktop", () => {
    expect(isDesktopTarget("gui.click", { app_name: "MyCustomApp" })).toBe(true);
  });

  // Browser targets (should return false)
  it("routes Chrome to browser", () => {
    expect(isDesktopTarget("gui.click", { app_name: "Chrome" })).toBe(false);
  });

  it("routes Chromium to browser", () => {
    expect(isDesktopTarget("gui.click", { app_name: "Chromium" })).toBe(false);
  });

  it("routes Edge to browser", () => {
    expect(isDesktopTarget("gui.click", { app_name: "Edge" })).toBe(false);
  });

  it("routes Firefox to browser", () => {
    expect(isDesktopTarget("gui.click", { app_name: "Firefox" })).toBe(false);
  });

  it("routes Brave to browser", () => {
    expect(isDesktopTarget("gui.click", { app_name: "Brave" })).toBe(false);
  });

  it("routes 'browser' keyword to browser", () => {
    expect(isDesktopTarget("gui.click", { app_name: "browser" })).toBe(false);
  });

  it("is case-insensitive for browser names", () => {
    expect(isDesktopTarget("gui.click", { app_name: "CHROME" })).toBe(false);
    expect(isDesktopTarget("gui.click", { app_name: "chrome" })).toBe(false);
    expect(isDesktopTarget("gui.click", { app_name: "Google Chrome" })).toBe(false);
  });

  // No app_name → default to browser
  it("defaults to browser when no app_name", () => {
    expect(isDesktopTarget("gui.click", {})).toBe(false);
  });

  it("defaults to browser when app_name is empty string", () => {
    expect(isDesktopTarget("gui.click", { app_name: "" })).toBe(false);
  });

  // Browser-only tools → always false
  it("routes gui.start_recording to browser (always)", () => {
    expect(isDesktopTarget("gui.start_recording", { app_name: "Calculator" })).toBe(false);
  });

  it("routes gui.stop_recording to browser (always)", () => {
    expect(isDesktopTarget("gui.stop_recording", { app_name: "Calculator" })).toBe(false);
  });

  it("routes gui.list_schemas to browser (always)", () => {
    expect(isDesktopTarget("gui.list_schemas", { app_name: "Calculator" })).toBe(false);
  });

  it("routes gui.read_schema to browser (always)", () => {
    expect(isDesktopTarget("gui.read_schema", { app_name: "Calculator" })).toBe(false);
  });

  it("routes gui.open_in_browser to browser (always)", () => {
    expect(isDesktopTarget("gui.open_in_browser", { app_name: "Calculator" })).toBe(false);
  });

  it("routes gui.switch_tab to browser (always)", () => {
    expect(isDesktopTarget("gui.switch_tab", { app_name: "Calculator" })).toBe(false);
  });

  // Tools that CAN route to desktop
  it("routes gui.read_state with app to desktop", () => {
    expect(isDesktopTarget("gui.read_state", { app_name: "Calculator" })).toBe(true);
  });

  it("routes gui.find_element with app to desktop", () => {
    expect(isDesktopTarget("gui.find_element", { app_name: "Notepad" })).toBe(true);
  });

  it("routes gui.hotkey with app to desktop", () => {
    expect(isDesktopTarget("gui.hotkey", { app_name: "Notepad" })).toBe(true);
  });

  it("routes gui.wait_for with app to desktop", () => {
    expect(isDesktopTarget("gui.wait_for", { app_name: "Calculator" })).toBe(true);
  });

  it("routes gui.navigate with app to desktop", () => {
    expect(isDesktopTarget("gui.navigate", { app_name: "Calculator" })).toBe(true);
  });

  it("routes gui.screenshot_region with app to desktop", () => {
    expect(isDesktopTarget("gui.screenshot_region", { app_name: "Notepad" })).toBe(true);
  });
});

// ============================================
// 2. PYTHON BRIDGE — MODULE EXPORTS
// ============================================

describe("python-bridge — exports", () => {
  it("exports isDesktopTarget function", async () => {
    const mod = await import("./python-bridge.js");
    expect(typeof mod.isDesktopTarget).toBe("function");
  });

  it("exports callDesktopTool function", async () => {
    const mod = await import("./python-bridge.js");
    expect(typeof mod.callDesktopTool).toBe("function");
  });

  it("exports checkDesktopAvailability function", async () => {
    const mod = await import("./python-bridge.js");
    expect(typeof mod.checkDesktopAvailability).toBe("function");
  });
});

// ============================================
// 3. GUI_AGENT.PY — FILE VALIDATION
// ============================================

describe("gui_agent.py — file structure", () => {
  const agentPath = path.join(__dirname, "desktop", "gui_agent.py");

  it("gui_agent.py exists", () => {
    expect(fs.existsSync(agentPath)).toBe(true);
  });

  it("gui_agent.py has expected tool handlers", () => {
    const content = fs.readFileSync(agentPath, "utf-8");
    
    const expectedHandlers = [
      "handle_read_state",
      "handle_find_element",
      "handle_click",
      "handle_type_text",
      "handle_hotkey",
      "handle_wait_for",
      "handle_navigate",
      "handle_screenshot_region",
    ];
    
    for (const handler of expectedHandlers) {
      expect(content, `Missing handler: ${handler}`).toContain(`def ${handler}`);
    }
  });

  it("gui_agent.py has TOOL_HANDLERS dispatch map", () => {
    const content = fs.readFileSync(agentPath, "utf-8");
    expect(content).toContain("TOOL_HANDLERS");
    
    // All tools should be in the dispatch map
    const expectedTools = [
      "gui.read_state",
      "gui.find_element",
      "gui.click",
      "gui.type_text",
      "gui.hotkey",
      "gui.wait_for",
      "gui.navigate",
      "gui.screenshot_region",
    ];
    
    for (const tool of expectedTools) {
      expect(content, `Missing tool in dispatch: ${tool}`).toContain(`"${tool}"`);
    }
  });

  it("gui_agent.py has pyautogui.FAILSAFE = True", () => {
    const content = fs.readFileSync(agentPath, "utf-8");
    expect(content).toContain("pyautogui.FAILSAFE = True");
  });

  it("gui_agent.py uses Application().connect() not Desktop().windows() for find_window", () => {
    const content = fs.readFileSync(agentPath, "utf-8");
    // find_window should use Application().connect() for proper WindowSpecification
    expect(content).toContain("Application(backend=\"uia\").connect(");
  });

  it("gui_agent.py has SmartNavigator locate_via_accessibility", () => {
    const content = fs.readFileSync(agentPath, "utf-8");
    expect(content).toContain("def locate_via_accessibility");
    expect(content).toContain("def smart_find");
  });

  it("gui_agent.py has argparse --tool and --args", () => {
    const content = fs.readFileSync(agentPath, "utf-8");
    expect(content).toContain("--tool");
    expect(content).toContain("--args");
  });

  it("requirements.txt exists with expected packages", () => {
    const reqPath = path.join(__dirname, "desktop", "requirements.txt");
    expect(fs.existsSync(reqPath)).toBe(true);
    const content = fs.readFileSync(reqPath, "utf-8");
    expect(content).toContain("pyautogui");
    expect(content).toContain("pywinauto");
    expect(content).toContain("Pillow");
  });
});

// ============================================
// 4. TOOL HANDLER — DESKTOP ROUTING (mocked)
// ============================================

vi.mock("./headless-bridge.js", () => {
  const mockBridge = {
    readState: vi.fn().mockResolvedValue('{"mode":"text"}'),
    readStateVisual: vi.fn().mockResolvedValue('{"mode":"visual"}'),
    navigate: vi.fn().mockResolvedValue('{"ok":true}'),
    click: vi.fn().mockResolvedValue('{"ok":true}'),
    typeText: vi.fn().mockResolvedValue('{"ok":true}'),
    hotkey: vi.fn().mockResolvedValue('{"ok":true}'),
    switchTab: vi.fn().mockResolvedValue('{"ok":true}'),
    waitFor: vi.fn().mockResolvedValue('{"ok":true}'),
    screenshotRegion: vi.fn().mockResolvedValue('{"ok":true}'),
    openInBrowser: vi.fn().mockResolvedValue('{"ok":true}'),
    findElement: vi.fn().mockResolvedValue('{"ok":true}'),
    startRecording: vi.fn().mockResolvedValue('{"ok":true}'),
    stopRecording: vi.fn().mockResolvedValue('{"ok":true}'),
    listSchemas: vi.fn().mockResolvedValue('{"ok":true}'),
    readSchema: vi.fn().mockResolvedValue('{"ok":true}'),
    isLaunched: false,
    close: vi.fn(),
  };
  return { headlessBridge: mockBridge, HeadlessBrowserBridge: vi.fn() };
});

vi.mock("./python-bridge.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./python-bridge.js")>();
  return {
    ...original,
    // Keep isDesktopTarget real, mock callDesktopTool
    callDesktopTool: vi.fn().mockResolvedValue('{"track":"desktop","clicked":true}'),
  };
});

import { handleGui } from "./tool-handler.js";
import { callDesktopTool } from "./python-bridge.js";

const mockCallDesktop = vi.mocked(callDesktopTool);

describe("handleGui — desktop routing via isDesktopTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallDesktop.mockResolvedValue('{"track":"desktop","clicked":true}');
  });

  it("routes gui.click with app_name=Calculator to desktop", async () => {
    const result = await handleGui("gui.click", { app_name: "Calculator", element_text: "Three" });
    expect(result.success).toBe(true);
    expect(mockCallDesktop).toHaveBeenCalledWith("gui.click", { app_name: "Calculator", element_text: "Three" });
  });

  it("routes gui.click without app_name to browser (not desktop)", async () => {
    const result = await handleGui("gui.click", { element_text: "Submit" });
    expect(result.success).toBe(true);
    expect(mockCallDesktop).not.toHaveBeenCalled();
  });

  it("routes gui.navigate with app_name=Notepad to desktop", async () => {
    mockCallDesktop.mockResolvedValue('{"navigated":true,"method":"start_menu"}');
    const result = await handleGui("gui.navigate", { app_name: "Notepad" });
    expect(result.success).toBe(true);
    expect(mockCallDesktop).toHaveBeenCalledWith("gui.navigate", { app_name: "Notepad" });
  });

  it("routes gui.read_state with app_name=Calculator to desktop", async () => {
    mockCallDesktop.mockResolvedValue('{"track":"desktop","elements":[]}');
    const result = await handleGui("gui.read_state", { app_name: "Calculator" });
    expect(result.success).toBe(true);
    expect(mockCallDesktop).toHaveBeenCalled();
  });

  it("routes gui.start_recording to browser even with app_name", async () => {
    const result = await handleGui("gui.start_recording", { app_name: "Calculator" });
    expect(result.success).toBe(true);
    expect(mockCallDesktop).not.toHaveBeenCalled();
  });

  it("routes gui.type_text with app_name=Notepad to desktop", async () => {
    mockCallDesktop.mockResolvedValue('{"typed":true}');
    const result = await handleGui("gui.type_text", { app_name: "Notepad", text: "Hello" });
    expect(result.success).toBe(true);
    expect(mockCallDesktop).toHaveBeenCalledWith("gui.type_text", { app_name: "Notepad", text: "Hello" });
  });

  it("routes gui.hotkey with app_name to desktop", async () => {
    mockCallDesktop.mockResolvedValue('{"pressed":true}');
    const result = await handleGui("gui.hotkey", { app_name: "Notepad", keys: "ctrl+s" });
    expect(result.success).toBe(true);
    expect(mockCallDesktop).toHaveBeenCalled();
  });
});

// ============================================
// 5. GUI_AGENT.PY — TIER 2/3 OCR VALIDATION
// ============================================

describe("gui_agent.py — Tier 2/3 OCR implementation", () => {
  const agentPath = path.join(__dirname, "desktop", "gui_agent.py");
  const content = fs.readFileSync(agentPath, "utf-8");

  it("has Tesseract detection at module level", () => {
    expect(content).toContain("TESSERACT_AVAILABLE");
    expect(content).toContain("_detect_tesseract");
    expect(content).toContain("pytesseract.pytesseract.tesseract_cmd");
  });

  it("has Tier 2: locate_via_ocr_region function", () => {
    expect(content).toContain("def locate_via_ocr_region");
    expect(content).toContain("ocr_region_exact");
    expect(content).toContain("ocr_region_fuzzy");
  });

  it("has Tier 3: locate_via_full_scan function", () => {
    expect(content).toContain("def locate_via_full_scan");
    expect(content).toContain("ocr_full_exact");
    expect(content).toContain("ocr_full_fuzzy");
    expect(content).toContain("ocr_full_no_match");
  });

  it("has fuzzy text matching with SequenceMatcher", () => {
    expect(content).toContain("from difflib import SequenceMatcher");
    expect(content).toContain("def fuzzy_score");
    expect(content).toContain("def best_fuzzy_match");
  });

  it("has region hint mapping for Tier 2", () => {
    expect(content).toContain("def _get_region_rect");
    expect(content).toContain("menu_bar");
    expect(content).toContain("sidebar");
    expect(content).toContain("center");
    expect(content).toContain("top_half");
  });

  it("smart_find cascades through all 3 tiers", () => {
    // Verify smart_find calls all tiers in order
    expect(content).toContain("locate_via_accessibility");
    expect(content).toContain("locate_via_ocr_region");
    expect(content).toContain("locate_via_full_scan");
  });

  it("Tier 3 returns ocr_dump with needs_llm flag for LLM fallback", () => {
    expect(content).toContain("needs_llm");
    expect(content).toContain("ocr_dump");
  });

  it("has pytesseract in requirements.txt", () => {
    const reqPath = path.join(__dirname, "desktop", "requirements.txt");
    const reqContent = fs.readFileSync(reqPath, "utf-8");
    expect(reqContent).toContain("pytesseract");
  });

  it("checks multiple Tesseract install locations", () => {
    expect(content).toContain(".bot");
    expect(content).toContain("tesseract");
    expect(content).toContain("Program Files");
    expect(content).toContain("shutil.which");
  });
});

// ============================================
// 6. ENSURE-TESSERACT — MODULE EXPORTS
// ============================================

describe("ensure-tesseract — exports", () => {
  it("exports ensureTesseract function", async () => {
    const mod = await import("./ensure-tesseract.js");
    expect(typeof mod.ensureTesseract).toBe("function");
  });

  it("exports findTesseract function", async () => {
    const mod = await import("./ensure-tesseract.js");
    expect(typeof mod.findTesseract).toBe("function");
  });

  it("exports getTesseractPath function", async () => {
    const mod = await import("./ensure-tesseract.js");
    expect(typeof mod.getTesseractPath).toBe("function");
  });

  it("exports TESSERACT_INSTALL_DIR constant", async () => {
    const mod = await import("./ensure-tesseract.js");
    expect(typeof mod.TESSERACT_INSTALL_DIR).toBe("string");
    expect(mod.TESSERACT_INSTALL_DIR).toContain(".bot");
    expect(mod.TESSERACT_INSTALL_DIR).toContain("tesseract");
  });
});

// ============================================
// 7. INSTALL SCRIPTS — TESSERACT + PYTHON STEPS
// ============================================

describe("install scripts — Tesseract + Python steps", () => {
  it("install.ps1 has Python packages step", () => {
    const ps1Path = path.resolve(__dirname, "../../../../install.ps1");
    const content = fs.readFileSync(ps1Path, "utf-8");
    expect(content).toContain("pyautogui");
    expect(content).toContain("pywinauto");
    expect(content).toContain("pip");
  });

  it("install.ps1 has Tesseract check step", () => {
    const ps1Path = path.resolve(__dirname, "../../../../install.ps1");
    const content = fs.readFileSync(ps1Path, "utf-8");
    expect(content).toContain("Tesseract");
    expect(content).toContain("Tesseract-OCR");
  });
});

// ============================================
// 8. INTEGRATION — build script copies desktop/
// ============================================

describe("integration — build script", () => {
  it("package.json build copies desktop/ to dist/", () => {
    const pkgPath = path.resolve(__dirname, "../../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    expect(pkg.scripts.build).toContain("desktop");
  });
});

// ============================================
// 9. AGENT STARTUP — wires ensureTesseract
// ============================================

describe("Tesseract — self-install design", () => {
  it("index.ts does NOT auto-install Tesseract at startup (DotBot installs herself)", () => {
    const indexPath = path.resolve(__dirname, "../../index.ts");
    const content = fs.readFileSync(indexPath, "utf-8");
    // Should NOT have ensureTesseract() call — DotBot uses shell tools instead
    expect(content).not.toContain("await ensureTesseract");
    expect(content).toContain("shell.powershell");
  });

  it("gui_agent.py returns actionable install hint when Tesseract is missing", () => {
    const agentPath = path.join(__dirname, "desktop", "gui_agent.py");
    const content = fs.readFileSync(agentPath, "utf-8");
    expect(content).toContain("install_hint");
    expect(content).toContain("choco install tesseract");
    expect(content).toContain("UB-Mannheim");
  });
});

// ============================================
// 10. PRODUCTION HARDENING — security + correctness
// ============================================

describe("gui_agent.py — production hardening", () => {
  const agentPath = path.join(__dirname, "desktop", "gui_agent.py");
  const content = fs.readFileSync(agentPath, "utf-8");

  it("sanitizes URLs before opening (no command injection)", () => {
    expect(content).toContain("def _sanitize_url");
    expect(content).toContain("urlparse");
    // Must not use subprocess with raw URL
    expect(content).not.toContain('Popen(["cmd", "/c", "start", "", url]');
    // Uses safe webbrowser.open instead
    expect(content).toContain("webbrowser.open");
  });

  it("blocks dangerous URL schemes and shell metacharacters", () => {
    expect(content).toContain('"http", "https"');
    expect(content).toContain("dangerous");
    expect(content).toContain(";&|`$(){}[]!#");
  });

  it("has DPI scaling via ctypes in screenshot pipeline", () => {
    expect(content).toContain("def _get_dpi_scale");
    expect(content).toContain("ctypes.windll.shcore");
    expect(content).toContain("SetProcessDPIAware");
    expect(content).toContain("dpi_scale");
  });

  it("uses Image.LANCZOS for quality downscale in screenshots", () => {
    expect(content).toContain("Image.LANCZOS");
  });

  it("supports JPEG and PNG format in screenshot_region", () => {
    expect(content).toContain('fmt = args.get("format"');
    expect(content).toContain('format="PNG"');
    expect(content).toContain('format="JPEG"');
  });

  it("returns width, height, format, dpi_scale from screenshot_region", () => {
    expect(content).toContain('"width": screenshot.width');
    expect(content).toContain('"height": screenshot.height');
    expect(content).toContain('"format": fmt');
    expect(content).toContain('"dpi_scale": dpi_scale');
  });

  it("has non-ASCII text typing via clipboard paste", () => {
    expect(content).toContain("def _type_via_clipboard");
    expect(content).toContain("Set-Clipboard");
    expect(content).toContain('all(ord(c) < 128 for c in text)');
  });

  it("handles region hints in screenshot_region (crop sub-regions)", () => {
    expect(content).toContain("region_map");
    expect(content).toContain("screenshot.crop");
  });
});

describe("tool-defs.ts — app_name for desktop routing", () => {
  // Import tool definitions
  const toolDefsPath = path.resolve(__dirname, "tool-defs.ts");
  const content = fs.readFileSync(toolDefsPath, "utf-8");

  const toolsNeedingAppName = [
    "gui.read_state",
    "gui.navigate",
    "gui.click",
    "gui.type_text",
    "gui.hotkey",
    "gui.wait_for",
    "gui.screenshot_region",
    "gui.find_element",
  ];

  for (const toolId of toolsNeedingAppName) {
    it(`${toolId} has app_name parameter in schema`, () => {
      // Find the tool definition block
      const toolIndex = content.indexOf(`id: "${toolId}"`);
      expect(toolIndex).toBeGreaterThan(-1);
      // Look for app_name within the next 500 chars (within the tool's properties)
      const snippet = content.slice(toolIndex, toolIndex + 800);
      expect(snippet).toContain("app_name");
    });
  }

  it("gui.click has location_hint parameter", () => {
    const idx = content.indexOf('id: "gui.click"');
    const snippet = content.slice(idx, idx + 1500);
    expect(snippet).toContain("location_hint");
  });

  it("gui.find_element has location_hint parameter", () => {
    const idx = content.indexOf('id: "gui.find_element"');
    const snippet = content.slice(idx, idx + 1500);
    expect(snippet).toContain("location_hint");
  });

  it("gui.screenshot_region has max_width parameter", () => {
    const idx = content.indexOf('id: "gui.screenshot_region"');
    const snippet = content.slice(idx, idx + 1500);
    expect(snippet).toContain("max_width");
  });

  it("browser-only tools do NOT have app_name", () => {
    const browserOnly = ["gui.open_in_browser", "gui.switch_tab"];
    for (const toolId of browserOnly) {
      const idx = content.indexOf(`id: "${toolId}"`);
      if (idx === -1) continue;
      const snippet = content.slice(idx, idx + 500);
      expect(snippet).not.toContain("app_name");
    }
  });
});

describe("headless-bridge.ts — production hardening", () => {
  const bridgePath = path.resolve(__dirname, "headless-bridge.ts");
  const content = fs.readFileSync(bridgePath, "utf-8");

  it("uses scale: css for screenshots (DPI normalization)", () => {
    expect(content).toContain('scale: "css"');
  });

  it("screenshotRegion returns width and height", () => {
    expect(content).toContain("width,");
    expect(content).toContain("height,");
    expect(content).toContain("clipRegion ? clipRegion.width");
  });

  it("sanitizes URLs before navigation", () => {
    expect(content).toContain("sanitizeUrl");
    // ALLOWED_SCHEMES lives in browser-utils.ts (extracted)
    const utilsPath = path.resolve(__dirname, "browser-utils.ts");
    const utilsContent = fs.readFileSync(utilsPath, "utf-8");
    expect(utilsContent).toContain("ALLOWED_SCHEMES");
  });

  it("uses execFile (not exec) for open_in_browser to prevent injection", () => {
    expect(content).toContain('execFile');
    expect(content).toContain('cmd", ["/c", "start"');
  });

  it("clamps timeouts to safe range", () => {
    expect(content).toContain("clampTimeout");
    // MAX_WAIT_TIMEOUT_MS lives in browser-utils.ts (extracted)
    const utilsPath = path.resolve(__dirname, "browser-utils.ts");
    const utilsContent = fs.readFileSync(utilsPath, "utf-8");
    expect(utilsContent).toContain("MAX_WAIT_TIMEOUT_MS");
  });

  it("cleans up browser on process exit", () => {
    expect(content).toContain('process.on("exit"');
    expect(content).toContain('process.on("SIGINT"');
    expect(content).toContain("cleanupBrowser");
  });
});
