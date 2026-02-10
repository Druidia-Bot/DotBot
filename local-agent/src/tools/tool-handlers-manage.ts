/**
 * Tool Handlers — Secrets, Tools & Skills Management
 *
 * Local secret storage, self-learning tool registry, and skill CRUD.
 */

import { promises as fs } from "fs";
import { resolve, join } from "path";
import { getAllTools, registerTool, unregisterTool } from "./registry.js";
import type { DotBotTool } from "../memory/types.js";
import { createSkill, getAllSkills, getSkill, searchSkills, deleteSkill } from "../memory/store-skills.js";
import type { ToolExecResult } from "./tool-executor.js";
import { knownFolders } from "./tool-executor.js";
import { vaultHas, vaultList, vaultDelete } from "../credential-vault.js";

// ============================================
// SECRETS HANDLERS
// ============================================

export async function handleSecrets(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "secrets.list_keys": {
      const vaultKeys = await vaultList();

      if (vaultKeys.length === 0) return { success: true, output: "No credentials stored." };

      const lines = vaultKeys.map(key => `  ${key} — vault (server-encrypted)`);
      return { success: true, output: `${vaultKeys.length} credentials:\n${lines.join("\n")}\n\nNote: Values are NEVER shown. Credentials are server-encrypted and can only be used via the server proxy.` };
    }
    case "secrets.delete_key": {
      const deleted = await vaultDelete(args.key);
      if (!deleted) {
        return { success: true, output: `Key ${args.key} not found in vault.` };
      }
      return { success: true, output: `Deleted ${args.key} from encrypted vault.` };
    }
    case "secrets.prompt_user": {
      if (!args.key_name) return { success: false, output: "", error: "key_name is required (e.g., 'DISCORD_BOT_TOKEN')" };
      if (!args.prompt) return { success: false, output: "", error: "prompt text is required (shown to the user in the dialog)" };
      if (!args.allowed_domain) return { success: false, output: "", error: "allowed_domain is required (e.g., 'discord.com') — credentials must be scoped to a specific API domain" };

      const title = args.title || "DotBot — Secure Credential Entry";

      // Split-knowledge architecture:
      // 1. Request a secure entry page session from the server (scoped to allowed_domain)
      // 2. Show user a QR code — they scan with their phone and enter on a SEPARATE device
      // 3. User enters credential on the server's page (never on this machine)
      // 4. Server encrypts with server-side key + domain, sends opaque blob via WS
      // 5. We store the blob in vault — can NEVER decrypt it locally
      // 6. When a tool needs the credential, we send the blob to the server for proxied execution
      // → The real credential NEVER exists in plaintext on the client
      // → The credential is cryptographically bound to the allowed domain

      try {
        const { requestCredentialSession, waitForCredentialStored } = await import("../credential-proxy.js");

        // Step 1: Request a session from the server (domain-scoped)
        const session = await requestCredentialSession(args.key_name, args.prompt, args.allowed_domain, title);

        // Step 2: Also try to open in local browser as fallback
        try {
          const parsed = new URL(session.url);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            const { execFile } = await import("child_process");
            execFile("cmd", ["/c", "start", "", session.url], { windowsHide: true });
          }
        } catch {
          // If browser open fails, QR code is the primary path anyway
        }

        // Step 3: Wait for the server to send us the encrypted blob
        // (user enters credential on the web page → server encrypts → sends blob via WS)
        const blob = await waitForCredentialStored(args.key_name);

        // Step 4: Store the server-encrypted blob in vault
        const { vaultSetServerBlob } = await import("../credential-vault.js");
        await vaultSetServerBlob(args.key_name, blob);

        return {
          success: true,
          output: [
            `Credential "${args.key_name}" has been securely stored in the encrypted vault.`,
            `The value was entered on a secure server page and encrypted with a server-side key.`,
            `The credential is cryptographically bound to "${args.allowed_domain}" — it can ONLY be used for API calls to that domain.`,
            `The real credential NEVER existed in plaintext on this machine — only an opaque encrypted blob is stored locally. The LLM never sees it.`,
          ].join(" "),
        };
      } catch (err: any) {
        if (err.message?.includes("timed out")) {
          return { success: false, output: "", error: "Credential entry timed out (15 minute limit). The user did not complete the entry page. Ask if they need more time or help." };
        }
        if (err.message?.includes("not initialized")) {
          return { success: false, output: "", error: "Cannot open credential entry — server connection not established." };
        }
        return { success: false, output: "", error: `Credential entry failed: ${err.message}` };
      }
    }
    default:
      return { success: false, output: "", error: `Unknown secrets tool: ${toolId}` };
  }
}

// ============================================
// TOOLS MANAGEMENT HANDLERS
// ============================================

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

// ============================================
// SKILLS MANAGEMENT HANDLERS
// ============================================

export async function handleSkillsManagement(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "skills.save_skill": {
      if (!args.name || !args.description || !args.content) {
        return { success: false, output: "", error: "Missing required fields: name, description, content" };
      }

      const tags = typeof args.tags === "string"
        ? args.tags.split(",").map((t: string) => t.trim())
        : (args.tags || []);

      const skill = await createSkill(
        args.name,
        args.description,
        args.content,
        tags,
        {
          disableModelInvocation: args.disableModelInvocation || false,
        }
      );

      return {
        success: true,
        output: `Saved skill: "${skill.name}" (/${skill.slug})\nTags: ${skill.tags.join(", ") || "none"}\nPath: ~/.bot/skills/${skill.slug}/SKILL.md\nThis skill is now available in all future conversations.`,
      };
    }

    case "skills.list_skills": {
      let skills;
      if (args.query) {
        skills = await searchSkills(args.query);
      } else {
        skills = (await getAllSkills()).map(s => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          tags: s.tags,
          disableModelInvocation: s.disableModelInvocation,
          userInvocable: s.userInvocable,
        }));
      }

      if (skills.length === 0) {
        return { success: true, output: "No skills found." };
      }

      const lines = skills.map((s: any) => {
        const flags = [];
        if (s.disableModelInvocation) flags.push("user-only");
        if (s.userInvocable === false) flags.push("background");
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        const tagStr = s.tags?.length > 0 ? ` (${s.tags.join(", ")})` : "";
        return `  /${s.slug}${flagStr} — ${s.description.substring(0, 80)}${s.description.length > 80 ? "..." : ""}${tagStr}`;
      });

      return { success: true, output: `${skills.length} skills:\n${lines.join("\n")}` };
    }

    case "skills.read_skill": {
      if (!args.slug) return { success: false, output: "", error: "Missing required field: slug" };

      const skill = await getSkill(args.slug);
      if (!skill) return { success: false, output: "", error: `Skill not found: ${args.slug}` };

      const parts = [
        `# /${skill.name}`,
        `**Description:** ${skill.description}`,
        skill.tags.length > 0 ? `**Tags:** ${skill.tags.join(", ")}` : "",
        skill.supportingFiles.length > 0 ? `**Supporting files:** ${skill.supportingFiles.join(", ")}` : "",
        "",
        "## Instructions",
        "",
        skill.content,
      ].filter(Boolean);

      return { success: true, output: parts.join("\n") };
    }

    case "skills.delete_skill": {
      if (!args.slug) return { success: false, output: "", error: "Missing required field: slug" };

      const skill = await getSkill(args.slug);
      if (!skill) return { success: false, output: "", error: `Skill not found: ${args.slug}` };

      await deleteSkill(args.slug);
      return { success: true, output: `Deleted skill: ${args.slug} (directory removed)` };
    }

    default:
      return { success: false, output: "", error: `Unknown skills management tool: ${toolId}` };
  }
}
