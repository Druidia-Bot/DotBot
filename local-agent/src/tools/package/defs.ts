/**
 * Package Management Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const packageTools: DotBotTool[] = [
  {
    id: "package.winget_install", name: "winget_install", category: "package", source: "core", executor: "local", runtime: "powershell",
    description: "Install application using Windows Package Manager (winget).",
    inputSchema: { type: "object", properties: { package_id: { type: "string", description: "Package ID (e.g., 'Microsoft.VisualStudioCode')" }, version: { type: "string" }, silent: { type: "boolean" } }, required: ["package_id"] },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "package.winget_search", name: "winget_search", category: "package", source: "core", executor: "local", runtime: "powershell",
    description: "Search for packages in winget repository.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "package.choco_install", name: "choco_install", category: "package", source: "core", executor: "local", runtime: "powershell",
    description: "Install package using Chocolatey package manager.",
    inputSchema: { type: "object", properties: { package_name: { type: "string" }, version: { type: "string" }, params: { type: "string" } }, required: ["package_name"] },
    annotations: { destructiveHint: true, mutatingHint: true },
  },
  {
    id: "package.list_installed", name: "list_installed_apps", category: "package", source: "core", executor: "local", runtime: "powershell",
    description: "List all installed applications on Windows.",
    inputSchema: { type: "object", properties: { filter: { type: "string", description: "Filter by application name" }, source: { type: "string", enum: ["all", "winget", "chocolatey", "registry"] } } },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
];
