/**
 * Tool Handlers — Discord — Production Tests
 *
 * Tests all discord tool handlers with mocked server proxy (credentialProxyFetch).
 * All API calls go through the server proxy — no direct fetch, no DPAPI, no __credential.
 * The proxy mock uses a response queue (pushFetchResponse) to simulate Discord API responses.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// TEMP DIR
// ============================================

const tempDir = path.join(os.tmpdir(), `dotbot-discord-test-${Date.now()}`);
const tempBotDir = path.join(tempDir, ".bot");
const tempEnvPath = path.join(tempBotDir, ".env");
const originalUserProfile = process.env.USERPROFILE;

// ============================================
// HOISTED STATE (available to vi.mock factories)
// ============================================

const { mockVault, proxyResponses } = vi.hoisted(() => ({
  mockVault: new Map<string, string>(),
  proxyResponses: [] as { ok: boolean; status: number; body: any }[],
}));

// ============================================
// MOCK: credential-vault
// ============================================

vi.mock("../credential-vault.js", () => ({
  vaultSetServerBlob: vi.fn(async (name: string, blob: string) => { mockVault.set(name, blob); }),
  vaultGetBlob: vi.fn(async (name: string) => mockVault.get(name) ?? null),
  vaultHas: vi.fn(async (name: string) => mockVault.has(name)),
  vaultList: vi.fn(async () => [...mockVault.keys()]),
  vaultDelete: vi.fn(async (name: string) => { const had = mockVault.has(name); mockVault.delete(name); return had; }),
  isServerEncrypted: vi.fn(async (name: string) => { const v = mockVault.get(name); return !!v && v.startsWith("srv:"); }),
  invalidateCache: vi.fn(),
}));

// ============================================
// MOCK: credential-proxy (server proxy)
// ============================================

vi.mock("../credential-proxy.js", () => ({
  credentialProxyFetch: vi.fn(async (_path: string, credName: string, _opts: any) => {
    if (!mockVault.has(credName)) {
      throw new Error(`Credential "${credName}" not found in vault`);
    }
    const resp = proxyResponses.shift();
    if (!resp) throw new Error("Mock proxy: no response queued");
    return {
      ok: resp.ok,
      status: resp.status,
      headers: {},
      body: JSON.stringify(resp.body),
    };
  }),
}));

function pushFetchResponse(ok: boolean, status: number, body: any) {
  proxyResponses.push({ ok, status, body });
}

// ============================================
// IMPORT AFTER MOCKS
// ============================================

import { handleDiscord } from "./tool-handlers-discord.js";
import { credentialProxyFetch } from "../credential-proxy.js";
const mockProxyFetch = credentialProxyFetch as unknown as ReturnType<typeof vi.fn>;

// ============================================
// SETUP / TEARDOWN
// ============================================

beforeEach(async () => {
  process.env.USERPROFILE = tempDir;
  mockVault.clear();
  proxyResponses.length = 0;
  mockProxyFetch.mockClear();

  await fs.rm(tempBotDir, { recursive: true, force: true });
  await fs.mkdir(tempBotDir, { recursive: true });

  // Most tests need a token in the vault — pre-populate it
  mockVault.set("DISCORD_BOT_TOKEN", "srv:mock-encrypted-blob");
});

afterAll(async () => {
  process.env.USERPROFILE = originalUserProfile;
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ============================================
// discord.validate_token
// ============================================

describe("discord.validate_token", () => {
  it("returns bot info on valid token", async () => {
    pushFetchResponse(true, 200, {
      id: "123456789",
      username: "TestBot",
      discriminator: "0001",
    });

    const result = await handleDiscord("discord.validate_token", {});
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.valid).toBe(true);
    expect(data.bot_id).toBe("123456789");
    expect(data.bot_username).toBe("TestBot");
  });

  it("fails with 401 for invalid token", async () => {
    pushFetchResponse(false, 401, { message: "401: Unauthorized" });

    const result = await handleDiscord("discord.validate_token", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid bot token");
  });

  it("fails when no token in vault", async () => {
    mockVault.clear(); // no token
    const result = await handleDiscord("discord.validate_token", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in vault");
  });
});

// ============================================
// discord.get_invite_url
// ============================================

describe("discord.get_invite_url", () => {
  it("generates invite URL with explicit application_id", async () => {
    const result = await handleDiscord("discord.get_invite_url", {
      application_id: "999",
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.invite_url).toContain("client_id=999");
    expect(data.invite_url).toContain("permissions=8");
  });

  it("auto-detects application_id from token", async () => {
    pushFetchResponse(true, 200, { id: "auto-id-123", username: "Bot" });

    const result = await handleDiscord("discord.get_invite_url", {});
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.invite_url).toContain("client_id=auto-id-123");
  });

  it("uses custom permissions when provided", async () => {
    const result = await handleDiscord("discord.get_invite_url", {
      application_id: "999",
      permissions: "2048",
    });
    const data = JSON.parse(result.output);
    expect(data.invite_url).toContain("permissions=2048");
  });

  it("fails when no application_id and no token", async () => {
    mockVault.clear();
    const result = await handleDiscord("discord.get_invite_url", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in vault");
  });
});

// ============================================
// discord.list_guilds
// ============================================

describe("discord.list_guilds", () => {
  it("lists guilds the bot is in", async () => {
    pushFetchResponse(true, 200, [
      { id: "guild1", name: "Test Server", owner: true, permissions: "8" },
      { id: "guild2", name: "Other Server", owner: false, permissions: "0" },
    ]);

    const result = await handleDiscord("discord.list_guilds", {});
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.guild_count).toBe(2);
    expect(data.guilds[0].name).toBe("Test Server");
  });

  it("handles empty guild list", async () => {
    pushFetchResponse(true, 200, []);

    const result = await handleDiscord("discord.list_guilds", {});
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.guilds).toEqual([]);
    expect(data.hint).toContain("not in any servers");
  });

  it("fails when no token available", async () => {
    mockVault.clear();
    const result = await handleDiscord("discord.list_guilds", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in vault");
  });

  it("handles Discord API error", async () => {
    pushFetchResponse(false, 500, { message: "Internal Server Error" });

    const result = await handleDiscord("discord.list_guilds", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });
});

// ============================================
// discord.list_channels
// ============================================

describe("discord.list_channels", () => {
  it("lists channels in a guild", async () => {
    pushFetchResponse(true, 200, [
      { id: "ch1", name: "general", type: 0, position: 0 },
      { id: "ch2", name: "voice", type: 2, position: 1 },
      { id: "ch3", name: "Info", type: 4, position: 2 },
    ]);

    const result = await handleDiscord("discord.list_channels", {
      guild_id: "guild1",
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.channel_count).toBe(3);
    expect(data.channels[0].type).toBe("text");
    expect(data.channels[1].type).toBe("voice");
    expect(data.channels[2].type).toBe("category");
  });

  it("fails when guild_id missing", async () => {
    const result = await handleDiscord("discord.list_channels", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("guild_id");
  });

  it("fails when no token", async () => {
    mockVault.clear();
    const result = await handleDiscord("discord.list_channels", { guild_id: "g1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in vault");
  });
});

// ============================================
// discord.create_channel
// ============================================

describe("discord.create_channel", () => {
  it("creates a text channel", async () => {
    pushFetchResponse(true, 201, { id: "new-ch-1", name: "my-channel" });

    const result = await handleDiscord("discord.create_channel", {
      guild_id: "guild1",
      name: "my-channel",
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.created).toBe(true);
    expect(data.channel_id).toBe("new-ch-1");
  });

  it("includes topic when provided", async () => {
    pushFetchResponse(true, 201, { id: "ch", name: "ch" });

    await handleDiscord("discord.create_channel", {
      guild_id: "g1",
      name: "ch",
      topic: "My topic",
    });

    // Verify proxy was called with topic in body
    const callArgs = mockProxyFetch.mock.calls[0];
    const opts = callArgs[2]; // third arg is the options object
    const body = opts.body ? JSON.parse(opts.body) : {};
    expect(body.topic).toBe("My topic");
  });

  it("fails when guild_id missing", async () => {
    const result = await handleDiscord("discord.create_channel", {
      name: "ch",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("guild_id");
  });

  it("fails when name missing", async () => {
    const result = await handleDiscord("discord.create_channel", {
      guild_id: "g1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("name");
  });

  it("handles Discord API permission error", async () => {
    pushFetchResponse(false, 403, { message: "Missing Permissions" });

    const result = await handleDiscord("discord.create_channel", {
      guild_id: "g1",
      name: "ch",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });
});

// ============================================
// discord.setup_channels
// ============================================

describe("discord.setup_channels", () => {
  it("creates all three standard channels", async () => {
    pushFetchResponse(true, 200, []);
    pushFetchResponse(true, 201, { id: "ch-conv", name: "conversation" });
    pushFetchResponse(true, 201, { id: "ch-upd", name: "updates" });
    pushFetchResponse(true, 201, { id: "ch-log", name: "logs" });

    const result = await handleDiscord("discord.setup_channels", {
      guild_id: "guild1",
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.channels).toHaveLength(3);
    expect(data.channels.every((c: any) => c.action === "created")).toBe(true);
    expect(data.config.DISCORD_CHANNEL_CONVERSATION).toBe("ch-conv");
    expect(data.config.DISCORD_CHANNEL_UPDATES).toBe("ch-upd");
    expect(data.config.DISCORD_CHANNEL_LOGS).toBe("ch-log");
  });

  it("skips channels that already exist", async () => {
    pushFetchResponse(true, 200, [
      { id: "existing-conv", name: "conversation", type: 0 },
    ]);
    pushFetchResponse(true, 201, { id: "ch-upd", name: "updates" });
    pushFetchResponse(true, 201, { id: "ch-log", name: "logs" });

    const result = await handleDiscord("discord.setup_channels", {
      guild_id: "guild1",
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    const conv = data.channels.find((c: any) => c.name === "conversation");
    expect(conv.action).toBe("already_exists");
    expect(conv.channel_id).toBe("existing-conv");
  });

  it("reports partial failure when some channels fail", async () => {
    pushFetchResponse(true, 200, []);
    pushFetchResponse(true, 201, { id: "ch-conv", name: "conversation" });
    pushFetchResponse(false, 403, { message: "Missing Permissions" });
    pushFetchResponse(true, 201, { id: "ch-log", name: "logs" });

    const result = await handleDiscord("discord.setup_channels", {
      guild_id: "guild1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Some channels failed");
  });

  it("fails when guild_id missing", async () => {
    const result = await handleDiscord("discord.setup_channels", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("guild_id");
  });
});

// ============================================
// discord.write_config
// ============================================

describe("discord.write_config", () => {
  it("writes config to .env", async () => {
    const result = await handleDiscord("discord.write_config", {
      guild_id: "g1",
      channel_conversation: "ch1",
      channel_updates: "ch2",
      channel_logs: "ch3",
    });
    expect(result.success).toBe(true);

    const envContent = await fs.readFile(tempEnvPath, "utf-8");
    expect(envContent).toContain("DISCORD_GUILD_ID=g1");
    expect(envContent).toContain("DISCORD_CHANNEL_CONVERSATION=ch1");
    expect(envContent).toContain("DISCORD_CHANNEL_UPDATES=ch2");
    expect(envContent).toContain("DISCORD_CHANNEL_LOGS=ch3");
  });

  it("fails when guild_id missing", async () => {
    const result = await handleDiscord("discord.write_config", {
      channel_conversation: "ch1",
      channel_updates: "ch2",
      channel_logs: "ch3",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("guild_id");
  });

  it("fails when channel IDs missing", async () => {
    const result = await handleDiscord("discord.write_config", {
      guild_id: "g1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing required fields");
  });

  it("preserves existing .env entries", async () => {
    await fs.writeFile(tempEnvPath, "EXISTING_KEY=keep-me\n", "utf-8");

    await handleDiscord("discord.write_config", {
      guild_id: "g1",
      channel_conversation: "ch1",
      channel_updates: "ch2",
      channel_logs: "ch3",
    });

    const envContent = await fs.readFile(tempEnvPath, "utf-8");
    expect(envContent).toContain("EXISTING_KEY=keep-me");
    expect(envContent).toContain("DISCORD_GUILD_ID=g1");
  });
});

// ============================================
// discord.create_guild
// ============================================

describe("discord.create_guild", () => {
  it("creates a guild with default name 'Agent HQ'", async () => {
    pushFetchResponse(true, 200, {
      id: "new-guild-1",
      name: "Agent HQ",
      channels: [{ id: "default-ch", name: "general", type: 0 }],
    });

    const result = await handleDiscord("discord.create_guild", {});
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.created).toBe(true);
    expect(data.guild_id).toBe("new-guild-1");
    expect(data.guild_name).toBe("Agent HQ");
    expect(data.owner).toBe(true);
    expect(data.default_channel_id).toBe("default-ch");
  });

  it("accepts a custom server name", async () => {
    pushFetchResponse(true, 200, { id: "g2", name: "My Server", channels: [] });

    await handleDiscord("discord.create_guild", { name: "My Server" });

    // Check proxy was called with correct body
    const callArgs = mockProxyFetch.mock.calls[0];
    const opts = callArgs[2];
    const body = opts.body ? JSON.parse(opts.body) : {};
    expect(body.name).toBe("My Server");
  });

  it("returns null default_channel_id when no channels returned", async () => {
    pushFetchResponse(true, 200, { id: "g3", name: "Empty" });

    const result = await handleDiscord("discord.create_guild", {});
    const data = JSON.parse(result.output);
    expect(data.default_channel_id).toBeNull();
  });

  it("handles max guild limit error", async () => {
    pushFetchResponse(false, 400, { message: "Maximum number of guilds reached (10)" });

    const result = await handleDiscord("discord.create_guild", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("too many servers");
  });

  it("handles generic API error", async () => {
    pushFetchResponse(false, 500, { message: "Internal Server Error" });

    const result = await handleDiscord("discord.create_guild", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("fails when no token available", async () => {
    mockVault.clear();
    const result = await handleDiscord("discord.create_guild", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in vault");
  });
});

// ============================================
// discord.create_invite
// ============================================

describe("discord.create_invite", () => {
  it("creates a permanent invite with QR URL", async () => {
    pushFetchResponse(true, 200, {
      code: "abc123",
      max_age: 0,
      max_uses: 0,
    });

    const result = await handleDiscord("discord.create_invite", {
      channel_id: "ch-1",
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.invite_url).toBe("https://discord.gg/abc123");
    expect(data.invite_code).toBe("abc123");
    expect(data.qr_url).toContain("api.qrserver.com");
    expect(data.qr_url).toContain("discord.gg");
    expect(data.max_age).toBe(0);
    expect(data.max_uses).toBe(0);
  });

  it("passes custom max_age and max_uses", async () => {
    pushFetchResponse(true, 200, { code: "xyz", max_age: 3600, max_uses: 5 });

    await handleDiscord("discord.create_invite", {
      channel_id: "ch-1",
      max_age: 3600,
      max_uses: 5,
    });

    const callArgs = mockProxyFetch.mock.calls[0];
    const opts = callArgs[2];
    const body = opts.body ? JSON.parse(opts.body) : {};
    expect(body.max_age).toBe(3600);
    expect(body.max_uses).toBe(5);
  });

  it("fails when channel_id missing", async () => {
    const result = await handleDiscord("discord.create_invite", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("channel_id");
  });

  it("handles API permission error", async () => {
    pushFetchResponse(false, 403, { message: "Missing Permissions" });

    const result = await handleDiscord("discord.create_invite", {
      channel_id: "ch-1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });

  it("fails when no token available", async () => {
    mockVault.clear();
    const result = await handleDiscord("discord.create_invite", { channel_id: "ch-1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in vault");
  });
});

// ============================================
// discord.full_setup
// ============================================

describe("discord.full_setup", () => {
  it("creates guild, channels, invite, and writes config in one call", async () => {
    pushFetchResponse(true, 200, []);
    pushFetchResponse(true, 200, { id: "g-new", name: "Agent HQ", channels: [] });
    pushFetchResponse(true, 200, []);
    pushFetchResponse(true, 201, { id: "ch-conv", name: "conversation" });
    pushFetchResponse(true, 201, { id: "ch-upd", name: "updates" });
    pushFetchResponse(true, 201, { id: "ch-log", name: "logs" });
    pushFetchResponse(true, 200, { code: "abc123", max_age: 0, max_uses: 0 });

    const result = await handleDiscord("discord.full_setup", {});
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.setup_complete).toBe(true);
    expect(data.guild_id).toBe("g-new");
    expect(data.channels.conversation).toBe("ch-conv");
    expect(data.channels.updates).toBe("ch-upd");
    expect(data.channels.logs).toBe("ch-log");
    expect(data.invite_url).toBe("https://discord.gg/abc123");
    expect(data.qr_url).toContain("api.qrserver.com");
    expect(data.steps).toContain("Config saved to ~/.bot/.env");

    const envContent = await fs.readFile(tempEnvPath, "utf-8");
    expect(envContent).toContain("DISCORD_GUILD_ID=g-new");
    expect(envContent).toContain("DISCORD_CHANNEL_CONVERSATION=ch-conv");
  });

  it("resumes with existing bot-owned guild", async () => {
    pushFetchResponse(true, 200, [
      { id: "g-existing", name: "My HQ", owner: true, permissions: "8" },
    ]);
    pushFetchResponse(true, 200, [
      { id: "ch-conv", name: "conversation", type: 0 },
    ]);
    pushFetchResponse(true, 201, { id: "ch-upd", name: "updates" });
    pushFetchResponse(true, 201, { id: "ch-log", name: "logs" });
    pushFetchResponse(true, 200, { code: "resume1", max_age: 0, max_uses: 0 });

    const result = await handleDiscord("discord.full_setup", {});
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.guild_id).toBe("g-existing");
    // 5 proxy calls: list guilds, list channels, create updates, create logs, create invite
    expect(mockProxyFetch.mock.calls.length).toBe(5);
    expect(data.steps[0]).toContain("Found existing bot-owned server");
    expect(data.steps[1]).toContain("already exists");
  });

  it("resumes with all channels already existing", async () => {
    pushFetchResponse(true, 200, [{ id: "g1", name: "HQ", owner: true }]);
    pushFetchResponse(true, 200, [
      { id: "c1", name: "conversation", type: 0 },
      { id: "c2", name: "updates", type: 0 },
      { id: "c3", name: "logs", type: 0 },
    ]);
    pushFetchResponse(true, 200, { code: "all-exist", max_age: 0, max_uses: 0 });

    const result = await handleDiscord("discord.full_setup", {});
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.channels.conversation).toBe("c1");
    // Only 3 proxy calls: list guilds, list channels, create invite
    expect(mockProxyFetch.mock.calls.length).toBe(3);
  });

  it("handles guild creation failure", async () => {
    pushFetchResponse(true, 200, []);
    pushFetchResponse(false, 400, { message: "Maximum number of guilds reached (10)" });

    const result = await handleDiscord("discord.full_setup", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("too many servers");
  });

  it("fails gracefully when conversation channel can't be created", async () => {
    pushFetchResponse(true, 200, [{ id: "g1", name: "HQ", owner: true }]);
    pushFetchResponse(true, 200, []);
    pushFetchResponse(false, 403, { message: "Missing Permissions" });
    pushFetchResponse(false, 403, { message: "Missing Permissions" });
    pushFetchResponse(false, 403, { message: "Missing Permissions" });

    const result = await handleDiscord("discord.full_setup", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("#conversation");
  });

  it("succeeds even if invite creation fails", async () => {
    pushFetchResponse(true, 200, []);
    pushFetchResponse(true, 200, { id: "g1", name: "Agent HQ", channels: [] });
    pushFetchResponse(true, 200, []);
    pushFetchResponse(true, 201, { id: "c1", name: "conversation" });
    pushFetchResponse(true, 201, { id: "c2", name: "updates" });
    pushFetchResponse(true, 201, { id: "c3", name: "logs" });
    pushFetchResponse(false, 403, { message: "Missing Permissions" });

    const result = await handleDiscord("discord.full_setup", {});
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.invite_url).toBeNull();
    expect(data.steps).toContainEqual(expect.stringContaining("Warning"));
  });

  it("fails when no token available", async () => {
    mockVault.clear();
    const result = await handleDiscord("discord.full_setup", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in vault");
  });

  it("uses custom server name", async () => {
    pushFetchResponse(true, 200, []);
    pushFetchResponse(true, 200, { id: "g1", name: "Custom Name", channels: [] });
    pushFetchResponse(true, 200, []);
    pushFetchResponse(true, 201, { id: "c1", name: "conversation" });
    pushFetchResponse(true, 201, { id: "c2", name: "updates" });
    pushFetchResponse(true, 201, { id: "c3", name: "logs" });
    pushFetchResponse(true, 200, { code: "custom", max_age: 0, max_uses: 0 });

    await handleDiscord("discord.full_setup", { name: "Custom Name" });

    // Second proxy call is POST /guilds — check body
    const createCall = mockProxyFetch.mock.calls[1];
    const opts = createCall[2];
    const body = opts.body ? JSON.parse(opts.body) : {};
    expect(body.name).toBe("Custom Name");
  });
});

// ============================================
// discord.send_message
// ============================================

describe("discord.send_message", () => {
  it("sends a message to a channel", async () => {
    pushFetchResponse(true, 200, { id: "msg-1" });

    const result = await handleDiscord("discord.send_message", {
      channel_id: "ch-conv",
      content: "Hello from DotBot!",
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.sent).toBe(true);
    expect(data.message_id).toBe("msg-1");
    expect(data.channel_id).toBe("ch-conv");

    const callArgs = mockProxyFetch.mock.calls[0];
    expect(callArgs[0]).toBe("/channels/ch-conv/messages");
    const opts = callArgs[2];
    const body = opts.body ? JSON.parse(opts.body) : {};
    expect(body.content).toBe("Hello from DotBot!");
  });

  it("fails when channel_id missing", async () => {
    const result = await handleDiscord("discord.send_message", { content: "hi" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("channel_id");
  });

  it("fails when content missing", async () => {
    const result = await handleDiscord("discord.send_message", { channel_id: "ch-1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("content");
  });

  it("handles API permission error", async () => {
    pushFetchResponse(false, 403, { message: "Missing Access" });

    const result = await handleDiscord("discord.send_message", {
      channel_id: "ch-1",
      content: "test",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });

  it("fails when no token available", async () => {
    mockVault.clear();
    const result = await handleDiscord("discord.send_message", {
      channel_id: "ch-1",
      content: "test",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found in vault");
  });
});

// ============================================
// UNKNOWN TOOL
// ============================================

describe("unknown discord tool", () => {
  it("returns error for unknown tool ID", async () => {
    const result = await handleDiscord("discord.nonexistent", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown discord tool");
  });
});
