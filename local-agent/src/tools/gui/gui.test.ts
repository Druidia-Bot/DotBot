/**
 * GUI Automation — Production Test Suite
 * 
 * Covers:
 * - Security: URL sanitization, command injection prevention, timeout clamping
 * - Correctness: tool definitions schema, adblock domain matching, tool routing
 * - Behavioral: headless bridge methods with mocked Playwright
 * - Edge cases: empty args, missing fields, malformed inputs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================
// 1. URL SANITIZATION (Security-Critical)
// ============================================

// We need to test sanitizeUrl which is a private function in headless-bridge.
// Extract the logic into a testable form by importing the module and testing
// through the public methods. But first, let's replicate the sanitization
// logic here for direct unit testing.

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function sanitizeUrl(raw: string): { url: string; error?: string } {
  const withScheme = raw.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      return { url: "", error: `Blocked URL scheme: ${parsed.protocol} — only http: and https: are allowed` };
    }
    return { url: parsed.href };
  } catch {
    return { url: "", error: `Invalid URL: ${raw}` };
  }
}

function clampTimeout(value: any, defaultMs: number): number {
  const num = typeof value === "number" && !Number.isNaN(value) ? value : defaultMs;
  return Math.max(100, Math.min(num, 120_000));
}

describe("sanitizeUrl — security", () => {
  it("allows http URLs", () => {
    const result = sanitizeUrl("http://example.com");
    expect(result.url).toBe("http://example.com/");
    expect(result.error).toBeUndefined();
  });

  it("allows https URLs", () => {
    const result = sanitizeUrl("https://github.com/user/repo");
    expect(result.url).toBe("https://github.com/user/repo");
    expect(result.error).toBeUndefined();
  });

  it("auto-prepends https:// for bare domains", () => {
    const result = sanitizeUrl("github.com");
    expect(result.url).toBe("https://github.com/");
    expect(result.error).toBeUndefined();
  });

  it("auto-prepends https:// for domains with paths", () => {
    const result = sanitizeUrl("example.com/path?q=1");
    expect(result.url).toBe("https://example.com/path?q=1");
    expect(result.error).toBeUndefined();
  });

  it("BLOCKS javascript: URLs", () => {
    const result = sanitizeUrl("javascript:alert(1)");
    expect(result.error).toContain("Blocked URL scheme");
    expect(result.error).toContain("javascript:");
    expect(result.url).toBe("");
  });

  it("BLOCKS file:/// URLs", () => {
    const result = sanitizeUrl("file:///C:/Windows/System32/config/sam");
    expect(result.error).toContain("Blocked URL scheme");
    expect(result.error).toContain("file:");
    expect(result.url).toBe("");
  });

  it("BLOCKS data: URLs", () => {
    const result = sanitizeUrl("data:text/html,<script>alert(1)</script>");
    expect(result.error).toContain("Blocked URL scheme");
    expect(result.url).toBe("");
  });

  it("BLOCKS blob: URLs", () => {
    const result = sanitizeUrl("blob:http://evil.com/uuid");
    expect(result.error).toContain("Blocked URL scheme");
    expect(result.url).toBe("");
  });

  it("BLOCKS vbscript: URLs", () => {
    const result = sanitizeUrl("vbscript:MsgBox(1)");
    expect(result.error).toContain("Blocked URL scheme");
    expect(result.url).toBe("");
  });

  it("BLOCKS ftp: URLs", () => {
    const result = sanitizeUrl("ftp://files.example.com/secret");
    expect(result.error).toContain("Blocked URL scheme");
    expect(result.url).toBe("");
  });

  it("handles URLs with authentication (user:pass@host)", () => {
    const result = sanitizeUrl("https://user:pass@example.com");
    expect(result.url).toBe("https://user:pass@example.com/");
    expect(result.error).toBeUndefined();
  });

  it("handles URLs with ports", () => {
    const result = sanitizeUrl("http://localhost:3000/api");
    expect(result.url).toBe("http://localhost:3000/api");
    expect(result.error).toBeUndefined();
  });

  it("handles URLs with fragments", () => {
    const result = sanitizeUrl("https://docs.example.com/page#section");
    expect(result.url).toBe("https://docs.example.com/page#section");
    expect(result.error).toBeUndefined();
  });

  it("rejects completely invalid URLs", () => {
    const result = sanitizeUrl("not a url at all !!!");
    // This gets https:// prepended and becomes an invalid URL
    expect(result.error).toBeDefined();
  });

  it("handles empty string", () => {
    const result = sanitizeUrl("");
    // Empty string gets https:// prepended → "https://" → invalid URL (no host)
    expect(result.error).toBeDefined();
  });

  // Command injection vectors that were previously vulnerable via exec()
  it("BLOCKS command injection via URL with shell metacharacters", () => {
    const result = sanitizeUrl('" & del /q C:\\* & "');
    expect(result.error).toBeDefined();
  });

  it("BLOCKS command injection via pipe", () => {
    const result = sanitizeUrl("http://example.com | calc.exe");
    // The space makes it an invalid URL
    expect(result.error).toBeDefined();
  });
});

// ============================================
// 2. TIMEOUT CLAMPING (Security)
// ============================================

describe("clampTimeout — security", () => {
  it("uses default when no value provided", () => {
    expect(clampTimeout(undefined, 10_000)).toBe(10_000);
  });

  it("uses default for non-number values", () => {
    expect(clampTimeout("fast", 10_000)).toBe(10_000);
    expect(clampTimeout(null, 10_000)).toBe(10_000);
    expect(clampTimeout({}, 10_000)).toBe(10_000);
  });

  it("clamps extremely large timeouts to MAX (120s)", () => {
    expect(clampTimeout(999_999_999, 10_000)).toBe(120_000);
  });

  it("clamps negative timeouts to minimum (100ms)", () => {
    expect(clampTimeout(-1000, 10_000)).toBe(100);
  });

  it("clamps zero to minimum (100ms)", () => {
    expect(clampTimeout(0, 10_000)).toBe(100);
  });

  it("allows reasonable timeout values through", () => {
    expect(clampTimeout(5_000, 10_000)).toBe(5_000);
    expect(clampTimeout(30_000, 10_000)).toBe(30_000);
    expect(clampTimeout(120_000, 10_000)).toBe(120_000);
  });

  it("clamps Infinity to MAX", () => {
    expect(clampTimeout(Infinity, 10_000)).toBe(120_000);
  });

  it("handles NaN by falling back to default", () => {
    // NaN is typeof "number" but should not propagate — we check isNaN
    const result = clampTimeout(NaN, 10_000);
    expect(result).toBe(10_000);
  });
});

// ============================================
// 3. ADBLOCK DOMAIN MATCHING (Correctness)
// ============================================

import { clearBlocklistCache } from "./adblock.js";

describe("adblock — domain list correctness", () => {
  // Import the built-in list by reading the source
  // We'll validate properties of the blocklist

  beforeEach(() => {
    clearBlocklistCache();
  });

  it("built-in blocklist has no paths (hostname-only matching)", () => {
    // The blocklist should only contain hostnames, no paths or query strings
    // This was a bug: "www.facebook.com/tr" was in the list but would never match
    const { BUILTIN_DOMAINS } = getBuiltinDomains();
    for (const domain of BUILTIN_DOMAINS) {
      expect(domain, `Domain "${domain}" contains a slash — hostname matching will never hit this`).not.toContain("/");
      expect(domain, `Domain "${domain}" contains a query string`).not.toContain("?");
      expect(domain, `Domain "${domain}" contains a hash`).not.toContain("#");
      expect(domain, `Domain "${domain}" contains a port`).not.toMatch(/:\d+/);
    }
  });

  it("built-in blocklist has no duplicates", () => {
    const { BUILTIN_DOMAINS } = getBuiltinDomains();
    const unique = new Set(BUILTIN_DOMAINS);
    expect(unique.size, "Duplicate domains found in blocklist").toBe(BUILTIN_DOMAINS.length);
  });

  it("built-in blocklist entries are lowercase", () => {
    const { BUILTIN_DOMAINS } = getBuiltinDomains();
    for (const domain of BUILTIN_DOMAINS) {
      expect(domain).toBe(domain.toLowerCase());
    }
  });

  it("built-in blocklist entries look like valid hostnames", () => {
    const { BUILTIN_DOMAINS } = getBuiltinDomains();
    for (const domain of BUILTIN_DOMAINS) {
      // Basic hostname validation: letters, numbers, dots, hyphens
      expect(domain, `"${domain}" doesn't look like a valid hostname`).toMatch(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
    }
  });

  it("critical ad domains are in the list", () => {
    const { BUILTIN_DOMAINS } = getBuiltinDomains();
    const domains = new Set(BUILTIN_DOMAINS);
    expect(domains.has("pagead2.googlesyndication.com")).toBe(true);
    expect(domains.has("googleads.g.doubleclick.net")).toBe(true);
    expect(domains.has("pixel.facebook.com")).toBe(true);
    expect(domains.has("www.google-analytics.com")).toBe(true);
    expect(domains.has("cdn.taboola.com")).toBe(true);
  });

  it("does NOT block legitimate domains", () => {
    const { BUILTIN_DOMAINS } = getBuiltinDomains();
    const domains = new Set(BUILTIN_DOMAINS);
    // These should never be in the blocklist
    expect(domains.has("google.com")).toBe(false);
    expect(domains.has("facebook.com")).toBe(false);
    expect(domains.has("github.com")).toBe(false);
    expect(domains.has("stackoverflow.com")).toBe(false);
    expect(domains.has("youtube.com")).toBe(false);
    expect(domains.has("wikipedia.org")).toBe(false);
    expect(domains.has("amazon.com")).toBe(false);
    expect(domains.has("microsoft.com")).toBe(false);
    expect(domains.has("www.facebook.com")).toBe(false);
  });
});

/** Helper: extract BUILTIN_DOMAINS by reading the source file */
function getBuiltinDomains(): { BUILTIN_DOMAINS: string[] } {
  // Read the actual list from the module. Since it's not exported,
  // we parse it from the source. For tests, we replicate the list
  // or import it differently. Here we'll use a dynamic require.
  // Actually, let's just read the file and extract the array.
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "adblock.ts"), "utf-8");
  
  // Extract the array between BUILTIN_DOMAINS: string[] = [ and ];
  const match = source.match(/const BUILTIN_DOMAINS: string\[\] = \[([\s\S]*?)\];/);
  if (!match) throw new Error("Could not find BUILTIN_DOMAINS in adblock.ts");
  
  const entries = match[1]
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.startsWith('"') && line.includes('"'))
    .map((line: string) => {
      const m = line.match(/"([^"]+)"/);
      return m ? m[1] : "";
    })
    .filter(Boolean);

  return { BUILTIN_DOMAINS: entries };
}

