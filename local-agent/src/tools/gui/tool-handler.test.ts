/**
 * GUI Tool Handler Tests
 * 
 * Tests the handleGui dispatcher and validates tool routing.
 * Uses mocked HeadlessBrowserBridge to avoid launching real browsers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the headless bridge before importing the handler
vi.mock("./headless-bridge.js", () => {
  const mockBridge = {
    readState: vi.fn(),
    readStateVisual: vi.fn(),
    navigate: vi.fn(),
    click: vi.fn(),
    typeText: vi.fn(),
    hotkey: vi.fn(),
    switchTab: vi.fn(),
    waitFor: vi.fn(),
    screenshotRegion: vi.fn(),
    openInBrowser: vi.fn(),
    findElement: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    listSchemas: vi.fn(),
    readSchema: vi.fn(),
  };
  return {
    headlessBridge: mockBridge,
    HeadlessBrowserBridge: vi.fn(),
  };
});

// Mock the python bridge — none of these tests target desktop apps
vi.mock("./python-bridge.js", () => ({
  isDesktopTarget: vi.fn().mockReturnValue(false),
  callDesktopTool: vi.fn(),
  checkDesktopAvailability: vi.fn(),
}));

import { handleGui } from "./tool-handler.js";
import { headlessBridge } from "./headless-bridge.js";

const mockBridge = vi.mocked(headlessBridge);

// ============================================
// SETUP
// ============================================

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================
// ROUTING
// ============================================

describe("handleGui — routing", () => {
  it("routes gui.read_state to bridge.readState", async () => {
    mockBridge.readState.mockResolvedValue('{"url":"https://example.com"}');

    const result = await handleGui("gui.read_state", { url: "https://example.com" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("example.com");
    expect(mockBridge.readState).toHaveBeenCalledWith({ url: "https://example.com" });
  });

  it("routes gui.navigate to bridge.navigate", async () => {
    mockBridge.navigate.mockResolvedValue('{"navigated":true,"url":"https://github.com"}');

    const result = await handleGui("gui.navigate", { url: "https://github.com" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("github.com");
    expect(mockBridge.navigate).toHaveBeenCalledWith({ url: "https://github.com" });
  });

  it("routes gui.click to bridge.click", async () => {
    mockBridge.click.mockResolvedValue('{"clicked":true}');

    const result = await handleGui("gui.click", { element_text: "Sign In" });

    expect(result.success).toBe(true);
    expect(mockBridge.click).toHaveBeenCalledWith({ element_text: "Sign In" });
  });

  it("routes gui.type_text to bridge.typeText", async () => {
    mockBridge.typeText.mockResolvedValue('{"typed":true}');

    const result = await handleGui("gui.type_text", { text: "hello", press_enter: true });

    expect(result.success).toBe(true);
    expect(mockBridge.typeText).toHaveBeenCalledWith({ text: "hello", press_enter: true });
  });

  it("routes gui.hotkey to bridge.hotkey", async () => {
    mockBridge.hotkey.mockResolvedValue('{"sent":true}');

    const result = await handleGui("gui.hotkey", { keys: "ctrl+t" });

    expect(result.success).toBe(true);
    expect(mockBridge.hotkey).toHaveBeenCalledWith({ keys: "ctrl+t" });
  });

  it("routes gui.switch_tab to bridge.switchTab", async () => {
    mockBridge.switchTab.mockResolvedValue('{"switched":true}');

    const result = await handleGui("gui.switch_tab", { title_match: "GitHub" });

    expect(result.success).toBe(true);
    expect(mockBridge.switchTab).toHaveBeenCalledWith({ title_match: "GitHub" });
  });

  it("routes gui.wait_for to bridge.waitFor", async () => {
    mockBridge.waitFor.mockResolvedValue('{"waited":true}');

    const result = await handleGui("gui.wait_for", { condition: "element_visible", target: "Dashboard" });

    expect(result.success).toBe(true);
    expect(mockBridge.waitFor).toHaveBeenCalledWith({ condition: "element_visible", target: "Dashboard" });
  });

  it("routes gui.screenshot_region to bridge.screenshotRegion", async () => {
    mockBridge.screenshotRegion.mockResolvedValue('{"image_base64":"abc"}');

    const result = await handleGui("gui.screenshot_region", { region: "top_half" });

    expect(result.success).toBe(true);
    expect(mockBridge.screenshotRegion).toHaveBeenCalledWith({ region: "top_half" });
  });

  it("routes gui.open_in_browser to bridge.openInBrowser", async () => {
    mockBridge.openInBrowser.mockResolvedValue('{"opened":true}');

    const result = await handleGui("gui.open_in_browser", { mode: "url_only" });

    expect(result.success).toBe(true);
    expect(mockBridge.openInBrowser).toHaveBeenCalledWith({ mode: "url_only" });
  });
});

// ============================================
// ERROR HANDLING
// ============================================

describe("handleGui — error handling", () => {
  it("returns error for unknown gui tool", async () => {
    const result = await handleGui("gui.nonexistent", {});

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown gui tool");
  });

  it("catches and wraps bridge exceptions", async () => {
    mockBridge.navigate.mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));

    const result = await handleGui("gui.navigate", { url: "https://doesnotexist.invalid" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("gui.navigate");
    expect(result.error).toContain("ERR_NAME_NOT_RESOLVED");
  });
});
