/**
 * Temp Email — mail.tm API Client
 * 
 * Creates disposable email addresses via the mail.tm free API.
 * Used for signups, verifications, and one-off email receipts.
 * Entirely local — no DotBot server involvement.
 * 
 * API docs: https://docs.mail.tm/
 */

import { promises as fs } from "fs";
import { resolve, dirname } from "path";

const MAIL_TM_API = "https://api.mail.tm";
const REQUEST_TIMEOUT_MS = 15_000;

// ============================================
// TYPES
// ============================================

export interface TempEmailAccount {
  id: string;
  address: string;
  password: string;
  token: string;
  domain: string;
  createdAt: string;
}

export interface TempEmailMessage {
  id: string;
  from: { address: string; name: string };
  to: { address: string; name: string }[];
  subject: string;
  intro: string;
  seen: boolean;
  createdAt: string;
  hasAttachments: boolean;
}

export interface TempEmailMessageDetail extends TempEmailMessage {
  text: string;
  html: string[];
  attachments: { id: string; filename: string; contentType: string; size: number }[];
}

// ============================================
// STATE — persisted to ~/.bot/email/temp/
// ============================================

const EMAIL_DIR = resolve(process.env.USERPROFILE || process.env.HOME || "", ".bot", "email");
const TEMP_STATE_PATH = resolve(EMAIL_DIR, "temp", "account.json");

let activeAccount: TempEmailAccount | null = null;

async function persistAccount(account: TempEmailAccount | null): Promise<void> {
  const dir = dirname(TEMP_STATE_PATH);
  await fs.mkdir(dir, { recursive: true });
  if (account) {
    await fs.writeFile(TEMP_STATE_PATH, JSON.stringify(account, null, 2), "utf-8");
  } else {
    try { await fs.unlink(TEMP_STATE_PATH); } catch { /* doesn't exist */ }
  }
}

async function loadAccount(): Promise<TempEmailAccount | null> {
  if (activeAccount) return activeAccount;
  try {
    const raw = await fs.readFile(TEMP_STATE_PATH, "utf-8");
    activeAccount = JSON.parse(raw) as TempEmailAccount;
    return activeAccount;
  } catch {
    return null;
  }
}

// ============================================
// HTTP HELPERS
// ============================================

