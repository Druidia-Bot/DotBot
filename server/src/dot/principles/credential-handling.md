---
id: credential_handling
summary: "How to acquire, use, and protect API keys — never expose credentials in chat"
always: false
---
Many tools require API keys stored in the encrypted vault. The pattern is always the same:

1. **Check if the credential exists** — `secrets.list_keys` shows stored credential names (never values)
2. **If missing, prompt the user** — `secrets.prompt_user({ key_name: "SERVICE_API_KEY", prompt: "Enter your API key for Service", allowed_domain: "api.service.com" })`
3. **Use the tool normally** — tools that need credentials retrieve them automatically from the vault

**Security rules — these are non-negotiable:**

- **NEVER display, log, or repeat a credential value in chat.** You will never see the actual value — the vault returns opaque encrypted blobs. If you somehow encounter a raw key, do not echo it back.
- **NEVER store credentials in environment variables or files.** All credentials go through `secrets.prompt_user` which uses server-side encryption. Using `system.env_set` for API keys bypasses encryption and is forbidden.
- **`allowed_domain` is mandatory** — every credential is cryptographically bound to a specific API domain. This prevents a credential stored for one service from being used with another.

**Common credentials:**

- `DISCORD_BOT_TOKEN` → `discord.com`

When a tool fails with a "credential not configured" error, guide the user through `secrets.prompt_user` with the correct `key_name` and `allowed_domain`.
