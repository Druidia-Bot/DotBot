---
name: discord-setup
description: Sets up Discord so the user can chat with DotBot from their phone or browser. Walks through creating a bot app on Discord, then automates everything else in one shot — server, channels, invite link, and QR code.
tags: [discord, setup, automation, bot, channel, api, server, mobile]
disable-model-invocation: true
user-invocable: true
allowed-tools: [discord.validate_token, discord.full_setup, discord.send_message, discord.create_guild, discord.setup_channels, discord.create_invite, discord.list_guilds, discord.write_config, secrets.prompt_user, system.restart]
---

# Discord Setup — Talk to DotBot from Anywhere

This skill connects DotBot to Discord so the user can chat from their phone, browser, or any device.

**EXECUTION MODEL: This is an autonomous skill. Do NOT stop to wait for user confirmation between steps. Call each tool in sequence. The blocking call (`secrets.prompt_user`) IS the wait — it opens a secure window and pauses until the user enters the token. After that, run the remaining tools immediately.**

## Execution Flow

```
1. discord.validate_token({})
   ├─ Token exists → skip to step 4
   └─ No token    → continue to step 2
2. Output ALL manual instructions (see below) as a single message
3. secrets.prompt_user({...})          ← BLOCKS up to 15 minutes
4. discord.validate_token({})          ← verify the token works
5. discord.full_setup({})              ← creates server + channels + invite + config
6. Present results with invite link + QR code
7. discord.send_message({...})         ← hello message in #conversation
8. system.restart({...})               ← restart to activate Discord adapter
```

**Do NOT output a plan and stop. Execute the tools.**

---

## Step 1: Pre-Flight Check

```
discord.validate_token({})
```

- **If valid:** Skip to Step 4 (`discord.full_setup`).
- **If no token:** Continue to Step 2.

---

## Step 2: Give Instructions + Collect Token (ONE message, then ONE tool call)

Output ALL of the following instructions in a single message, then IMMEDIATELY call `secrets.prompt_user`. Do not wait for user replies between these instructions.

**IMPORTANT:** The user only needs to create a **bot application** on Discord's website. You will create the Discord **server** automatically — tell them this explicitly so they don't try to create one themselves.

Tell the user:

> I'll set up Discord so you can talk to me from your phone or any browser. You just need to create the bot app — **I'll create the Discord server, channels, and everything else automatically.**
>
> **Here's the one manual part** (~2 minutes of clicking):
>
> 1. Open this link in a new tab: **https://discord.com/developers/applications**
> 2. Click the blue **"New Application"** button (top-right), name it **DotBot**, click **Create**
> 3. Click **"Bot"** in the left sidebar
> 4. Click **"Reset Token"** → confirm → click **"Copy"** immediately (it only shows once!)
> 5. Scroll down to **"Privileged Gateway Intents"** and turn on **MESSAGE CONTENT INTENT** (the other two are not needed)
> 6. Click **"Save Changes"**
>
> **I'm opening a secure window now. When you've copied the token from step 4, paste it there.**

**IMPORTANT:** Present the Discord Developer Portal link as a markdown link so it opens in a new tab: `[discord.com/developers/applications](https://discord.com/developers/applications)`. Do NOT use `gui.open_in_browser` — the link in your message is sufficient and keeps the user in control.

Then IMMEDIATELY call:

```
secrets.prompt_user({
  key_name: "DISCORD_BOT_TOKEN",
  prompt: "Paste your Discord bot token here.\n\nSteps:\n1. Go to discord.com/developers/applications\n2. Click 'New Application' → name it DotBot → Create\n3. Click 'Bot' in sidebar → 'Reset Token' → Copy\n4. Paste the token below\n\nThis value is encrypted and never leaves your machine in readable form.",
  allowed_domain: "discord.com"
})
```

This call **blocks until the user enters the token** (up to 15 minutes). That IS the wait. Do not output more text or make other tool calls until this returns.

**Do NOT open the browser or call any other tools while waiting.** The secure entry page is already open. If the call returns an error (timeout or cancelled), STOP and ask the user what happened — do NOT automatically retry or open browser windows.

---

## Step 3: Verify Token

After `secrets.prompt_user` succeeds:

```
discord.validate_token({})
```

If validation fails, the token was probably copied wrong. Tell the user to try again and re-call `secrets.prompt_user`.

---

## Step 4: Automatic Setup — One Shot

```
discord.full_setup({})
```

This single call does everything:
- Creates a Discord server called "Agent HQ"
- Creates #conversation, #updates, and #logs channels
- Generates an invite link + QR code for the user
- Saves all the configuration to `~/.bot/.env`

If it finds an existing setup, it picks up where it left off — no duplicates.

---

## Step 5: Present Results

Present the invite link and QR code. **Use markdown links so they open in a new tab:**

> **Your command center is ready!**
>
> Join here: **[Click to join Discord](<INVITE_URL>)**
>
> Or scan this QR code from your phone: **<QR_URL>**
>
> Once you're in, you can talk to me from the **#conversation** channel — from your phone, tablet, or any browser.
>
> **🔒 Security tip:** For added privacy, go into each channel's settings and set them to **private**. This ensures only you and the bot can see messages — even if someone else joins the server later.
>
> I'm going to send a hello message in #conversation and then restart to activate the Discord connection.

---

## Step 6: Send Hello Message

Use the `conversation` channel ID from the `discord.full_setup` result:

```
discord.send_message({
  channel_id: "<CONVERSATION_CHANNEL_ID>",
  content: "👋 Hello! I'm DotBot — your AI assistant. This channel is now connected. You can talk to me here from any device!\n\nTry saying \"hi\" or ask me anything."
})
```

If this fails (e.g., bot hasn't fully propagated yet), that's OK — continue to step 7.

---

## Step 7: Restart to Activate

```
system.restart({ reason: "Discord setup complete — restarting to activate Discord adapter" })
```

This restarts the local agent so it picks up the new Discord configuration. The user does NOT need to do anything manual.

---

## Troubleshooting

### Token entry timed out or was cancelled
**STOP. Do NOT automatically retry or open browser windows.** Tell the user:
> The secure entry window timed out. No worries — just let me know when you're ready and I'll open it again.

Only re-call `secrets.prompt_user` after the user explicitly says to try again.

### Token validation failed after entry
Token was probably copied wrong. Tell user to go back to Bot page, click "Reset Token" again, copy carefully. Then re-call `secrets.prompt_user`.

### "Too many servers" from full_setup
Run `discord.list_guilds({})` to see what servers the bot is in, help user decide which to keep.

### User already has a DotBot server
`discord.full_setup` handles this — detects existing bot-owned server and reuses it.

### User can't access Discord
Suggest trying from a different network or using a VPN.
