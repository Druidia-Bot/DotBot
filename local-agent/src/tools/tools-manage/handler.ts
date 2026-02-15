/**
 * Tools Management Handler
 */

import { promises as fs } from "fs";
import { resolve, join } from "path";
import { getAllTools, registerTool, unregisterTool } from "../registry.js";
import type { DotBotTool } from "../../memory/types.js";
import type { ToolExecResult } from "../_shared/types.js";
import { knownFolders } from "../_shared/path.js";

function getApiToolsDir(): string {
  const profile = knownFolders["userprofile"] || process.env.USERPROFILE || "";
  return resolve(profile, ".bot", "tools", "api");
}

function getCustomToolsDir(): string {
  const profile = knownFolders["userprofile"] || process.env.USERPROFILE || "";
  return resolve(profile, ".bot", "tools", "custom");
}

function getScriptsDir(): string {
  const profile = knownFolders["userprofile"] || process.env.USERPROFILE || "";
  return resolve(profile, ".bot", "tools", "scripts");
}

export async function handleToolsManagement(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "tools.save_tool": {
      // Validate required fields
      if (!args.id || !args.name || !args.description || !args.category || !args.inputSchema) {
        return { success: false, output: "", error: "Missing required fields: id, name, description, category, inputSchema" };
      }

      // Must have either apiSpec OR (script + runtime)
      const isApiTool = !!args.apiSpec;
      const isScriptTool = !!args.script && !!args.runtime;
      if (!isApiTool && !isScriptTool) {
        return { success: false, output: "", error: "Must provide either apiSpec (for API tools) or script + runtime (for script tools)" };
      }

      // Validate tool ID format: only alphanumeric, dots, underscores, hyphens
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,100}$/.test(args.id)) {
        return { success: false, output: "", error: "Invalid tool ID format. Use alphanumeric chars, dots, underscores, hyphens (2-101 chars)" };
      }

      // Prevent overwriting core tools
      const existing = getAllTools().find(t => t.id === args.id);
      if (existing && existing.source === "core") {
        return { success: false, output: "", error: `Cannot overwrite core tool: ${args.id}` };
      }

      // Block reserved core categories for tool IDs
      const coreCategories = ["filesystem", "directory", "shell", "clipboard", "browser", "system", "network", "secrets", "tools", "gui"];
      const idCategory = args.id.split(".")[0];
      if (coreCategories.includes(idCategory)) {
        return { success: false, output: "", error: `Cannot save tools in reserved core category: ${idCategory}. Use a custom category name.` };
      }

      if (isScriptTool) {
        // Validate runtime
        const validRuntimes = ["python", "node", "powershell"];
        if (!validRuntimes.includes(args.runtime)) {
          return { success: false, output: "", error: `Invalid runtime: ${args.runtime}. Must be one of: ${validRuntimes.join(", ")}` };
        }

        // Save script file to ~/.bot/tools/scripts/<id>.<ext>
        const extMap: Record<string, string> = { python: ".py", node: ".js", powershell: ".ps1" };
        const ext = extMap[args.runtime];
        const scriptFilename = args.id.replace(/\./g, "-") + ext;
        const scriptsDir = getScriptsDir();
        await fs.mkdir(scriptsDir, { recursive: true });
        await fs.writeFile(join(scriptsDir, scriptFilename), args.script, "utf-8");

        // Build the DotBotTool definition
        const tool: DotBotTool = {
          id: args.id,
          name: args.name,
          description: args.description,
          source: "custom",
          category: args.category,
          executor: "local",
          runtime: args.runtime,
          inputSchema: typeof args.inputSchema === "string" ? JSON.parse(args.inputSchema) : args.inputSchema,
          annotations: args.annotations || {},
          ...(args.credentialRequired && { credentialRequired: args.credentialRequired }),
        };

        // Save tool definition to ~/.bot/tools/custom/<id>.json
        const customDir = getCustomToolsDir();
        await fs.mkdir(customDir, { recursive: true });
        const defFilename = args.id.replace(/\./g, "-") + ".json";
        await fs.writeFile(join(customDir, defFilename), JSON.stringify(tool, null, 2), "utf-8");

        // Register in the live registry
        registerTool(tool);

        return {
          success: true,
          output: [
            `Saved and registered script tool: ${args.id} (${args.name})`,
            `Category: ${args.category} | Runtime: ${args.runtime}`,
            `Script: ~/.bot/tools/scripts/${scriptFilename}`,
            `Definition: ~/.bot/tools/custom/${defFilename}`,
            `This tool will be available in all future conversations.`,
          ].join("\n"),
        };
      }

      // API tool path
      const tool: DotBotTool = {
        id: args.id,
        name: args.name,
        description: args.description,
        source: "api",
        category: args.category,
        executor: "local",
        runtime: "http",
        inputSchema: typeof args.inputSchema === "string" ? JSON.parse(args.inputSchema) : args.inputSchema,
        apiSpec: typeof args.apiSpec === "string" ? JSON.parse(args.apiSpec) : args.apiSpec,
        annotations: args.annotations || {},
        ...(args.credentialRequired && { credentialRequired: args.credentialRequired }),
      };

      // Save to ~/.bot/tools/api/<id>.json
      const dir = getApiToolsDir();
      await fs.mkdir(dir, { recursive: true });
      const filename = args.id.replace(/\./g, "-") + ".json";
      await fs.writeFile(join(dir, filename), JSON.stringify(tool, null, 2), "utf-8");

      // Register in the live registry
      registerTool(tool);

      return { success: true, output: `Saved and registered API tool: ${args.id} (${args.name})\nCategory: ${args.category}\nFile: ~/.bot/tools/api/${filename}\nThis tool will be available in all future conversations.` };
    }

    case "tools.list_tools": {
      let tools = getAllTools();
      if (args.category) tools = tools.filter(t => t.category === args.category);
      if (args.source) tools = tools.filter(t => t.source === args.source);

      if (tools.length === 0) {
        return { success: true, output: "No tools found matching the filter." };
      }

      // Group by category
      const grouped = new Map<string, DotBotTool[]>();
      for (const t of tools) {
        if (!grouped.has(t.category)) grouped.set(t.category, []);
        grouped.get(t.category)!.push(t);
      }

      const lines: string[] = [`${tools.length} tools registered:\n`];
      for (const [cat, catTools] of grouped) {
        lines.push(`[${cat}] (${catTools.length})`);
        for (const t of catTools) {
          lines.push(`  ${t.id} — ${t.description.substring(0, 80)}${t.description.length > 80 ? "..." : ""} (${t.source})`);
        }
      }

      return { success: true, output: lines.join("\n") };
    }

    case "tools.delete_tool": {
      if (!args.id) return { success: false, output: "", error: "Missing required field: id" };

      // Remove from registry
      const removed = unregisterTool(args.id);

      // Remove JSON definition from all possible locations
      const defFilename = args.id.replace(/\./g, "-") + ".json";
      for (const dir of [getApiToolsDir(), getCustomToolsDir()]) {
        try { await fs.unlink(join(dir, defFilename)); } catch { /* ok */ }
      }

      // Remove script files (all possible extensions)
      const scriptBase = args.id.replace(/\./g, "-");
      for (const ext of [".py", ".js", ".ps1"]) {
        try { await fs.unlink(join(getScriptsDir(), scriptBase + ext)); } catch { /* ok */ }
      }

      return {
        success: true,
        output: removed
          ? `Removed tool: ${args.id} (definition + script files cleaned up)`
          : `Tool ${args.id} was not found in the registry`,
      };
    }

    default:
      return { success: false, output: "", error: `Unknown tools management tool: ${toolId}` };
  }
}