async function mailTmFetch(path: string, options: {
  method?: string;
  body?: string;
  token?: string;
  headers?: Record<string, string>;
} = {}): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    "Accept": "application/json",
    ...options.headers,
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const resp = await fetch(`${MAIL_TM_API}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let data: any;
  const text = await resp.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: resp.status, data };
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Get available mail.tm domains.
 */
export async function getAvailableDomains(): Promise<string[]> {
  const { status, data } = await mailTmFetch("/domains");
  if (status !== 200) {
    throw new Error(`Failed to fetch domains: ${status} ${JSON.stringify(data)}`);
  }
  // mail.tm returns { "hydra:member": [...] } or just an array
  const members = data["hydra:member"] || data;
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error("No mail.tm domains available — service may be down");
  }
  return members.map((d: any) => d.domain);
}

/**
 * Create a new temp email account.
 * Only one active at a time — call deleteTempEmail first if one exists.
 */
export async function createTempEmail(prefix?: string): Promise<TempEmailAccount> {
  const existing = await loadAccount();
  if (existing) {
    throw new Error(`A temp email is already active: ${existing.address}. Delete it first with email.delete_temp.`);
  }

  // Get available domain
  const domains = await getAvailableDomains();
  const domain = domains[0];

  // Generate address
  const localPart = prefix
    ? `${prefix.toLowerCase().replace(/[^a-z0-9-]/g, "")}-${randomSuffix()}`
    : `dotbot-${randomSuffix()}`;
  const address = `${localPart}@${domain}`;

  // Generate password (never shown to user, just for API auth)
  const password = randomPassword();

  // Create account
  const { status, data } = await mailTmFetch("/accounts", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });

  if (status !== 201 && status !== 200) {
    throw new Error(`Failed to create temp email: ${status} ${JSON.stringify(data)}`);
  }

  // Get auth token
  const tokenResp = await mailTmFetch("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });

  if (tokenResp.status !== 200) {
    throw new Error(`Failed to get auth token: ${tokenResp.status} ${JSON.stringify(tokenResp.data)}`);
  }

  const account: TempEmailAccount = {
    id: data.id,
    address,
    password,
    token: tokenResp.data.token,
    domain,
    createdAt: new Date().toISOString(),
  };

  activeAccount = account;
  await persistAccount(account);

  console.log(`[Email] Temp email created: ${address}`);
  return account;
}

/**
 * Check inbox for the active temp email.
 */
export async function checkTempInbox(page = 1): Promise<TempEmailMessage[]> {
  const account = await loadAccount();
  if (!account) {
    throw new Error("No active temp email. Create one first with email.create_temp.");
  }

  const { status, data } = await mailTmFetch(`/messages?page=${page}`, {
    token: account.token,
  });

  if (status === 401) {
    // Token expired — try to refresh
    const refreshed = await refreshToken(account);
    if (!refreshed) throw new Error("Temp email session expired. Delete and create a new one.");
    return checkTempInbox(page);
  }

  if (status !== 200) {
    throw new Error(`Failed to check inbox: ${status} ${JSON.stringify(data)}`);
  }

  const members = data["hydra:member"] || data;
  if (!Array.isArray(members)) return [];

  return members.map((msg: any) => ({
    id: msg.id,
    from: msg.from || { address: "unknown", name: "" },
    to: msg.to || [],
    subject: msg.subject || "(no subject)",
    intro: msg.intro || "",
    seen: msg.seen || false,
    createdAt: msg.createdAt || "",
    hasAttachments: msg.hasAttachments || false,
  }));
}

/**
 * Read a specific message by ID.
 */
export async function readTempMessage(messageId: string): Promise<TempEmailMessageDetail> {
  const account = await loadAccount();
  if (!account) {
    throw new Error("No active temp email. Create one first with email.create_temp.");
  }

  const { status, data } = await mailTmFetch(`/messages/${messageId}`, {
    token: account.token,
  });

  if (status === 401) {
    const refreshed = await refreshToken(account);
    if (!refreshed) throw new Error("Temp email session expired. Delete and create a new one.");
    return readTempMessage(messageId);
  }

  if (status === 404) {
    throw new Error(`Message not found: ${messageId}`);
  }

  if (status !== 200) {
    throw new Error(`Failed to read message: ${status} ${JSON.stringify(data)}`);
  }

  return {
    id: data.id,
    from: data.from || { address: "unknown", name: "" },
    to: data.to || [],
    subject: data.subject || "(no subject)",
    intro: data.intro || "",
    seen: data.seen || false,
    createdAt: data.createdAt || "",
    hasAttachments: data.hasAttachments || false,
    text: data.text || "",
    html: data.html || [],
    attachments: (data.attachments || []).map((a: any) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    })),
  };
}

/**
 * Delete the active temp email account.
 */
export async function deleteTempEmail(): Promise<{ address: string }> {
  const account = await loadAccount();
  if (!account) {
    throw new Error("No active temp email to delete.");
  }

  try {
    await mailTmFetch(`/accounts/${account.id}`, {
      method: "DELETE",
      token: account.token,
    });
  } catch {
    // Best-effort — account may already be gone on mail.tm's side
    console.warn("[Email] Failed to delete account on mail.tm — cleaning up locally");
  }

  const address = account.address;
  activeAccount = null;
  await persistAccount(null);

  console.log(`[Email] Temp email deleted: ${address}`);
  return { address };
}

/**
 * Get the active temp email account info (if any).
 */
export async function getActiveTempEmail(): Promise<TempEmailAccount | null> {
  return loadAccount();
}

// ============================================
// INTERNAL HELPERS
// ============================================

async function refreshToken(account: TempEmailAccount): Promise<boolean> {
  try {
    const { status, data } = await mailTmFetch("/token", {
      method: "POST",
      body: JSON.stringify({ address: account.address, password: account.password }),
    });

    if (status !== 200) return false;

    account.token = data.token;
    activeAccount = account;
    await persistAccount(account);
    return true;
  } catch {
    return false;
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).substring(2, 8);
}

function randomPassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let result = "";
  for (let i = 0; i < 24; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
