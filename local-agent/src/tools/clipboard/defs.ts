/**
 * Clipboard Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const clipboardTools: DotBotTool[] = [
  {
    id: "clipboard.read",
    name: "clipboard_read",
    description: "Read the current contents of the system clipboard.",
    source: "core",
    category: "clipboard",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "clipboard.write",
    name: "clipboard_write",
    description: "Write text to the system clipboard.",
    source: "core",
    category: "clipboard",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Text to copy to clipboard" },
      },
      required: ["content"],
    },
    annotations: {},
  },
];
