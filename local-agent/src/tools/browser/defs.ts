/**
 * Browser Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const browserTools: DotBotTool[] = [
  {
    id: "browser.open_url",
    name: "open_url",
    description: "Open a URL in the user's default web browser.",
    source: "core",
    category: "browser",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
      },
      required: ["url"],
    },
    annotations: { mutatingHint: true },
  },
];
