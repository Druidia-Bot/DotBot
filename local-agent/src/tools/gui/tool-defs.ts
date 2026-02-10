/**
 * GUI Tool Definitions
 * 
 * DotBotTool[] definitions for all gui.* tools (Phase 1: Headless Browser Track).
 * Follows the same pattern as core-tools.ts — each tool has a dotted ID,
 * descriptive name, JSON Schema input, and MCP annotations.
 */

import type { DotBotTool } from "../../memory/types-tools.js";

// ============================================
// GUI TOOLS (Phase 1 — Headless Browser)
// ============================================

export const guiTools: DotBotTool[] = [
  {
    id: "gui.read_state",
    name: "gui.read_state",
    description: "Read the current state of a window or browser page. For browser: returns URL, title, open tabs, and ARIA snapshot. For desktop apps: returns the accessibility tree of the target window. Use this FIRST before interacting. Set mode='visual' for Set-of-Marks manifest + screenshot.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description: "Target application name (e.g., 'Calculator', 'Notepad', 'Word'). Omit for browser. When set to a non-browser app, routes to desktop automation.",
        },
        url: {
          type: "string",
          description: "Optional URL to navigate to before reading state. Browser track only.",
        },
        mode: {
          type: "string",
          description: "'text' (default) — ARIA/accessibility snapshot only. 'visual' — also injects Set-of-Marks labels and returns manifest + screenshot.",
          enum: ["text", "visual"],
        },
        include_screenshot: {
          type: "boolean",
          description: "When mode='visual', include a screenshot with SoM labels (default: true).",
        },
        quality: {
          type: "number",
          description: "JPEG quality for screenshots (1-100, default: 60).",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
    },
  },

  {
    id: "gui.navigate",
    name: "gui.navigate",
    description: "Navigate to a URL in the browser, or open a desktop application by name via Start menu search. For browser: navigates and waits for page load. For desktop: opens the app.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to. Protocol (https://) is added automatically if missing.",
        },
        app_name: {
          type: "string",
          description: "Desktop app to open via Start menu search (e.g., 'Calculator', 'Notepad', 'Word'). When set to a non-browser app, opens it via the desktop track.",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  {
    id: "gui.click",
    name: "gui.click",
    description: "Click a UI element by text, name, or coordinates. For browser: uses Playwright locators with role fallback. For desktop: uses SmartNavigator cascading search (accessibility tree → OCR → LLM). Can also click by x/y coordinates directly.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description: "Target application (e.g., 'Calculator', 'Notepad'). Omit for browser.",
        },
        element_text: {
          type: "string",
          description: "The visible text or name of the element to click (e.g., 'Sign In', 'Three', 'File').",
        },
        element_type: {
          type: "string",
          description: "Optional type hint: 'button', 'link', 'input', 'tab', 'menu_item'.",
        },
        location_hint: {
          type: "string",
          description: "Hint where to look: 'top_left', 'top_right', 'center', 'menu_bar', 'sidebar', 'bottom'. Speeds up desktop OCR search.",
        },
        coordinates: {
          type: "object",
          description: "Click at specific x/y pixel coordinates instead of text matching.",
          properties: {
            x: { type: "number", description: "X coordinate" },
            y: { type: "number", description: "Y coordinate" },
          },
        },
        click_type: {
          type: "string",
          description: "Type of click: 'single' (default), 'double', or 'right'.",
          enum: ["single", "double", "right"],
        },
        som_id: {
          type: "number",
          description: "Click element by Set-of-Marks ID from a previous gui.read_state(mode='visual') call. Fastest and most reliable click method for desktop apps.",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  {
    id: "gui.type_text",
    name: "gui.type_text",
    description: "Type text into the focused element or a specified target. For browser: uses Playwright fill/type. For desktop: uses pyautogui with clipboard fallback for non-ASCII.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description: "Target application (e.g., 'Notepad'). Omit for browser.",
        },
        text: {
          type: "string",
          description: "The text to type.",
        },
        target_element: {
          type: "string",
          description: "Optional: click this element before typing (placeholder, label, or visible text).",
        },
        press_enter: {
          type: "boolean",
          description: "If true, press Enter after typing.",
        },
      },
      required: ["text"],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  {
    id: "gui.hotkey",
    name: "gui.hotkey",
    description: "Send a keyboard shortcut. Use '+' to combine keys. For desktop apps, optionally focus the app first.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description: "Optional: focus this app before sending keys (e.g., 'Notepad', 'Calculator').",
        },
        keys: {
          type: "string",
          description: "Key combination using '+' separator. Examples: 'ctrl+t', 'alt+f4', 'ctrl+shift+n', 'enter', 'tab'. Modifiers: ctrl, alt, shift, meta/win.",
        },
      },
      required: ["keys"],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  {
    id: "gui.switch_tab",
    name: "gui.switch_tab",
    description: "Switch to a different browser tab. Matches by title or URL substring. Returns the list of available tabs if no match found.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        title_match: {
          type: "string",
          description: "Substring to match against tab titles or URLs (case-insensitive).",
        },
      },
      required: ["title_match"],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  {
    id: "gui.wait_for",
    name: "gui.wait_for",
    description: "Wait for a condition before proceeding. Works for both browser and desktop apps. Useful after navigation, form submission, or app launch.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description: "Target application for desktop wait conditions. Omit for browser.",
        },
        condition: {
          type: "string",
          description: "What to wait for.",
          enum: ["element_visible", "element_gone", "window_title_contains", "window_exists", "url_contains", "page_load"],
        },
        target: {
          type: "string",
          description: "The target to match (element text, window name, title substring, URL substring).",
        },
        timeout_ms: {
          type: "number",
          description: "Maximum wait time in milliseconds (default: 10000, max: 120000).",
        },
      },
      required: ["condition", "target"],
    },
    annotations: {
      readOnlyHint: true,
      longRunningHint: true,
    },
  },

  {
    id: "gui.screenshot_region",
    name: "gui.screenshot_region",
    description: "Take a screenshot of a browser page or desktop app window. Returns a base64-encoded image. Handles DPI scaling, window activation (desktop), and compression automatically. Use sparingly — prefer gui.read_state for text content.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description: "Target application window to screenshot (e.g., 'Calculator'). Omit for browser.",
        },
        region: {
          type: "string",
          description: "Which part to capture: 'full' (default), 'top_half', 'bottom_half', 'left_half', 'right_half', 'center', 'menu_bar', 'sidebar'.",
        },
        format: {
          type: "string",
          description: "Image format: 'jpeg' (default, 10-50x smaller) or 'png' (pixel-perfect).",
          enum: ["jpeg", "png"],
        },
        quality: {
          type: "number",
          description: "JPEG quality 1-100 (default: 60). Lower = smaller file. Ignored for PNG.",
        },
        max_width: {
          type: "number",
          description: "Max image width in pixels (default: 1280). Images wider are downscaled. LLM vision doesn't benefit from >1280.",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
    },
  },

  {
    id: "gui.open_in_browser",
    name: "gui.open_in_browser",
    description: "Hand off the current page to a visible browser window so the user can see and interact with it. Two modes: 'full_handoff' (reopens Chromium visibly with the same session/cookies — user gets logged-in state) or 'url_only' (opens in default browser without session transfer).",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to open. Defaults to current page URL.",
        },
        mode: {
          type: "string",
          description: "'full_handoff' (default) — reopens with session state. 'url_only' — opens in default browser (no cookies/login transfer).",
          enum: ["full_handoff", "url_only"],
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  // ============================================
  // COMPOUND TOOLS (reduce cloud round-trips)
  // ============================================

  {
    id: "gui.batch",
    name: "gui.batch",
    description: "Execute multiple GUI actions in sequence without cloud round-trips between steps. Each step runs locally — results from all steps are returned together. Use for predictable multi-step sequences (navigate + type + click, fill form fields, wizard steps). Stops on first failure unless continue_on_error is set.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Array of sequential GUI actions. Each step has a 'tool' (gui.* tool ID) and 'args' (arguments for that tool).",
          items: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                description: "The gui.* tool to call (e.g., 'gui.navigate', 'gui.click', 'gui.type_text', 'gui.read_state', 'gui.hotkey', 'gui.wait_for').",
              },
              args: {
                type: "object",
                description: "Arguments to pass to the tool (same as calling the tool individually).",
              },
            },
            required: ["tool", "args"],
          },
        },
        continue_on_error: {
          type: "boolean",
          description: "If true, continue executing remaining steps even if one fails. Default: false (stop on first error).",
        },
      },
      required: ["steps"],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  {
    id: "gui.search_website",
    name: "gui.search_website",
    description: "Navigate to a website and search for something — in one call. Handles: navigate to URL, wait for load, find search input, type query, submit. Returns the page state after search results load. Much faster than doing these 4 steps individually.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The website URL to navigate to (e.g., 'namecheap.com', 'amazon.com').",
        },
        query: {
          type: "string",
          description: "The search query to type into the search box.",
        },
        search_button_text: {
          type: "string",
          description: "Optional: text of the search/submit button to click. If omitted, presses Enter after typing.",
        },
      },
      required: ["url", "query"],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  {
    id: "gui.fill_and_submit",
    name: "gui.fill_and_submit",
    description: "Fill multiple form fields and submit — in one call. Each field specifies a label/placeholder and the value to type. After filling all fields, clicks the submit button. Returns page state after submission.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          description: "Array of form fields to fill. Each has 'label' (text of input/label to click) and 'value' (text to type).",
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description: "The label, placeholder, or name of the input field to target.",
              },
              value: {
                type: "string",
                description: "The value to type into this field.",
              },
            },
            required: ["label", "value"],
          },
        },
        submit_text: {
          type: "string",
          description: "Text of the submit button to click after filling fields (e.g., 'Submit', 'Sign In', 'Continue').",
        },
        app_name: {
          type: "string",
          description: "Target desktop application. Omit for browser forms.",
        },
      },
      required: ["fields", "submit_text"],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  // ============================================
  // PHASE 2: Set-of-Marks + Visual Grounding
  // ============================================

  {
    id: "gui.find_element",
    name: "gui.find_element",
    description: "Find a UI element by name/text using cascading search. Browser: Set-of-Marks injection + manifest search. Desktop: SmartNavigator (accessibility tree → OCR → LLM). Returns element coordinates, metadata, and optional screenshot.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description: "Target application (e.g., 'Calculator', 'Notepad'). Omit for browser.",
        },
        element_text: {
          type: "string",
          description: "Text or name of the element to find (e.g., 'Compose', 'Search', 'Three').",
        },
        element_type: {
          type: "string",
          description: "Optional type hint: 'button', 'link', 'input', 'tab', 'menu_item', 'select', 'checkbox', 'radio'.",
          enum: ["button", "link", "input", "tab", "menu_item", "select", "checkbox", "radio"],
        },
        location_hint: {
          type: "string",
          description: "Hint where to look: 'top_left', 'top_right', 'center', 'menu_bar', 'sidebar', 'bottom'. Speeds up desktop OCR.",
        },
        include_screenshot: {
          type: "boolean",
          description: "If true, returns a screenshot with labeled elements. Default: false.",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
    },
  },

  // ============================================
  // PHASE 3: Network Interception
  // ============================================

  {
    id: "gui.start_recording",
    name: "gui.start_recording",
    description: "Start recording API traffic from the headless browser. Intercepts all XHR/fetch requests, captures endpoints, response schemas, and auth tokens. Browse the site normally after starting — I'll learn the API surface automatically. Stop with gui.stop_recording to save.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Optional domain filter (e.g., 'api.github.com'). Only record traffic to this domain. Omit to record all API traffic.",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  {
    id: "gui.stop_recording",
    name: "gui.stop_recording",
    description: "Stop recording API traffic and save all learned schemas to ~/.bot/api-schemas/. Returns a summary of endpoints recorded, schemas saved, and auth tokens captured.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {
      readOnlyHint: false,
    },
  },

  {
    id: "gui.list_schemas",
    name: "gui.list_schemas",
    description: "List all previously learned API schemas stored at ~/.bot/api-schemas/. Returns domains and their endpoints. Use gui.read_schema to read a specific schema.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {
      readOnlyHint: true,
    },
  },

  {
    id: "gui.read_schema",
    name: "gui.read_schema",
    description: "Read a specific learned API schema. Returns the endpoint URL, method, response schema (field names and types), sample response, and any captured auth headers.",
    source: "core",
    category: "gui",
    executor: "local",
    runtime: "node",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The domain to read schemas from (e.g., 'api.github.com').",
        },
        endpoint: {
          type: "string",
          description: "The endpoint filename (without .json). Use gui.list_schemas to see available endpoints.",
        },
      },
      required: ["domain", "endpoint"],
    },
    annotations: {
      readOnlyHint: true,
    },
  },
];
