/**
 * MCP Management Handler
 *
 * Handles mcp.setup_server, mcp.list_servers, mcp.remove_server.
 */

import { promises as fs } from "fs";
import { resolve, join } from "path";
import type { ToolExecResult } from "../_shared/types.js";
import type { MCPServerConfig } from "./types.js";
import { loadMcpConfigs } from "./loader.js";
import { mcpManager } from "./manager.js";
import { vaultHas } from "../../credential-vault.js";

function getMcpConfigDir(): string {
  const profile = process.env.USERPROFILE || process.env.HOME || "";
  return resolve(profile, ".bot", "mcp");
}

export async function handleMcpManagement(toolId: string, args: Record<string, any>): Promise<ToolExecResult | null> {
  switch (toolId) {
    case "mcp.setup_server": {
      if (!args.name || !args.transport) {
        return { success: false, output: "", error: "Missing required fields: name, transport" };
      }

      const name = String(args.name).toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const transport = args.transport as MCPServerConfig["transport"];

      // Validate transport-specific requirements
      if ((transport === "sse" || transport === "streamable-http") && !args.url) {
        return { success: false, output: "", error: `Transport "${transport}" requires a "url" parameter.` };
      }
      if (transport === "stdio" && !args.command) {
        return { success: false, output: "", error: `Transport "stdio" requires a "command" parameter.` };
      }

      // Validate credential exists in vault if specified
      if (args.credentialRequired) {
        const hasCredential = await vaultHas(args.credentialRequired);
        if (!hasCredential) {
          return {
            success: false, output: "",
            error: `Credential "${args.credentialRequired}" not found in vault. Use secrets.prompt_user to store it first.`,
          };
        }
      }

      // Build config
      const config: MCPServerConfig = {
        name,
        transport,
        enabled: args.enabled !== false,
        ...(args.url && { url: args.url }),
        ...(args.command && { command: args.command }),
        ...(args.args && { args: args.args }),
        ...(args.credentialRequired && { credentialRequired: args.credentialRequired }),
      };

      // Write config file
      const configDir = getMcpConfigDir();
      await fs.mkdir(configDir, { recursive: true });
      const filePath = join(configDir, `${name}.json`);
      await fs.writeFile(filePath, JSON.stringify(config, null, 2), "utf-8");

      const lines = [
        `MCP server "${name}" configured successfully.`,
        `Config: ~/.bot/mcp/${name}.json`,
        `Transport: ${transport}`,
      ];
      if (args.url) lines.push(`URL: ${args.url}`);
      if (args.credentialRequired) lines.push(`Credential: ${args.credentialRequired} (vault)`);
      lines.push("", "⚠ Restart required to activate. Use system.restart to apply.");

      return { success: true, output: lines.join("\n") };
    }

    case "mcp.list_servers": {
      const configs = await loadMcpConfigs();
      if (configs.length === 0) {
        return { success: true, output: "No MCP servers configured.\n\nTo add one, use mcp.setup_server or follow the /mcp-setup skill." };
      }

      const states = mcpManager.getStatus();
      const stateMap = new Map(states.map(s => [s.config.name, s]));

      const lines: string[] = [`${configs.length} MCP server(s) configured:\n`];
      for (const config of configs) {
        const state = stateMap.get(config.name);
        const isServerSide = !!config.credentialRequired;
        const status = state ? state.status : (isServerSide ? "server-side" : "not connected");
        const toolCount = state ? state.toolCount : 0;
        const cred = config.credentialRequired ? ` (credential: ${config.credentialRequired})` : "";
        lines.push(`  ${config.name} [${config.transport}] — ${status} (${toolCount} tools)${cred}`);
        if (config.url) lines.push(`    URL: ${config.url}`);
        if (isServerSide && !state) {
          lines.push(`    ⚡ Handled by server gateway — use tools.list_tools to see status/errors`);
        }
      }

      return { success: true, output: lines.join("\n") };
    }

    case "mcp.remove_server": {
      if (!args.name) return { success: false, output: "", error: "Missing required field: name" };

      const name = String(args.name).toLowerCase();
      const configDir = getMcpConfigDir();
      const filePath = join(configDir, `${name}.json`);

      // Disconnect if connected
      try {
        await mcpManager.disconnectSingle(name);
      } catch { /* ok — may not be connected */ }

      // Delete config file
      try {
        await fs.unlink(filePath);
        return { success: true, output: `Removed MCP server "${name}" and deleted config file.` };
      } catch {
        return { success: false, output: "", error: `Config file not found for server "${name}".` };
      }
    }

    default:
      // Not a management tool — return null to signal fallthrough to executeRegisteredTool
      return null;
  }
}
