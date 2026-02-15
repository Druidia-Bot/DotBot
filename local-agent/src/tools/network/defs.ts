/**
 * Network Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const networkTools: DotBotTool[] = [
  {
    id: "network.ping",
    name: "ping",
    description: "Ping a host to check connectivity and latency.",
    source: "core",
    category: "network",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname or IP to ping" },
        count: { type: "number", description: "Number of pings (default: 4)" },
      },
      required: ["host"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "network.dns_lookup",
    name: "dns_lookup",
    description: "Look up DNS records for a domain.",
    source: "core",
    category: "network",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain to look up" },
        type: { type: "string", description: "Record type: A, AAAA, MX, TXT, CNAME (default: A)" },
      },
      required: ["domain"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "network.port_check",
    name: "port_check",
    description: "Check if a TCP port is open on a host.",
    source: "core",
    category: "network",
    executor: "local",
    runtime: "powershell",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname or IP" },
        port: { type: "number", description: "Port number to check" },
      },
      required: ["host", "port"],
    },
    annotations: { readOnlyHint: true },
  },
];
