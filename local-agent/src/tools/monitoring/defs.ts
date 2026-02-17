/**
 * Performance Monitoring Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const monitoringTools: DotBotTool[] = [
  {
    id: "monitoring.cpu_usage", name: "get_cpu_usage", category: "monitoring", source: "core", executor: "local", runtime: "powershell",
    description: "Get current CPU usage percentage overall or per process.",
    inputSchema: { type: "object", properties: { process: { type: "string", description: "Specific process name" }, duration: { type: "number", description: "Monitoring duration in seconds" } } },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "monitoring.memory_usage", name: "get_memory_usage", category: "monitoring", source: "core", executor: "local", runtime: "powershell",
    description: "Get current memory usage (RAM) overall or per process.",
    inputSchema: { type: "object", properties: { process: { type: "string" }, unit: { type: "string", enum: ["MB", "GB", "percent"] } } },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "monitoring.disk_io", name: "get_disk_io", category: "monitoring", source: "core", executor: "local", runtime: "powershell",
    description: "Monitor disk I/O activity (read/write speeds).",
    inputSchema: { type: "object", properties: { drive: { type: "string", description: "Drive letter (e.g., 'C:')" }, duration: { type: "number" } } },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
  {
    id: "monitoring.network_traffic", name: "get_network_traffic", category: "monitoring", source: "core", executor: "local", runtime: "powershell",
    description: "Monitor network traffic (sent/received bytes).",
    inputSchema: { type: "object", properties: { interface: { type: "string" }, duration: { type: "number" } } },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
];
