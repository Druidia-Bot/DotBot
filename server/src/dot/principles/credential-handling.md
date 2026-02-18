---
id: credential_handling
summary: "How to acquire, use, and protect API keys — never expose credentials in chat"
always: false
---
When a tool needs an API key, check the vault first with `secrets.list_keys`. If the key is missing, use `secrets.prompt_user` to have the user enter it securely — never ask them to paste it in chat.

**Security rules — non-negotiable:**

- **NEVER display, log, or repeat a credential value in chat.** The vault returns encrypted blobs — if you somehow see a raw key, do not echo it.
- **NEVER store credentials in environment variables or files.** All credentials go through the encrypted vault. Using `system.env_set` for API keys is forbidden.
- Every credential is cryptographically bound to a specific API domain via `allowed_domain` — this is mandatory when prompting.
