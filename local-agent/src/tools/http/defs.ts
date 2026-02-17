/**
 * HTTP Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const httpTools: DotBotTool[] = [
  {
    id: "http.request",
    name: "http_request",
    description: "Make an HTTP request (GET, POST, PUT, DELETE, PATCH). The curl equivalent — use this for calling any REST API, downloading content, or checking URLs. Supports custom headers, body, and auth.",
    source: "core",
    category: "http",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to request" },
        method: { type: "string", description: "HTTP method: GET, POST, PUT, DELETE, PATCH (default: GET)", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
        headers: { type: "object", description: "Request headers as key-value pairs", additionalProperties: { type: "string" } },
        body: { type: "string", description: "Request body (for POST/PUT/PATCH). JSON string or raw text." },
        auth: { type: "string", description: "Authorization header value (e.g., 'Bearer token123')" },
        timeout: { type: "number", description: "Request timeout in ms (default: 30000)" },
      },
      required: ["url"],
    },
    annotations: { mutatingHint: true },
    cache: { mode: "enrich", type: "web_page" },
  },
  {
    id: "http.render",
    name: "http_render",
    description: "Fetch a web page using a real browser engine that executes JavaScript. Use this instead of http.request when a page is a JavaScript application (React, Angular, etc.) that returns empty HTML with raw fetch. Launches headless Chromium, navigates to the URL, waits for JS to render, and returns the page title, URL, and full rendered text content. Read-only — no interaction.",
    source: "core",
    category: "http",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to render (https:// added if missing)" },
        wait_ms: { type: "number", description: "Extra milliseconds to wait after page load for JS to finish rendering (default: 2000, max: 15000)" },
        timeout: { type: "number", description: "Navigation timeout in ms (default: 30000)" },
      },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
    cache: { mode: "enrich", type: "web_page" },
  },
  {
    id: "http.download",
    name: "download_file",
    description: "Download a file from a URL and save it to a local path.",
    source: "core",
    category: "http",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to download from" },
        path: { type: "string", description: "Local path to save the file" },
      },
      required: ["url", "path"],
    },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
];