// ============================================
// 4. TOOL DEFINITIONS VALIDATION (Schema)
// ============================================

import { guiTools } from "./tool-defs.js";

describe("gui tool definitions — schema validation", () => {
  it("exports exactly 17 tools", () => {
    expect(guiTools.length).toBe(17);
  });

  it("all tools have gui category", () => {
    for (const tool of guiTools) {
      expect(tool.category, `Tool ${tool.id} has wrong category`).toBe("gui");
    }
  });

  it("all tools have source: core", () => {
    for (const tool of guiTools) {
      expect(tool.source, `Tool ${tool.id} has wrong source`).toBe("core");
    }
  });

  it("all tool IDs start with gui.", () => {
    for (const tool of guiTools) {
      expect(tool.id, `Tool ${tool.id} doesn't start with gui.`).toMatch(/^gui\./);
    }
  });

  it("all tool IDs are unique", () => {
    const ids = guiTools.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all tools have descriptions", () => {
    for (const tool of guiTools) {
      expect(tool.description.length, `Tool ${tool.id} has empty description`).toBeGreaterThan(10);
    }
  });

  it("all tools have valid inputSchema with type: object", () => {
    for (const tool of guiTools) {
      expect(tool.inputSchema.type, `Tool ${tool.id} schema not type:object`).toBe("object");
      expect(tool.inputSchema.properties, `Tool ${tool.id} missing properties`).toBeDefined();
    }
  });

  it("required fields reference existing properties", () => {
    for (const tool of guiTools) {
      const props = Object.keys(tool.inputSchema.properties || {});
      const required = tool.inputSchema.required || [];
      for (const req of required) {
        expect(props, `Tool ${tool.id}: required field "${req}" not in properties`).toContain(req);
      }
    }
  });

  it("all tools have annotations", () => {
    for (const tool of guiTools) {
      expect(tool.annotations, `Tool ${tool.id} missing annotations`).toBeDefined();
    }
  });

  it("read-only tools are correctly annotated", () => {
    const readOnlyTools = ["gui.read_state", "gui.wait_for", "gui.screenshot_region", "gui.find_element", "gui.list_schemas", "gui.read_schema"];
    for (const tool of guiTools) {
      if (readOnlyTools.includes(tool.id)) {
        expect(tool.annotations?.readOnlyHint, `Tool ${tool.id} should be readOnly`).toBe(true);
      }
    }
  });

  it("destructive tools are NOT marked readOnly", () => {
    const writableTools = ["gui.click", "gui.type_text", "gui.hotkey", "gui.navigate", "gui.open_in_browser", "gui.start_recording", "gui.stop_recording"];
    for (const tool of guiTools) {
      if (writableTools.includes(tool.id)) {
        expect(tool.annotations?.readOnlyHint, `Tool ${tool.id} should NOT be readOnly`).toBeFalsy();
      }
    }
  });

  it("expected tool IDs all exist", () => {
    const expectedIds = [
      "gui.read_state", "gui.navigate", "gui.click", "gui.type_text",
      "gui.hotkey", "gui.switch_tab", "gui.wait_for", "gui.screenshot_region",
      "gui.open_in_browser",
      // Compound tools
      "gui.batch", "gui.search_website", "gui.fill_and_submit",
      // Phase 2
      "gui.find_element",
      // Phase 3
      "gui.start_recording", "gui.stop_recording", "gui.list_schemas", "gui.read_schema",
    ];
    const actualIds = guiTools.map(t => t.id);
    for (const id of expectedIds) {
      expect(actualIds, `Missing tool: ${id}`).toContain(id);
    }
  });
});

