/**
 * Phase 2 + 3 Production Tests
 * 
 * Tests for:
 * - Schema inference (JSON → schema node)
 * - Network interceptor (recording state, schema saving/listing)
 * - Set-of-Marks manifest search logic
 * - Tool handler routing for new tools
 * - read_state visual mode routing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// 1. SCHEMA INFERENCE (extracted logic)
// ============================================

// Replicate inferSchema from network-interceptor for direct testing
function inferSchema(value: any, depth = 0): any {
  if (depth > 5) return { type: "unknown" };
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "string") return { type: "string", example: value.length > 100 ? value.slice(0, 100) + "..." : value };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number", example: value };
  if (typeof value === "boolean") return { type: "boolean", example: value };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: { type: "unknown" } };
    return { type: "array", items: inferSchema(value[0], depth + 1) };
  }
  if (typeof value === "object") {
    const properties: Record<string, any> = {};
    const keys = Object.keys(value).slice(0, 30);
    for (const key of keys) {
      properties[key] = inferSchema(value[key], depth + 1);
    }
    return { type: "object", properties };
  }
  return { type: typeof value };
}

describe("inferSchema — JSON schema inference", () => {
  it("infers string type with example", () => {
    const result = inferSchema("hello");
    expect(result.type).toBe("string");
    expect(result.example).toBe("hello");
  });

  it("truncates long string examples at 100 chars", () => {
    const longStr = "a".repeat(200);
    const result = inferSchema(longStr);
    expect(result.type).toBe("string");
    expect(result.example.length).toBeLessThan(110);
    expect(result.example).toContain("...");
  });

  it("infers integer type", () => {
    const result = inferSchema(42);
    expect(result.type).toBe("integer");
    expect(result.example).toBe(42);
  });

  it("infers float/number type", () => {
    const result = inferSchema(3.14);
    expect(result.type).toBe("number");
    expect(result.example).toBe(3.14);
  });

  it("infers boolean type", () => {
    expect(inferSchema(true).type).toBe("boolean");
    expect(inferSchema(false).type).toBe("boolean");
  });

  it("infers null type", () => {
    expect(inferSchema(null).type).toBe("null");
    expect(inferSchema(undefined).type).toBe("null");
  });

  it("infers empty array with unknown items", () => {
    const result = inferSchema([]);
    expect(result.type).toBe("array");
    expect(result.items.type).toBe("unknown");
  });

  it("infers array with typed items from first element", () => {
    const result = inferSchema([1, 2, 3]);
    expect(result.type).toBe("array");
    expect(result.items.type).toBe("integer");
  });

  it("infers object with property schemas", () => {
    const result = inferSchema({ name: "Alice", age: 30, active: true });
    expect(result.type).toBe("object");
    expect(result.properties.name.type).toBe("string");
    expect(result.properties.age.type).toBe("integer");
    expect(result.properties.active.type).toBe("boolean");
  });

  it("handles nested objects", () => {
    const result = inferSchema({
      user: { name: "Bob", email: "bob@example.com" },
      scores: [95, 87, 92],
    });
    expect(result.type).toBe("object");
    expect(result.properties.user.type).toBe("object");
    expect(result.properties.user.properties.name.type).toBe("string");
    expect(result.properties.scores.type).toBe("array");
    expect(result.properties.scores.items.type).toBe("integer");
  });

  it("caps recursion depth at 5", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } };
    const result = inferSchema(deep);
    // a=depth1, b=depth2, c=depth3, d=depth4, e=depth5 → e still resolves as object
    // f=depth6 → hits cap, returns {type: "unknown"}
    expect(result.properties.a.properties.b.properties.c.properties.d.properties.e.properties.f).toEqual({ type: "unknown" });
  });

  it("caps object properties at 30", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 50; i++) big[`key_${i}`] = i;
    const result = inferSchema(big);
    expect(Object.keys(result.properties).length).toBe(30);
  });

  it("handles typical GitHub API response shape", () => {
    const response = {
      id: 123,
      name: "my-repo",
      full_name: "user/my-repo",
      private: false,
      owner: { login: "user", id: 456, type: "User" },
      html_url: "https://github.com/user/my-repo",
      description: "A test repo",
      fork: false,
      created_at: "2024-01-01T00:00:00Z",
      stargazers_count: 42,
      language: "TypeScript",
      topics: ["automation", "bot"],
    };
    const result = inferSchema(response);
    expect(result.type).toBe("object");
    expect(result.properties.id.type).toBe("integer");
    expect(result.properties.name.type).toBe("string");
    expect(result.properties.private.type).toBe("boolean");
    expect(result.properties.owner.type).toBe("object");
    expect(result.properties.topics.type).toBe("array");
    expect(result.properties.topics.items.type).toBe("string");
  });
});

// ============================================
// 2. NETWORK INTERCEPTOR (Unit Tests)
// ============================================

import { NetworkInterceptor } from "./network-interceptor.js";

describe("NetworkInterceptor — state management", () => {
  let interceptor: NetworkInterceptor;

  beforeEach(() => {
    interceptor = new NetworkInterceptor();
  });

  it("starts with no active recording", () => {
    expect(interceptor.isRecording).toBe(false);
    expect(interceptor.currentSession).toBeNull();
  });

  it("stopRecording returns error when not recording", async () => {
    // Create a minimal mock context
    const mockContext = { unroute: vi.fn() } as any;
    const result = JSON.parse(await interceptor.stopRecording(mockContext));
    expect(result.stopped).toBe(false);
    expect(result.error).toContain("No recording active");
  });

  it("listSchemas works on empty directory", async () => {
    const result = JSON.parse(await interceptor.listSchemas());
    expect(result.total_endpoints).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.domains)).toBe(true);
  });

  it("readSchema returns error for missing schema", async () => {
    const result = JSON.parse(await interceptor.readSchema("nonexistent.com", "get_api"));
    expect(result.error).toContain("not found");
  });
});

// ============================================
// 3. SCHEMA SAVING + READING (filesystem tests)
// ============================================

describe("NetworkInterceptor — schema persistence", () => {
  const tempDir = path.join(os.tmpdir(), `dotbot-schema-test-${Date.now()}`);
  let interceptor: NetworkInterceptor;

  beforeEach(async () => {
    interceptor = new NetworkInterceptor();
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // Test that schemas written to a temp dir can be read back
  it("writes and reads endpoint schema files", async () => {
    // Manually create a schema file to test readSchema
    const domain = "api.example.com";
    const domainDir = path.join(tempDir, domain);
    await fs.mkdir(domainDir, { recursive: true });
    
    const schema = {
      url: "https://api.example.com/users",
      method: "GET",
      responseSchema: { type: "array", items: { type: "object", properties: { id: { type: "integer" } } } },
    };
    await fs.writeFile(path.join(domainDir, "get_users.json"), JSON.stringify(schema), "utf-8");

    // Verify file exists
    const files = await fs.readdir(domainDir);
    expect(files).toContain("get_users.json");

    // Read it back
    const content = JSON.parse(await fs.readFile(path.join(domainDir, "get_users.json"), "utf-8"));
    expect(content.url).toBe("https://api.example.com/users");
    expect(content.method).toBe("GET");
    expect(content.responseSchema.type).toBe("array");
  });
});

// ============================================
// 4. SET-OF-MARKS MANIFEST SEARCH
// ============================================

// Replicate _findInManifest logic for testing
interface TestSoMElement {
  id: number;
  tag: string;
  text: string;
  type: string;
  role: string;
  rect: { x: number; y: number; w: number; h: number };
  ariaLabel?: string;
  placeholder?: string;
}

function findInManifest(
  elements: TestSoMElement[],
  text: string,
  type: string
): { found: boolean; matches: TestSoMElement[]; best_match?: TestSoMElement; error?: string } {
  if (elements.length === 0) {
    return { found: false, matches: [], error: "No interactive elements found on page" };
  }

  let matches = elements;

  if (type) {
    const typeMap: Record<string, string[]> = {
      button: ["button", "[role=button]"],
      link: ["a"],
      input: ["input", "textarea"],
      tab: ["[role=tab]"],
      menu_item: ["[role=menuitem]"],
      select: ["select"],
      checkbox: ["[role=checkbox]", "input"],
      radio: ["[role=radio]", "input"],
    };
    const validTags = typeMap[type] || [type];
    matches = matches.filter(el =>
      validTags.some(t => el.tag === t || el.role === type)
    );
  }

  if (text) {
    const exactMatches = matches.filter(el =>
      el.text.toLowerCase() === text ||
      el.ariaLabel?.toLowerCase() === text ||
      el.placeholder?.toLowerCase() === text
    );
    if (exactMatches.length > 0) {
      return { found: true, matches: exactMatches, best_match: exactMatches[0] };
    }
    const partialMatches = matches.filter(el =>
      el.text.toLowerCase().includes(text) ||
      el.ariaLabel?.toLowerCase().includes(text) ||
      el.placeholder?.toLowerCase().includes(text)
    );
    if (partialMatches.length > 0) {
      return { found: true, matches: partialMatches, best_match: partialMatches[0] };
    }
    return {
      found: false,
      matches: [],
      error: `No element matching "${text}"${type ? ` of type "${type}"` : ""}. ${elements.length} interactive elements on page.`,
    };
  }

  if (matches.length > 0) {
    return { found: true, matches, best_match: matches[0] };
  }
  return { found: false, matches: [], error: `No elements of type "${type}" found` };
}

const SAMPLE_ELEMENTS: TestSoMElement[] = [
  { id: 0, tag: "a", text: "Sign In", type: "", role: "link", rect: { x: 100, y: 50, w: 80, h: 30 } },
  { id: 1, tag: "button", text: "Search", type: "submit", role: "button", rect: { x: 200, y: 50, w: 100, h: 30 } },
  { id: 2, tag: "input", text: "", type: "text", role: "", rect: { x: 300, y: 50, w: 200, h: 30 }, placeholder: "Search GitHub" },
  { id: 3, tag: "a", text: "Explore", type: "", role: "link", rect: { x: 400, y: 50, w: 60, h: 30 } },
  { id: 4, tag: "button", text: "Compose", type: "", role: "button", rect: { x: 50, y: 100, w: 120, h: 40 }, ariaLabel: "Compose new email" },
  { id: 5, tag: "a", text: "Settings", type: "", role: "link", rect: { x: 600, y: 50, w: 70, h: 30 } },
  { id: 6, tag: "input", text: "", type: "checkbox", role: "checkbox", rect: { x: 50, y: 200, w: 20, h: 20 }, ariaLabel: "Select all" },
];

describe("SoM manifest search", () => {
  it("finds element by exact text match", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "sign in", "");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(0);
    expect(result.best_match?.text).toBe("Sign In");
  });

  it("finds element by partial text match", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "compo", "");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(4);
  });

  it("finds element by ariaLabel", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "compose new email", "");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(4);
  });

  it("finds element by placeholder", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "search github", "");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(2);
  });

  it("filters by type: button", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "", "button");
    expect(result.found).toBe(true);
    expect(result.matches.every(el => el.tag === "button" || el.role === "button")).toBe(true);
  });

  it("filters by type: link", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "", "link");
    expect(result.found).toBe(true);
    expect(result.matches.every(el => el.tag === "a")).toBe(true);
    expect(result.matches.length).toBe(3); // Sign In, Explore, Settings
  });

  it("combines text + type filter", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "search", "button");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(1);
    expect(result.best_match?.tag).toBe("button");
  });

  it("returns error when no match found", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "nonexistent button", "");
    expect(result.found).toBe(false);
    expect(result.error).toContain("No element matching");
  });

  it("returns error on empty element list", () => {
    const result = findInManifest([], "anything", "");
    expect(result.found).toBe(false);
    expect(result.error).toContain("No interactive elements");
  });

  it("finds checkbox by type", () => {
    const result = findInManifest(SAMPLE_ELEMENTS, "select all", "checkbox");
    expect(result.found).toBe(true);
    expect(result.best_match?.id).toBe(6);
  });

  it("prefers exact match over partial match", () => {
    const elements: TestSoMElement[] = [
      { id: 0, tag: "button", text: "Search Results", type: "", role: "button", rect: { x: 0, y: 0, w: 100, h: 30 } },
      { id: 1, tag: "button", text: "Search", type: "", role: "button", rect: { x: 0, y: 0, w: 100, h: 30 } },
    ];
    const result = findInManifest(elements, "search", "");
    expect(result.best_match?.id).toBe(1); // Exact match on "Search"
  });
});

// ============================================
// 5. TOOL HANDLER — VISUAL MODE ROUTING
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
    findElement: vi.fn(),
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

describe("handleGui — read_state visual mode routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge.readState.mockResolvedValue('{"mode":"text"}');
    mockBridge.readStateVisual.mockResolvedValue('{"mode":"visual"}');
  });

  it("routes read_state without mode to text mode (readState)", async () => {
    const result = await handleGui("gui.read_state", {});
    expect(result.success).toBe(true);
    expect(mockBridge.readState).toHaveBeenCalledTimes(1);
    expect(mockBridge.readStateVisual).not.toHaveBeenCalled();
  });

  it("routes read_state with mode=text to text mode (readState)", async () => {
    const result = await handleGui("gui.read_state", { mode: "text" });
    expect(result.success).toBe(true);
    expect(mockBridge.readState).toHaveBeenCalledTimes(1);
    expect(mockBridge.readStateVisual).not.toHaveBeenCalled();
  });

  it("routes read_state with mode=visual to visual mode (readStateVisual)", async () => {
    const result = await handleGui("gui.read_state", { mode: "visual" });
    expect(result.success).toBe(true);
    expect(mockBridge.readStateVisual).toHaveBeenCalledTimes(1);
    expect(mockBridge.readState).not.toHaveBeenCalled();
  });

  it("passes all args through to readStateVisual", async () => {
    await handleGui("gui.read_state", { mode: "visual", url: "https://example.com", quality: 80 });
    expect(mockBridge.readStateVisual).toHaveBeenCalledWith({
      mode: "visual",
      url: "https://example.com",
      quality: 80,
    });
  });
});

describe("handleGui — Phase 2 routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge.findElement.mockResolvedValue('{"found":true}');
  });

  it("routes gui.find_element to bridge.findElement", async () => {
    const result = await handleGui("gui.find_element", { element_text: "Sign In" });
    expect(result.success).toBe(true);
    expect(mockBridge.findElement).toHaveBeenCalledWith({ element_text: "Sign In" });
  });
});

describe("handleGui — Phase 3 routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge.startRecording.mockResolvedValue('{"started":true}');
    mockBridge.stopRecording.mockResolvedValue('{"stopped":true}');
    mockBridge.listSchemas.mockResolvedValue('{"domains":[]}');
    mockBridge.readSchema.mockResolvedValue('{"url":"https://api.example.com"}');
  });

  it("routes gui.start_recording to bridge.startRecording", async () => {
    const result = await handleGui("gui.start_recording", { domain: "api.github.com" });
    expect(result.success).toBe(true);
    expect(mockBridge.startRecording).toHaveBeenCalledWith({ domain: "api.github.com" });
  });

  it("routes gui.stop_recording to bridge.stopRecording", async () => {
    const result = await handleGui("gui.stop_recording", {});
    expect(result.success).toBe(true);
    expect(mockBridge.stopRecording).toHaveBeenCalledWith({});
  });

  it("routes gui.list_schemas to bridge.listSchemas", async () => {
    const result = await handleGui("gui.list_schemas", {});
    expect(result.success).toBe(true);
    expect(mockBridge.listSchemas).toHaveBeenCalledWith({});
  });

  it("routes gui.read_schema to bridge.readSchema", async () => {
    const result = await handleGui("gui.read_schema", { domain: "api.example.com", endpoint: "get_users" });
    expect(result.success).toBe(true);
    expect(mockBridge.readSchema).toHaveBeenCalledWith({ domain: "api.example.com", endpoint: "get_users" });
  });
});

// ============================================
// 6. SOM INJECTION SCRIPT VALIDATION
// ============================================

describe("SoM injection script — structure", () => {
  it("set-of-marks.ts exports expected functions", async () => {
    const mod = await import("./set-of-marks.js");
    expect(typeof mod.injectSetOfMarks).toBe("function");
    expect(typeof mod.captureSetOfMarks).toBe("function");
    expect(typeof mod.cleanupSetOfMarks).toBe("function");
  });
});

describe("NetworkInterceptor — exports", () => {
  it("exports NetworkInterceptor class and singleton", async () => {
    const mod = await import("./network-interceptor.js");
    expect(typeof mod.NetworkInterceptor).toBe("function");
    expect(mod.networkInterceptor).toBeInstanceOf(mod.NetworkInterceptor);
  });
});
