/**
 * Windows Registry Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const registryTools: DotBotTool[] = [
  {
    id: "registry.read", name: "registry_read", category: "registry", source: "core", executor: "local", runtime: "powershell",
    description: "Read a Windows registry key value.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Registry path (e.g., 'HKCU:\\Software\\Microsoft\\Windows')" }, name: { type: "string", description: "Value name to read" } }, required: ["path", "name"] },
    annotations: { readOnlyHint: true },
  },
  {
    id: "registry.write", name: "registry_write", category: "registry", source: "core", executor: "local", runtime: "powershell",
    description: "Write or update a Windows registry key value.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Registry path" }, name: { type: "string", description: "Value name" }, value: { type: "string", description: "Value to write" }, type: { type: "string", description: "Registry value type", enum: ["String", "DWord", "QWord", "Binary", "MultiString", "ExpandString"] } }, required: ["path", "name", "value"] },
  },
  {
    id: "registry.delete", name: "registry_delete", category: "registry", source: "core", executor: "local", runtime: "powershell",
    description: "Delete a Windows registry key or value.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Registry path" }, name: { type: "string", description: "Value name to delete (omit to delete entire key)" }, recurse: { type: "boolean", description: "Recursively delete subkeys" } }, required: ["path"] },
  },
  {
    id: "registry.search", name: "registry_search", category: "registry", source: "core", executor: "local", runtime: "powershell",
    description: "Search Windows registry for keys or values matching a pattern.",
    inputSchema: { type: "object", properties: { root: { type: "string", description: "Root path to search from" }, pattern: { type: "string", description: "Search pattern (supports wildcards)" }, search_keys: { type: "boolean", description: "Search key names" }, search_values: { type: "boolean", description: "Search value names" }, max_results: { type: "number", description: "Maximum results to return" } }, required: ["root", "pattern"] },
    annotations: { readOnlyHint: true },
  },
];
