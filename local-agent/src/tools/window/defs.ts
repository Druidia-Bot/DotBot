/**
 * Window Management Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const windowTools: DotBotTool[] = [
  {
    id: "window.list", name: "list_windows", category: "window", source: "core", executor: "local", runtime: "powershell",
    description: "List all open windows with titles, process names, and PIDs.",
    inputSchema: { type: "object", properties: { filter: { type: "string", description: "Filter by window title or process name" } } },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "window.focus", name: "focus_window", category: "window", source: "core", executor: "local", runtime: "powershell",
    description: "Bring a window to the foreground by title or process name.",
    inputSchema: { type: "object", properties: { title: { type: "string", description: "Window title (supports partial match)" }, process: { type: "string", description: "Process name" } } },
    annotations: { mutatingHint: true },
  },
  {
    id: "window.resize", name: "resize_window", category: "window", source: "core", executor: "local", runtime: "powershell",
    description: "Resize and/or move a window to specific coordinates and dimensions.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, process: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, state: { type: "string", enum: ["normal", "minimized", "maximized"] } } },
    annotations: { mutatingHint: true },
  },
  {
    id: "window.close", name: "close_window", category: "window", source: "core", executor: "local", runtime: "powershell",
    description: "Close a window by title or process name.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, process: { type: "string" }, force: { type: "boolean", description: "Force close without saving" } } },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
];
