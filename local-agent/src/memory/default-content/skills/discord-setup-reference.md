# Discord Setup — Manual Reference Guide

Step-by-step manual instructions for setting up Discord with DotBot. Use this as a fallback if the automated skill encounters issues, or to understand what each step does.

The automated skill handles most of this via API, but the Developer Portal steps (1-2) must always be done manually in a browser.

---

## What You'll Create

| Component | Purpose |
|-----------|---------|
| **Bot Application** | The "DotBot" bot user — created in Discord's Developer Portal |
| **Bot Token** | Credential stored in DotBot's encrypted vault (never in plaintext) |
| **Discord Server** | "Agent HQ" — bot-owned, created via API |
| **#conversation** | Main chat channel — you talk to DotBot here, it responds here |
| **#updates** | Live task progress feed — what DotBot is doing right now |
| **#logs** | Diagnostic trace — LLM calls, tool executions, debug info |
| **Invite Link + QR** | For you to join the bot's server from browser or phone |

---

## Step 1: Create the Bot Application (Manual — Developer Portal)

Discord provides no API for creating bot applications. This must be done in a browser.

1. Go to https://discord.com/developers/applications
2. Log in with your Discord account (or create one at https://discord.com/register)
3. Click **"New Application"** (top right)
4. Name: **DotBot**
5. Check the Terms of Service checkbox if prompted
6. Click **"Create"**

---

## Step 2: Get the Bot Token & Enable Intents (Manual — Developer Portal)

### Get the Token
1. Click **"Bot"** in the left sidebar
2. The bot user is auto-created with modern applications. If you see "Add Bot", click it and confirm.
3. Click **"Reset Token"** → confirm with 2FA if prompted
4. **IMMEDIATELY copy the token** — Discord only shows it once!
5. **NEVER share this token.** Anyone with it can control your bot.

### Enable Required Intents
Scroll down to "Privileged Gateway Intents":
1. Toggle ON **MESSAGE CONTENT INTENT** — required to read message text
2. Toggle ON **SERVER MEMBERS INTENT** — recommended
3. Click **"Save Changes"**

---

## Step 3: Store the Token Securely (Automated or Manual)

### Automated (preferred)
The discord-setup skill uses `secrets.prompt_user` which opens a secure entry page:
- Token is encrypted server-side and cryptographically bound to `discord.com`
- Stored in DotBot's encrypted vault (`~/.bot/vault.json`)
- Never appears in plaintext in logs, chat, or .env files

### Manual fallback
If the automated flow isn't available, store it directly:
```
discord.validate_token({ token: "YOUR_TOKEN_HERE" })
```
This validates AND auto-stores the token in the vault.

---

## Step 4: Create the Server (Automated via API)

The bot creates its own server — it becomes the owner automatically.

### Automated
```
discord.create_guild({ name: "Agent HQ" })
```
Returns the `guild_id`. The bot is the owner with full permissions.

### Manual fallback
If the API fails (e.g., bot is in 10+ servers):
1. Open Discord → click **"+"** in the server sidebar
2. Click **"Create My Own"** → **"For me and my friends"**
3. Name: **Agent HQ**
4. Click **"Create"**
5. Get the Guild ID from the URL: `discord.com/channels/GUILD_ID/...`
6. Then invite the bot: `discord.get_invite_url({})` → open the URL → select your server

---

## Step 5: Create Channels (Automated via API)

### Automated
```
discord.setup_channels({ guild_id: "<GUILD_ID>" })
```
Creates all three channels, skips any that already exist.

### Manual fallback
For each channel (#conversation, #updates, #logs):
1. Click **"+"** next to "TEXT CHANNELS" in the sidebar
2. Enter the name → click **"Create Channel"**
3. Get the Channel ID: right-click channel → "Copy Channel ID" (requires Developer Mode)

---

## Step 6: Generate Invite & Join (Automated via API)

### Automated
```
discord.create_invite({ channel_id: "<CONVERSATION_CHANNEL_ID>" })
```
Returns an invite URL and QR code image URL. Click the link or scan the QR from your phone.

### Manual fallback
1. In Discord, right-click the #conversation channel
2. Click **"Invite People"**
3. Click **"Edit invite link"** → set to **Never expire**, **No limit**
4. Copy the link → open it in your browser or share to your phone

---

## Step 7: Write Configuration (Automated via API)

### Automated
```
discord.write_config({
  guild_id: "<GUILD_ID>",
  channel_conversation: "<CONVERSATION_ID>",
  channel_updates: "<UPDATES_ID>",
  channel_logs: "<LOGS_ID>"
})
```
Writes non-sensitive config to `~/.bot/.env`. Token stays in the encrypted vault.

### Manual fallback
Add to `~/.bot/.env`:
```bash
DISCORD_GUILD_ID=your_guild_id_here
DISCORD_CHANNEL_CONVERSATION=channel_id_for_conversation
DISCORD_CHANNEL_UPDATES=channel_id_for_updates
DISCORD_CHANNEL_LOGS=channel_id_for_logs
```

**NOTE:** The bot token should NOT go in .env. It belongs in the encrypted vault.

---

## Step 8: Restart & Verify

1. Stop the local agent: `.\stop.bat`
2. Start it again: `.\run.bat`
3. The agent should log: `[Discord] Connected and listening`
4. Go to Agent HQ in Discord
5. Type a message in #conversation — DotBot should respond!
6. Install the Discord app on your phone for mobile access

---

## Troubleshooting

### Bot appears offline
- Check the agent logs for Discord connection errors
- Verify the token is valid: `discord.validate_token({})`
- Verify the MESSAGE CONTENT INTENT is enabled in the Developer Portal

### Bot doesn't respond to messages
- Verify DISCORD_CHANNEL_CONVERSATION in `~/.bot/.env` matches the actual #conversation channel ID
- Check that the bot has permissions (it should — it owns the server)
- Enable Developer Mode and double-check channel IDs

### "Used disallowed intents" error
- Go to Developer Portal → Bot → enable MESSAGE CONTENT INTENT
- Save changes and restart the agent

### "Maximum number of guilds" error
- The bot is in 10+ servers (Discord's limit for `POST /guilds`)
- Remove the bot from unused servers, or create the server manually (see Step 4 fallback)

### Getting IDs with Developer Mode
1. Open Discord Settings (gear icon)
2. Go to **Advanced** (under App Settings)
3. Toggle **Developer Mode** ON
4. Now you can right-click:
   - Server name → **Copy Server ID** (= Guild ID)
   - Any channel → **Copy Channel ID**
   - Any user → **Copy User ID**

---

## Security Notes

- **Bot token** is stored in DotBot's encrypted vault (`~/.bot/vault.json`), encrypted server-side with AES-256-GCM — never in plaintext
- The token is cryptographically bound to `discord.com` — it can only be used for Discord API calls
- The DotBot cloud server never sees the plaintext token
- The bot only listens to messages in the configured GUILD_ID
- Only messages from DISCORD_CHANNEL_CONVERSATION are treated as prompts
- Other channels (#updates, #logs) are output-only
- For extra security, add `DISCORD_ALLOWED_USERS=your_discord_user_id` to `~/.bot/.env` to restrict who can send commands
