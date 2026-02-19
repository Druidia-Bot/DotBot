---
name: mcp-setup
description: Set up a new MCP (Model Context Protocol) server connection to integrate external services like LobsterBands, Gmail, Slack, Notion, GitHub, etc.
tags: [mcp, integration, api, connect, external, service, lobsterbands]
disable-model-invocation: false
user-invocable: true
allowed-tools: [mcp.setup_server, mcp.list_servers, mcp.remove_server, secrets.prompt_user, secrets.list_keys, search.brave, http.request]
---

# MCP Server Setup

MCP (Model Context Protocol) lets DotBot connect to external services through a standardized protocol. Each MCP server exposes tools that become available to all personas.

## When to Use This

- User asks to connect a new service (e.g., "connect to LobsterBands", "set up Gmail integration")
- User asks about available integrations or MCP servers
- An MCP tool returns an authentication error (credential may need refresh)

## Setup Flow

### 1. Check Current State
```
mcp.list_servers  → see what's already configured
```

### 2. Find the MCP Endpoint
If the user provides the URL, use it directly. Otherwise:
- Check the service's documentation for MCP/SSE endpoint
- Common pattern: `https://<service>.com/mcp/sse`
- Use `search.brave` if needed to find the endpoint URL

### 3. Set Up Credentials (if required)
```
secrets.list_keys  → check if credential already exists
secrets.prompt_user(name: "SERVICE_API_TOKEN", allowed_domain: "service.com")  → store securely
```

**Important:** The `allowed_domain` must match the MCP server's domain. Credentials are cryptographically bound to their domain.

### 4. Create the Configuration
```
mcp.setup_server(
  name: "service-name",
  transport: "sse",
  url: "https://service.com/mcp/sse",
  credentialRequired: "SERVICE_API_TOKEN"
)
```

### 5. Restart to Activate
```
Tell the user: "The MCP server is configured. I need to restart to activate the connection. Shall I restart now?"
```
If yes: `system.restart`

### 6. Verify After Restart
```
mcp.list_servers  → confirm status is "connected"
tools.list_tools(category: "mcp.service-name")  → see discovered tools
```

## Transport Types

| Transport | When to Use |
|-----------|-------------|
| `streamable-http` | **Preferred** — newer HTTP-based MCP servers (try this first) |
| `sse` | Legacy SSE transport (some servers have bugs with empty SSE events) |
| `stdio` | Local tools running as child processes |

## Security Model

- **Credentialed servers** (with `credentialRequired`) connect through the **server-side gateway**. The plaintext credential never exists on the local machine — it's decrypted only on the server and injected into the MCP transport headers.
- **Non-credentialed servers** (local stdio tools, public servers) connect directly from the local agent.
- Never put plaintext tokens in the config file. Always use the vault via `secrets.prompt_user`.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Server shows "not connected" | Check URL is correct, credential exists in vault, restart agent |
| Authentication error from MCP tool | Credential may be expired — use `secrets.prompt_user` to re-enter |
| No tools discovered | Server may be down or URL may be wrong — check with `http.request` |
| "Unexpected end of JSON input" | SSE transport bug — switch to `streamable-http` transport |
| Config file not found | Use `mcp.setup_server` to create it |

## Known MCP Services

| Service | URL Pattern | Credential |
|---------|-------------|------------|
| LobsterBands | `https://lobsterbands.com/mcp/sse` (transport: `streamable-http`) | `LOBSTERBANDS_API_TOKEN` |

*Add more services here as they're discovered.*
