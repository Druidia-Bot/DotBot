/**
 * Tool Handlers — Discord Setup & Management
 * 
 * Dedicated tools for Discord bot configuration. Uses Discord's REST API
 * directly (no npm packages needed) to:
 * - Validate bot tokens
 * - Generate OAuth2 invite URLs
 * - List guilds and channels
 * - Create channels
 * - Auto-setup the standard DotBot channel set
 * - Write Discord config to the local-agent .env
 * 
 * These tools replace the fragile GUI automation approach for Discord setup.
 * The user still needs to create the bot in Discord's Developer Portal manually,
 * but everything after "paste your token" is automated via API.
 */

import { promises as fs } from "fs";
import { resolve, dirname } from "path";
import type { ToolExecResult } from "./tool-executor.js";
import { credentialProxyFetch } from "../credential-proxy.js";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_CREDENTIAL_NAME = "DISCORD_BOT_TOKEN";

// ============================================
// HELPERS
// ============================================

/**
 * Make an authenticated request to the Discord API via the server proxy.
 * The server decrypts the credential and makes the call — the real token
 * never exists in plaintext on the client.
 */
async function discordFetch(
  path: string,
  options: { method?: string; body?: any } = {}
): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await credentialProxyFetch(path, DISCORD_CREDENTIAL_NAME, {
      baseUrl: DISCORD_API,
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "DotBot (https://getmy.bot, 1.0)",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      placement: { header: "Authorization", prefix: "Bot " },
    });

    let data: any;
    try {
      data = JSON.parse(res.body);
    } catch {
      data = res.body;
    }

    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    throw new Error(`Discord API request failed: ${err.message || String(err)}`);
  }
}

// ============================================
// HANDLER
// ============================================