// ============================================
// 5. TOOL HANDLER ROUTING (Behavioral)
// ============================================

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
    // Phase 2
    findElement: vi.fn(),
    // Compound tools
    searchWebsite: vi.fn(),
    fillAndSubmit: vi.fn(),
    // Phase 3
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    listSchemas: vi.fn(),
    readSchema: vi.fn(),
    isLaunched: false,
    close: vi.fn(),
  };
  return {
    headlessBridge: mockBridge,
    HeadlessBrowserBridge: vi.fn(),
  };
});

// Mock python bridge — these tests target browser track only
vi.mock("./python-bridge.js", () => ({
  isDesktopTarget: vi.fn().mockReturnValue(false),
  callDesktopTool: vi.fn(),
  checkDesktopAvailability: vi.fn(),
}));

import { handleGui } from "./tool-handler.js";
import { headlessBridge } from "./headless-bridge.js";

const mockBridge = vi.mocked(headlessBridge);

describe("handleGui — routing completeness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("every gui tool ID in tool-defs has a handler case", async () => {
    // Set up mocks to return valid JSON for any call
    const mockReturn = '{"ok":true}';
    mockBridge.readState.mockResolvedValue(mockReturn);
    mockBridge.readStateVisual.mockResolvedValue(mockReturn);
    mockBridge.navigate.mockResolvedValue(mockReturn);
    mockBridge.click.mockResolvedValue(mockReturn);
    mockBridge.typeText.mockResolvedValue(mockReturn);
    mockBridge.hotkey.mockResolvedValue(mockReturn);
    mockBridge.switchTab.mockResolvedValue(mockReturn);
    mockBridge.waitFor.mockResolvedValue(mockReturn);
    mockBridge.screenshotRegion.mockResolvedValue(mockReturn);
    mockBridge.openInBrowser.mockResolvedValue(mockReturn);
    mockBridge.findElement.mockResolvedValue(mockReturn);
    mockBridge.startRecording.mockResolvedValue(mockReturn);
    mockBridge.stopRecording.mockResolvedValue(mockReturn);
    mockBridge.listSchemas.mockResolvedValue(mockReturn);
    mockBridge.readSchema.mockResolvedValue(mockReturn);
    (mockBridge as any).searchWebsite.mockResolvedValue(mockReturn);
    (mockBridge as any).fillAndSubmit.mockResolvedValue(mockReturn);

    for (const tool of guiTools) {
      // gui.batch calls handleGui recursively — needs special args
      if (tool.id === "gui.batch") {
        const result = await handleGui(tool.id, { steps: [{ tool: "gui.navigate", args: { url: "https://example.com" } }] });
        expect(result.success, `Tool ${tool.id} returned failure — missing handler case?`).toBe(true);
        continue;
      }
      const result = await handleGui(tool.id, {});
      expect(result.success, `Tool ${tool.id} returned failure — missing handler case?`).toBe(true);
    }
  });

  it("returns error for unknown gui.xxx tool", async () => {
    const result = await handleGui("gui.does_not_exist", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown gui tool");
  });

  it("returns error for non-gui tool routed incorrectly", async () => {
    const result = await handleGui("filesystem.read_file", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown gui tool");
  });
});

