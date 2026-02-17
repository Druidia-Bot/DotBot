# Credential System — Agent Instructions

## SECURITY RULES — READ FIRST

- **NEVER log decrypted credential values** — not in console.log, not in error messages, not in debug output
- **NEVER include credential values in WS messages** — only encrypted blobs cross the wire
- **NEVER store plaintext credentials on disk** — server holds only the master key; client holds only encrypted blobs
- **`allowed_domain` is always required** — credentials are cryptographically bound to their API domain

## Architecture: Split-Knowledge

| Component | Location | Purpose |
|-----------|----------|---------|
| Encrypted blob (`srv:...`) | Client `~/.bot/vault.json` | Ciphertext — useless without server key |
| Master key | Server `~/.bot/server-data/master.key` | 32 bytes AES key — useless without blob |
| Plaintext | Neither (server RAM only during `fetch()`) | Exists for milliseconds |

## Directory Structure

```
credentials/
  crypto.ts                        — AES-256-GCM + HKDF encryption
  sessions.ts                      — One-time entry sessions (15-min TTL, in-memory)
  proxy.ts                         — SSRF-safe HTTP proxy with credential injection
  routes.ts                        — HTTP entry page + CSP headers + rate limiting
  handlers/
    session-request.ts             — handleCredentialSessionRequest (WS → create entry session)
    proxy-request.ts               — handleCredentialProxyRequest (WS → decrypt + proxy HTTP call)
    resolve.ts                     — handleCredentialResolveRequest + resolve tracking + cleanup
    index.ts                       — Barrel re-export
  templates/
    entry.html                     — Credential entry form (Tailwind CDN)
    success.html                   — Success confirmation
    expired.html                   — Expired session
    error.html                     — Generic error
    session-unauthed.html          — Auth required landing
    session-authed.html            — Authenticated session info
    index.ts                       — Template loader + {{placeholder}} interpolation
  __tests__/
    crypto.test.ts
    proxy.test.ts
    sessions.test.ts
```

## Domain-Scoped Encryption

The domain is baked into the HKDF key derivation:
```
deriveUserKey(userId, domain) → HKDF("sha512", masterKey, userId, "dotbot-credential-v1:{domain}", 32)
```

Double enforcement on decrypt:
1. **Belt**: explicit `blob.d !== requestDomain` check → clear "Domain mismatch" error
2. **Suspenders**: wrong domain → wrong HKDF key → AES-GCM auth tag failure

## Blob Format

```json
{ "v": 1, "u": "userId", "d": "discord.com", "iv": "hex", "tag": "hex", "ct": "hex" }
```
→ JSON → base64 → `"srv:"` prefix → stored in client vault

## When Modifying This Code

- All `encryptCredential()` calls MUST include `allowedDomain` as third parameter
- All `createSession()` calls MUST include `allowedDomain` in the options object
- `proxy.ts` extracts the hostname from the request URL and passes it to `decryptCredential()` — do not remove this
- Rate limiting uses `_clearRateLimits()` for testing — don't remove the export
- CSP headers are on ALL HTML responses from credential routes — `cspHeaders()` helper allows Tailwind CDN
- Sessions are one-time use: `consumeSession()` marks them consumed, they're deleted after a grace period
- Templates use `{{placeholder}}` syntax — `formatPrompt()` auto-links URLs and formats numbered steps

## Testing Helpers

- `_setMasterKeyForTesting(key: Buffer)` — inject a known master key in tests
- `_clearMasterKey()` — reset master key state between tests
- `_clearRateLimits()` — reset rate limiter between tests
- `_clearAllSessions()` — reset session store between tests
- Always use these in `beforeEach`/`afterEach` — never leave test state leaking