export async function handleDiscord(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {

    // ----------------------------------------
    // discord.validate_token
    // ----------------------------------------
    case "discord.validate_token": {
      try {
        const { ok, status, data } = await discordFetch("/users/@me");
        if (!ok) {
          if (status === 401) {
            return { success: false, output: "", error: "Invalid bot token. The token was rejected by Discord. Please check it and try again via secrets.prompt_user." };
          }
          return { success: false, output: "", error: `Discord API error: ${status} — ${JSON.stringify(data)}` };
        }

        return {
          success: true,
          output: JSON.stringify({
            valid: true,
            bot_id: data.id,
            bot_username: data.username,
            bot_discriminator: data.discriminator || "0",
            application_id: data.id,
            hint: "Token is valid. Next: use discord.full_setup or discord.get_invite_url.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // discord.get_invite_url
    // ----------------------------------------
    case "discord.get_invite_url": {
      let applicationId = args.application_id;

      // If no application_id provided, try to get it from the token
      if (!applicationId) {
        try {
          const { ok, data } = await discordFetch("/users/@me");
          if (!ok) return { success: false, output: "", error: "Could not fetch bot info. Is the token valid?" };
          applicationId = data.id;
        } catch (err: any) {
          return { success: false, output: "", error: err.message };
        }
      }

      // Administrator permission = 8
      const permissions = args.permissions || "8";
      const url = `https://discord.com/oauth2/authorize?client_id=${applicationId}&permissions=${permissions}&scope=bot`;

      return {
        success: true,
        output: JSON.stringify({
          invite_url: url,
          application_id: applicationId,
          permissions,
          hint: "Open this URL in a browser to add the bot to your Discord server. Select the server, click Authorize, then use discord.list_guilds to verify.",
        }, null, 2),
      };
    }

    // ----------------------------------------
    // discord.list_guilds
    // ----------------------------------------
    case "discord.list_guilds": {
      try {
        const { ok, status, data } = await discordFetch("/users/@me/guilds");
        if (!ok) return { success: false, output: "", error: `Discord API error: ${status} — ${JSON.stringify(data)}` };

        if (!Array.isArray(data) || data.length === 0) {
          return {
            success: true,
            output: JSON.stringify({
              guilds: [],
              hint: "The bot is not in any servers yet. Use discord.get_invite_url to generate an invite link, then add the bot to your server.",
            }, null, 2),
          };
        }

        const guilds = data.map((g: any) => ({
          id: g.id,
          name: g.name,
          owner: g.owner || false,
          permissions: g.permissions,
        }));

        return {
          success: true,
          output: JSON.stringify({
            guild_count: guilds.length,
            guilds,
            hint: "Use the guild id with discord.list_channels or discord.setup_channels.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // discord.list_channels
    // ----------------------------------------
    case "discord.list_channels": {
      const guildId = args.guild_id;
      if (!guildId) return { success: false, output: "", error: "guild_id is required." };

      try {
        const { ok, status, data } = await discordFetch(`/guilds/${guildId}/channels`);
        if (!ok) return { success: false, output: "", error: `Discord API error: ${status} — ${JSON.stringify(data)}` };

        // Channel type 0 = text, 2 = voice, 4 = category
        const channels = (data as any[]).map((ch: any) => ({
          id: ch.id,
          name: ch.name,
          type: ch.type === 0 ? "text" : ch.type === 2 ? "voice" : ch.type === 4 ? "category" : `type_${ch.type}`,
          position: ch.position,
        }));

        return {
          success: true,
          output: JSON.stringify({
            guild_id: guildId,
            channel_count: channels.length,
            channels,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // discord.create_channel
    // ----------------------------------------
    case "discord.create_channel": {
      const guildId = args.guild_id;
      const name = args.name;
      if (!guildId) return { success: false, output: "", error: "guild_id is required." };
      if (!name) return { success: false, output: "", error: "Channel name is required." };

      try {
        const body: any = {
          name,
          type: 0, // text channel
        };
        if (args.topic) body.topic = args.topic;

        const { ok, status, data } = await discordFetch(`/guilds/${guildId}/channels`, {
          method: "POST",
          body,
        });

        if (!ok) return { success: false, output: "", error: `Discord API error: ${status} — ${JSON.stringify(data)}` };

        return {
          success: true,
          output: JSON.stringify({
            created: true,
            channel_id: data.id,
            channel_name: data.name,
            guild_id: guildId,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // discord.setup_channels
    // ----------------------------------------
    case "discord.setup_channels": {
      const guildId = args.guild_id;
      if (!guildId) return { success: false, output: "", error: "guild_id is required." };

      const requiredChannels = [
        { name: "conversation", topic: "Main chat channel — talk to DotBot here" },
        { name: "updates", topic: "Live task progress feed" },
        { name: "logs", topic: "Diagnostic trace — LLM calls, tool executions" },
      ];

      try {
        // First, list existing channels
        const { ok, status, data: existingChannels } = await discordFetch(`/guilds/${guildId}/channels`);
        if (!ok) return { success: false, output: "", error: `Could not list channels: ${status}` };

        const results: Array<{ name: string; channel_id: string; action: string }> = [];

        for (const req of requiredChannels) {
          // Check if channel already exists
          const existing = (existingChannels as any[]).find(
            (ch: any) => ch.name === req.name && ch.type === 0
          );

          if (existing) {
            results.push({ name: req.name, channel_id: existing.id, action: "already_exists" });
          } else {
            // Create it
            const { ok: createOk, data: created } = await discordFetch(`/guilds/${guildId}/channels`, {
              method: "POST",
              body: { name: req.name, type: 0, topic: req.topic },
            });

            if (createOk) {
              results.push({ name: req.name, channel_id: created.id, action: "created" });
            } else {
              results.push({ name: req.name, channel_id: "", action: `failed: ${JSON.stringify(created)}` });
            }
          }
        }

        const allSuccess = results.every(r => r.action === "created" || r.action === "already_exists");
        const channelMap: Record<string, string> = {};
        for (const r of results) {
          channelMap[r.name] = r.channel_id;
        }

        return {
          success: allSuccess,
          output: JSON.stringify({
            guild_id: guildId,
            channels: results,
            config: {
              DISCORD_GUILD_ID: guildId,
              DISCORD_CHANNEL_CONVERSATION: channelMap["conversation"] || "",
              DISCORD_CHANNEL_UPDATES: channelMap["updates"] || "",
              DISCORD_CHANNEL_LOGS: channelMap["logs"] || "",
            },
            hint: allSuccess
              ? "Channels ready. Use discord.write_config to save the configuration."
              : "Some channels failed to create. Check bot permissions (needs Manage Channels).",
          }, null, 2),
          error: allSuccess ? undefined : "Some channels failed to create.",
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // discord.write_config
    // ----------------------------------------
    case "discord.write_config": {
      const requiredKeys = ["guild_id", "channel_conversation", "channel_updates", "channel_logs"];
      const missing = requiredKeys.filter(k => !args[k]);
      if (missing.length > 0) {
        return { success: false, output: "", error: `Missing required fields: ${missing.join(", ")}` };
      }

      try {
        // Non-sensitive config goes in ~/.bot/.env (guild/channel IDs aren't secrets)
        // Bot token is stored separately in the encrypted vault via secrets.prompt_user
        const envPath = resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot", ".env");

        let existing = "";
        try {
          existing = await fs.readFile(envPath, "utf-8");
        } catch { /* file doesn't exist yet */ }

        const envMap = new Map<string, string>();
        for (const line of existing.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            envMap.set(trimmed.substring(0, eqIdx).trim(), trimmed.substring(eqIdx + 1).trim());
          }
        }

        // Only non-sensitive config in .env — token is in the vault
        envMap.set("DISCORD_GUILD_ID", args.guild_id);
        envMap.set("DISCORD_CHANNEL_CONVERSATION", args.channel_conversation);
        envMap.set("DISCORD_CHANNEL_UPDATES", args.channel_updates);
        envMap.set("DISCORD_CHANNEL_LOGS", args.channel_logs);
        if (args.log_verbosity) {
          envMap.set("DISCORD_LOG_VERBOSITY", args.log_verbosity);
        }

        await fs.mkdir(dirname(envPath), { recursive: true });
        const lines = Array.from(envMap.entries()).map(([k, v]) => `${k}=${v}`);
        await fs.writeFile(envPath, lines.join("\n") + "\n", "utf-8");

        // Set non-sensitive values in current process env for immediate use
        process.env.DISCORD_GUILD_ID = args.guild_id;
        process.env.DISCORD_CHANNEL_CONVERSATION = args.channel_conversation;
        process.env.DISCORD_CHANNEL_UPDATES = args.channel_updates;
        process.env.DISCORD_CHANNEL_LOGS = args.channel_logs;
        if (args.log_verbosity) {
          process.env.DISCORD_LOG_VERBOSITY = args.log_verbosity;
        }

        const keysSet = ["DISCORD_GUILD_ID", "DISCORD_CHANNEL_CONVERSATION", "DISCORD_CHANNEL_UPDATES", "DISCORD_CHANNEL_LOGS"];
        if (args.log_verbosity) keysSet.push("DISCORD_LOG_VERBOSITY");

        return {
          success: true,
          output: JSON.stringify({
            written: true,
            token_storage: "server-encrypted vault (~/.bot/vault.json)",
            config_storage: "~/.bot/.env (non-sensitive config only)",
            keys_set: keysSet,
            hint: "Discord configuration saved. Bot token remains in the encrypted vault. Restart the local agent to activate the Discord adapter.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: `Failed to write config: ${err.message}` };
      }
    }

    // ----------------------------------------
    // discord.create_guild
    // ----------------------------------------
    case "discord.create_guild": {
      const name = args.name || "Agent HQ";

      try {
        const body: any = { name };

        const { ok, status, data } = await discordFetch("/guilds", {
          method: "POST",
          body,
        });

        if (!ok) {
          if (status === 400 && JSON.stringify(data).includes("Maximum number of guilds")) {
            return { success: false, output: "", error: "This bot is in too many servers (max 10 for guild creation). Remove the bot from some servers first, or create the server manually." };
          }
          return { success: false, output: "", error: `Discord API error: ${status} — ${JSON.stringify(data)}` };
        }

        // Find the first text channel (Discord creates a default #general)
        let defaultChannelId: string | undefined;
        if (Array.isArray(data.channels)) {
          const textChannel = data.channels.find((ch: any) => ch.type === 0);
          if (textChannel) defaultChannelId = textChannel.id;
        }

        return {
          success: true,
          output: JSON.stringify({
            created: true,
            guild_id: data.id,
            guild_name: data.name,
            owner: true,
            default_channel_id: defaultChannelId || null,
            hint: "Server created — the bot is automatically the owner. Next: use discord.setup_channels to create the standard channels, then discord.create_invite to generate a join link for the user.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // discord.full_setup
    // ----------------------------------------
    case "discord.full_setup": {
      const serverName = args.name || "Agent HQ";

      try {
        const steps: string[] = [];
        let guildId: string;
        let conversationId = "";
        let updatesId = "";
        let logsId = "";

        // --- Step 1: Check for existing guild or create new one ---
        const { ok: guildsOk, data: guildsData } = await discordFetch("/users/@me/guilds");
        if (!guildsOk) {
          return { success: false, output: "", error: "Couldn't check existing servers. Is the bot token valid? Try running discord.validate_token first." };
        }

        const existingGuild = Array.isArray(guildsData) 
          ? guildsData.find((g: any) => g.owner === true)
          : null;

        if (existingGuild) {
          guildId = existingGuild.id;
          steps.push(`Found existing bot-owned server: "${existingGuild.name}" (${guildId})`);
        } else {
          // Create new guild
          const { ok: createOk, status: createStatus, data: createData } = await discordFetch("/guilds", {
            method: "POST",
            body: { name: serverName },
          });

          if (!createOk) {
            if (createStatus === 400 && JSON.stringify(createData).includes("Maximum number of guilds")) {
              return { success: false, output: "", error: `The bot is in too many servers (Discord limits guild creation to bots in fewer than 10 servers). Remove the bot from some servers first, or tell me which existing server to use.` };
            }
            return { success: false, output: "", error: `Couldn't create the server: ${JSON.stringify(createData)}` };
          }

          guildId = createData.id;
          steps.push(`Created server: "${createData.name}" (${guildId})`);
        }

        // --- Step 2: Create channels (idempotent — skips existing) ---
        const requiredChannels = [
          { name: "conversation", topic: "Main chat channel — talk to DotBot here" },
          { name: "updates", topic: "Live task progress feed" },
          { name: "logs", topic: "Diagnostic trace — LLM calls, tool executions" },
        ];

        const { ok: chListOk, data: existingChannels } = await discordFetch(`/guilds/${guildId}/channels`);
        if (!chListOk) {
          return { success: false, output: "", error: `Server created but couldn't list channels. Guild ID: ${guildId}` };
        }

        for (const req of requiredChannels) {
          const existing = (existingChannels as any[]).find(
            (ch: any) => ch.name === req.name && ch.type === 0
          );

          if (existing) {
            if (req.name === "conversation") conversationId = existing.id;
            else if (req.name === "updates") updatesId = existing.id;
            else if (req.name === "logs") logsId = existing.id;
            steps.push(`Channel #${req.name} already exists (${existing.id})`);
          } else {
            const { ok: chOk, data: chData } = await discordFetch(`/guilds/${guildId}/channels`, {
              method: "POST",
              body: { name: req.name, type: 0, topic: req.topic },
            });

            if (chOk) {
              if (req.name === "conversation") conversationId = chData.id;
              else if (req.name === "updates") updatesId = chData.id;
              else if (req.name === "logs") logsId = chData.id;
              steps.push(`Created #${req.name} (${chData.id})`);
            } else {
              steps.push(`Failed to create #${req.name}: ${JSON.stringify(chData)}`);
            }
          }
        }

        if (!conversationId) {
          return { success: false, output: JSON.stringify({ steps }, null, 2), error: "Couldn't create or find the #conversation channel. Check bot permissions." };
        }

        // --- Step 3: Create invite ---
        const { ok: invOk, data: invData } = await discordFetch(`/channels/${conversationId}/invites`, {
          method: "POST",
          body: { max_age: 0, max_uses: 0 },
        });

        let inviteUrl = "";
        let qrUrl = "";
        if (invOk) {
          inviteUrl = `https://discord.gg/${invData.code}`;
          qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(inviteUrl)}`;
          steps.push(`Invite created: ${inviteUrl}`);
        } else {
          steps.push(`Warning: Couldn't create invite. You can create one manually in Discord.`);
        }

        // --- Step 4: Write config ---
        const envPath = resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot", ".env");

        let existing = "";
        try {
          existing = await fs.readFile(envPath, "utf-8");
        } catch { /* file doesn't exist yet */ }

        const envMap = new Map<string, string>();
        for (const line of existing.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            envMap.set(trimmed.substring(0, eqIdx).trim(), trimmed.substring(eqIdx + 1).trim());
          }
        }

        envMap.set("DISCORD_GUILD_ID", guildId);
        envMap.set("DISCORD_CHANNEL_CONVERSATION", conversationId);
        if (updatesId) envMap.set("DISCORD_CHANNEL_UPDATES", updatesId);
        if (logsId) envMap.set("DISCORD_CHANNEL_LOGS", logsId);

        await fs.mkdir(dirname(envPath), { recursive: true });
        const lines = Array.from(envMap.entries()).map(([k, v]) => `${k}=${v}`);
        await fs.writeFile(envPath, lines.join("\n") + "\n", "utf-8");

        process.env.DISCORD_GUILD_ID = guildId;
        process.env.DISCORD_CHANNEL_CONVERSATION = conversationId;
        if (updatesId) process.env.DISCORD_CHANNEL_UPDATES = updatesId;
        if (logsId) process.env.DISCORD_CHANNEL_LOGS = logsId;

        steps.push("Config saved to ~/.bot/.env");

        return {
          success: true,
          output: JSON.stringify({
            setup_complete: true,
            guild_id: guildId,
            guild_name: existingGuild?.name || serverName,
            channels: {
              conversation: conversationId,
              updates: updatesId || null,
              logs: logsId || null,
            },
            invite_url: inviteUrl || null,
            qr_url: qrUrl || null,
            steps,
            hint: inviteUrl
              ? `Everything is set up! Tell the user to click this link to join: ${inviteUrl} — or scan the QR code from their phone. Then restart the agent with .\\run.bat to activate Discord.`
              : "Server and channels are ready but the invite link couldn't be created. The user can join manually from Discord.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: `Setup failed: ${err.message}` };
      }
    }

    // ----------------------------------------
    // discord.create_invite
    // ----------------------------------------
    case "discord.create_invite": {
      const channelId = args.channel_id;
      if (!channelId) return { success: false, output: "", error: "channel_id is required." };

      try {
        const body: any = {
          max_age: args.max_age ?? 0,     // 0 = never expires
          max_uses: args.max_uses ?? 0,   // 0 = unlimited
        };

        const { ok, status, data } = await discordFetch(`/channels/${channelId}/invites`, {
          method: "POST",
          body,
        });

        if (!ok) return { success: false, output: "", error: `Discord API error: ${status} — ${JSON.stringify(data)}` };

        const inviteUrl = `https://discord.gg/${data.code}`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(inviteUrl)}`;

        return {
          success: true,
          output: JSON.stringify({
            invite_url: inviteUrl,
            invite_code: data.code,
            qr_url: qrUrl,
            max_age: data.max_age,
            max_uses: data.max_uses,
            channel_id: channelId,
            hint: "Share this invite link with the user. They can also scan the QR code from their phone to join via the Discord mobile app.",
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // discord.send_message
    // ----------------------------------------
    case "discord.send_message": {
      const channelId = args.channel_id;
      const content = args.content;
      const embeds = args.embeds;
      const linkButtons = args.link_buttons;
      const actionButtons = args.action_buttons;
      if (!channelId) return { success: false, output: "", error: "channel_id is required." };
      if (!content && (!embeds || embeds.length === 0) && (!linkButtons || linkButtons.length === 0) && (!actionButtons || actionButtons.length === 0)) {
        return { success: false, output: "", error: "At least one of content, embeds, link_buttons, or action_buttons is required." };
      }

      try {
        const body: Record<string, any> = {};
        if (content) body.content = content;
        if (embeds && embeds.length > 0) body.embeds = embeds;

        // Collect all buttons (link + action) into Action Rows
        const allButtons: any[] = [];

        // Link buttons (style 5)
        if (linkButtons && linkButtons.length > 0) {
          for (const btn of linkButtons) {
            const button: any = {
              type: 2, style: 5, // Link
              label: btn.label || "Link",
              url: btn.url,
            };
            if (btn.emoji) button.emoji = { name: btn.emoji };
            allButtons.push(button);
          }
        }

        // Action buttons (styles 1-4, with custom_id)
        const STYLE_MAP: Record<string, number> = {
          primary: 1, secondary: 2, success: 3, danger: 4,
        };
        if (actionButtons && actionButtons.length > 0) {
          for (const btn of actionButtons) {
            const button: any = {
              type: 2,
              style: STYLE_MAP[btn.style] || 1,
              label: btn.label || "Button",
              custom_id: btn.custom_id,
            };
            if (btn.emoji) button.emoji = { name: btn.emoji };
            allButtons.push(button);
          }
        }

        // Pack buttons into Action Rows (max 5 per row, max 5 rows)
        if (allButtons.length > 0) {
          const components: any[] = [];
          for (let i = 0; i < allButtons.length; i += 5) {
            components.push({
              type: 1, // Action Row
              components: allButtons.slice(i, i + 5),
            });
          }
          body.components = components;
        }

        const { ok, status, data } = await discordFetch(`/channels/${channelId}/messages`, {
          method: "POST",
          body,
        });

        if (!ok) return { success: false, output: "", error: `Discord API error: ${status} — ${JSON.stringify(data)}` };

        return {
          success: true,
          output: JSON.stringify({
            sent: true,
            message_id: data.id,
            channel_id: channelId,
            has_embeds: !!(embeds && embeds.length > 0),
            has_link_buttons: !!(linkButtons && linkButtons.length > 0),
            has_action_buttons: !!(actionButtons && actionButtons.length > 0),
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    // ----------------------------------------
    // discord.send_file
    // ----------------------------------------
    case "discord.send_file": {
      const channelId = args.channel_id;
      const filePath = args.file_path;
      const content = args.content;
      if (!channelId) return { success: false, output: "", error: "channel_id is required." };
      if (!filePath) return { success: false, output: "", error: "file_path is required." };

      try {
        // Resolve and read file
        const resolvedPath = resolve(filePath);
        const stat = await fs.stat(resolvedPath);

        if (!stat.isFile()) {
          return { success: false, output: "", error: `Not a file: ${resolvedPath}` };
        }

        // Discord free tier limit: 8MB
        const MAX_FILE_SIZE = 8 * 1024 * 1024;
        if (stat.size > MAX_FILE_SIZE) {
          return { success: false, output: "", error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Discord free tier limit is 8MB.` };
        }

        const fileData = await fs.readFile(resolvedPath);
        const base64Data = fileData.toString("base64");
        const filename = resolvedPath.split(/[/\\]/).pop() || "file";

        // Determine content type from extension
        const ext = filename.split(".").pop()?.toLowerCase() || "";
        const mimeTypes: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
          webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
          mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
          mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
          pdf: "application/pdf", zip: "application/zip",
          txt: "text/plain", json: "application/json", csv: "text/csv",
        };
        const contentType = mimeTypes[ext] || "application/octet-stream";

        // Build multipart request via credential proxy
        const payloadJson: Record<string, any> = {};
        if (content) payloadJson.content = content;

        const res = await credentialProxyFetch(`/channels/${channelId}/messages`, DISCORD_CREDENTIAL_NAME, {
          baseUrl: DISCORD_API,
          method: "POST",
          headers: {
            "User-Agent": "DotBot (https://getmy.bot, 1.0)",
          },
          body: JSON.stringify(payloadJson),
          files: [{
            fieldName: "files[0]",
            filename,
            contentType,
            data: base64Data,
          }],
          placement: { header: "Authorization", prefix: "Bot " },
        });

        if (!res.ok) {
          let errorMsg = `Discord API error: ${res.status}`;
          try {
            const errData = JSON.parse(res.body);
            errorMsg += ` — ${JSON.stringify(errData)}`;
          } catch { errorMsg += ` — ${res.body.substring(0, 200)}`; }
          return { success: false, output: "", error: errorMsg };
        }

        let responseData: any;
        try { responseData = JSON.parse(res.body); } catch { responseData = {}; }

        return {
          success: true,
          output: JSON.stringify({
            sent: true,
            message_id: responseData.id,
            channel_id: channelId,
            filename,
            size_bytes: stat.size,
            content_type: contentType,
          }, null, 2),
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    }

    default:
      return { success: false, output: "", error: `Unknown discord tool: ${toolId}` };
  }
}
