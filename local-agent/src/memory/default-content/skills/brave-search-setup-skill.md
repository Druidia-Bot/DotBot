---
name: brave-search-setup
description: Sets up Brave Search so DotBot can search the web. Walks the user through getting a free API key and securely stores it.
tags: [brave, search, setup, api, web, credential]
disable-model-invocation: true
user-invocable: true
allowed-tools: [search.brave, secrets.prompt_user]
---

# Brave Search Setup — Web Search for DotBot

This skill connects DotBot to Brave Search so it can find information on the web. Brave Search offers 2,000 free queries per month — no credit card required.

**EXECUTION MODEL: This is an autonomous skill. Do NOT stop to wait for user confirmation between steps. Call each tool in sequence. The blocking call (`secrets.prompt_user`) IS the wait — it opens a secure window and pauses until the user enters the key. After that, verify it works immediately.**

## Execution Flow

```
1. search.brave({ query: "test" })
   ├─ Key exists + works → done, tell user it's already set up
   └─ No key             → continue to step 2
2. Output ALL instructions (see below) as a single message
3. secrets.prompt_user({...})          ← BLOCKS up to 15 minutes
4. search.brave({ query: "test" })    ← verify the key works
5. Present results
```

**Do NOT output a plan and stop. Execute the tools.**

---

## Step 1: Pre-Flight Check

```
search.brave({ query: "test" })
```

- **If results returned:** The API key is already configured and working. Tell the user and stop.
- **If "not configured" message:** Continue to Step 2.

---

## Step 2: Give Instructions + Collect Key (ONE message, then ONE tool call)

Output ALL of the following instructions in a single message, then IMMEDIATELY call `secrets.prompt_user`. Do not wait for user replies between these instructions.

Tell the user:

> I'll set up web search so I can find information online for you. You just need to grab a free API key from Brave (~1 minute).
>
> **Here's what to do:**
>
> 1. Open this link: **[brave.com/search/api](https://brave.com/search/api/)**
> 2. Click **"Get Started for Free"**
> 3. Create an account (or sign in if you have one)
> 4. On the dashboard, click **"+ Add a subscription"** → choose **"Free"** (2,000 queries/month)
> 5. Once subscribed, go to **API Keys** and click **"Copy"** next to your key
>
> **I'm opening a secure window now. Paste the API key there when you have it.**

**IMPORTANT:** Present the Brave link as a markdown link so it's clickable. Do NOT use `gui.open_in_browser`.

Then IMMEDIATELY call:

```
secrets.prompt_user({
  key_name: "BRAVE_SEARCH_API_KEY",
  prompt: "Paste your Brave Search API key here.\n\nSteps:\n1. Go to brave.com/search/api\n2. Click 'Get Started for Free' and create an account\n3. Add a Free subscription (2,000 queries/month)\n4. Go to API Keys and copy your key\n5. Paste it below\n\nThis value is encrypted and never leaves your machine in readable form.",
  allowed_domain: "api.search.brave.com"
})
```

This call **blocks until the user enters the key** (up to 15 minutes). Do not output more text or make other tool calls until this returns.

**Do NOT open the browser or call any other tools while waiting.** If the call returns an error (timeout or cancelled), STOP and ask the user what happened — do NOT automatically retry.

---

## Step 3: Verify Key

After `secrets.prompt_user` succeeds:

```
search.brave({ query: "hello world" })
```

- **If results returned:** Success! Tell the user web search is ready.
- **If 401/403 error:** Key was probably copied wrong. Tell the user to check the key and re-call `secrets.prompt_user`.

---

## Step 4: Present Results

> **Web search is ready!** 🔍
>
> I can now search the web for you using Brave Search (2,000 free queries/month). Just ask me anything that needs current information — news, research, how-tos, documentation, etc.
>
> Try it out: ask me to search for something!

---

## Troubleshooting

### Key entry timed out or was cancelled
**STOP. Do NOT automatically retry.** Tell the user:
> The secure entry window timed out. No worries — just let me know when you're ready and I'll open it again.

Only re-call `secrets.prompt_user` after the user explicitly says to try again.

### Key validation failed (401/403)
The key was probably copied wrong or the subscription isn't active. Tell the user to:
1. Go back to [brave.com/search/api](https://brave.com/search/api/)
2. Make sure they have an active Free subscription
3. Copy the API key again carefully
Then re-call `secrets.prompt_user`.

### User doesn't want to sign up
That's fine! DotBot still has `ddg_instant` for quick lookups and `http_request` for direct API calls. Brave Search just adds full web search capability.
