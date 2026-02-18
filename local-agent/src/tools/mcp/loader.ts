/**
 * MCP Config Loader
 *
 * Reads MCP server configs from ~/.bot/mcp/*.json
 * Each file defines one MCP server connection.
 */

import { promises as fs } from "fs";
import { resolve, join } from "path";
import type { MCPServerConfig } from "./types.js";

/** Get the MCP config directory path. */
function getMcpConfigDir(): string {
  const profile = process.env.USERPROFILE || process.env.HOME || "";
  return resolve(profile, ".bot", "mcp");
}

/**
 * Substitute ${ENV_VAR} references with process.env values.
 * Returns the original string if the env var is not set.
 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    return process.env[varName] || `\${${varName}}`;
  });
}

/** Resolve env vars in a headers/env record. */
export function resolveEnvRecord(record: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    resolved[key] = resolveEnvVars(value);
  }
  return resolved;
}

/**
 * Load all MCP server configs from ~/.bot/mcp/*.json
 * Skips files that fail to parse and logs warnings.
 */
export async function loadMcpConfigs(): Promise<MCPServerConfig[]> {
  const configDir = getMcpConfigDir();

  try {
    await fs.access(configDir);
  } catch {
    return []; // Directory doesn't exist yet — no MCP servers configured
  }

  const configs: MCPServerConfig[] = [];

  try {
    const files = await fs.readdir(configDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(join(configDir, file), "utf-8");
        const config = JSON.parse(content) as MCPServerConfig;

        if (!config.name || !config.transport) {
          console.warn(`[MCP] Skipping ${file}: missing required fields (name, transport)`);
          continue;
        }

        if ((config.transport === "streamable-http" || config.transport === "sse") && !config.url) {
          console.warn(`[MCP] Skipping ${file}: ${config.transport} transport requires "url"`);
          continue;
        }

        if (config.transport === "stdio" && !config.command) {
          console.warn(`[MCP] Skipping ${file}: stdio transport requires "command"`);
          continue;
        }

        if (config.enabled === false) {
          console.log(`[MCP] Skipping disabled server: ${config.name}`);
          continue;
        }

        configs.push(config);
      } catch (err) {
        console.warn(`[MCP] Failed to load config from ${file}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.warn(`[MCP] Failed to read config directory:`, err instanceof Error ? err.message : err);
  }

  return configs;
}
