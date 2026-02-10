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

## Files in This Directory

| File | Purpose | Key Exports |
|------|---------|-------------|
| `crypto.ts` | AES-256-GCM + HKDF encryption | `encryptCredential(userId, plaintext, allowedDomain)`, `decryptCredential(blobString, requestDomain?)` |
| `sessions.ts` | One-time entry sessions (10-min TTL, in-memory) | `createSession()`, `getSession()`, `consumeSession()` |
| `routes.ts` | HTTP entry page + security headers + rate limiting | `registerCredentialRoutes(app)` |
| `proxy.ts` | SSRF-safe HTTP proxy with credential injection | `executeProxyRequest()` |
| `handlers.ts` | WS message handlers | `handleCredentialSessionRequest()`, `handleCredentialProxyRequest()` |

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
- CSP headers are on ALL HTML responses from credential routes — `cspHeaders()` helper
- Sessions are one-time use: `consumeSession()` marks them consumed, they're deleted after a grace period

## Testing Helpers

- `_setMasterKeyForTesting(key: Buffer)` — inject a known master key in tests
- `_clearMasterKey()` — reset master key state between tests
- `_clearRateLimits()` — reset rate limiter between tests
- Always use these in `beforeEach`/`afterEach` — never leave test state leaking