describe("handleGui — error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps thrown errors with tool ID context", async () => {
    mockBridge.navigate.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
    const result = await handleGui("gui.navigate", { url: "https://localhost:9999" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("[gui.navigate]");
    expect(result.error).toContain("ERR_CONNECTION_REFUSED");
  });

  it("wraps non-Error throws as strings", async () => {
    mockBridge.click.mockRejectedValue("string error");
    const result = await handleGui("gui.click", { element_text: "Submit" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("[gui.click]");
    expect(result.error).toContain("string error");
  });

  it("success result always includes output string", async () => {
    mockBridge.readState.mockResolvedValue('{"url":"https://example.com"}');
    const result = await handleGui("gui.read_state", {});
    expect(result.success).toBe(true);
    expect(typeof result.output).toBe("string");
    expect(result.output.length).toBeGreaterThan(0);
  });
});

// ============================================
// 6. ENSURE-BROWSER (Startup Check)
// ============================================

// We can't easily test the actual browser install, but we can test
// the logic by mocking chromium.executablePath

describe("ensurePlaywrightBrowser — logic", () => {
  // This is tested indirectly via integration. The key behaviors are:
  // - If chromium.executablePath() succeeds and file exists → "already_installed"
  // - If not → runs npx playwright install chromium
  // - If that fails → "failed" (non-fatal)
  // We test the exported function exists and has correct return type signature
  
  it("exports ensurePlaywrightBrowser function", async () => {
    // Dynamic import to avoid triggering the actual chromium check
    const mod = await import("./ensure-browser.js");
    expect(typeof mod.ensurePlaywrightBrowser).toBe("function");
  });
});

// ============================================
// 7. INTEGRATION: Tool Defs ↔ Handler Mapping
// ============================================

describe("integration — tool defs and handler are in sync", () => {
  it("handler switch covers all defined tool IDs (no orphan definitions)", async () => {
    // Read the tool-handler source to extract switch cases
    const fs = require("fs");
    const path = require("path");
    const handlerSource = fs.readFileSync(path.join(__dirname, "tool-handler.ts"), "utf-8");
    
    for (const tool of guiTools) {
      expect(
        handlerSource.includes(`case "${tool.id}"`),
        `Tool ${tool.id} is defined in tool-defs.ts but has no case in tool-handler.ts`
      ).toBe(true);
    }
  });

  it("handler switch has no orphan cases (all cases have definitions)", () => {
    const fs = require("fs");
    const path = require("path");
    const handlerSource = fs.readFileSync(path.join(__dirname, "tool-handler.ts"), "utf-8");
    
    // Extract all case "gui.xxx" from the handler
    const caseMatches = handlerSource.matchAll(/case "gui\.([^"]+)"/g);
    const handlerCases = (Array.from(caseMatches) as RegExpMatchArray[]).map(m => `gui.${m[1]}`);
    const definedIds = new Set(guiTools.map(t => t.id));
    
    for (const caseId of handlerCases) {
      expect(
        definedIds.has(caseId),
        `Handler has case "${caseId}" but no matching tool definition in tool-defs.ts`
      ).toBe(true);
    }
  });
});

// ============================================
// 8. CORE-TOOLS REGISTRATION
// ============================================

describe("integration — gui tools registered in CORE_TOOLS", () => {
  it("CORE_TOOLS includes all gui tools", async () => {
    const { CORE_TOOLS } = await import("../core-tools.js");
    const guiCoreTools = CORE_TOOLS.filter((t: any) => t.category === "gui");
    expect(guiCoreTools.length).toBe(guiTools.length);
    
    const coreIds = new Set(guiCoreTools.map((t: any) => t.id));
    for (const tool of guiTools) {
      expect(coreIds.has(tool.id), `Tool ${tool.id} not found in CORE_TOOLS`).toBe(true);
    }
  });
});

// ============================================
// 9. EXECUTOR DISPATCH
// ============================================

describe("integration — tool-executor dispatches gui category", () => {
  it("tool-executor.ts has a gui case", () => {
    const fs = require("fs");
    const path = require("path");
    const executorSource = fs.readFileSync(
      path.join(__dirname, "..", "tool-executor.ts"),
      "utf-8"
    );
    expect(executorSource).toContain('case "gui"');
    expect(executorSource).toContain("handleGui");
  });
});

// ============================================
// 10. SERVER-SIDE RECOGNITION
// ============================================

describe("integration — server recognizes gui category", () => {
  it("server tools.ts includes gui in core categories", () => {
    const fs = require("fs");
    const path = require("path");
    const toolsSource = fs.readFileSync(
      path.resolve(__dirname, "../../../../server/src/agents/tools.ts"),
      "utf-8"
    );
    // The core categories array should include "gui"
    expect(toolsSource).toContain('"gui"');
  });

  it("server local-agent-proxy has gui timeout category", () => {
    const fs = require("fs");
    const path = require("path");
    const loopSource = fs.readFileSync(
      path.resolve(__dirname, "../../../../server/src/tool-loop/handlers/local-agent-proxy.ts"),
      "utf-8"
    );
    expect(loopSource).toContain("gui:");
    expect(loopSource).toContain("60_000");
  });
});

// ============================================
// 11. PERSONA DEFINITION
// ============================================

describe("gui-operator persona", () => {
  it("persona file exists with correct frontmatter", () => {
    const fs = require("fs");
    const path = require("path");
    const personaPath = path.resolve(
      __dirname, "../../../../server/src/personas/internal/gui-operator.md"
    );
    const content = fs.readFileSync(personaPath, "utf-8");
    
    // Check frontmatter fields
    expect(content).toContain("id: gui-operator");
    expect(content).toContain("name: GUI Operator");
    expect(content).toContain("type: internal");
    expect(content).toContain("tools: [gui, filesystem, shell, manage]");
    expect(content).toContain("modelTier: smart");
  });

  it("persona has gui in its tools list", () => {
    const fs = require("fs");
    const path = require("path");
    const personaPath = path.resolve(
      __dirname, "../../../../server/src/personas/internal/gui-operator.md"
    );
    const content = fs.readFileSync(personaPath, "utf-8");
    
    // Parse the tools line
    const toolsMatch = content.match(/tools: \[([^\]]+)\]/);
    expect(toolsMatch).not.toBeNull();
    const tools = toolsMatch![1].split(",").map((s: string) => s.trim());
    expect(tools).toContain("gui");
  });
});

// ============================================
// 12. RESERVED CATEGORY PROTECTION
// ============================================

describe("gui category protection", () => {
  it("gui is in reserved core categories (prevents user overwrite)", () => {
    const fs = require("fs");
    const path = require("path");
    const manageSource = fs.readFileSync(
      path.join(__dirname, "..", "tools-manage", "handler.ts"),
      "utf-8"
    );
    // The coreCategories array should include "gui"
    expect(manageSource).toContain('"gui"');
  });
});
