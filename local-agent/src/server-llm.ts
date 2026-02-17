/**
 * Server LLM Call — Request LLM completions through the server.
 *
 * The server has all the API keys and LLM clients. This module lets
 * tool handlers request chat completions without touching any keys.
 * Same pattern as credential-proxy.ts (WS sender + pending map).
 */

import { nanoid } from "nanoid";

// ============================================
// WS SENDER (set by index.ts after connection)
// ============================================

type WSSender = (message: any) => void;

let wsSend: WSSender | null = null;

export function initServerLLM(send: WSSender): void {
  wsSend = send;
}

// ============================================
// PENDING RESPONSES
// ============================================

const pendingCalls = new Map<string, {
  resolve: (value: ServerLLMResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

const CALL_TIMEOUT_MS = 120_000; // 2 minutes (LLM calls can be slow)

export interface ServerLLMResult {
  success: boolean;
  content?: string;
  model?: string;
  provider?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

/**
 * Handle an llm_call_response from the server.
 * Called by index.ts when it receives this message type.
 */
export function handleServerLLMResponse(payload: any): void {
  const requestId = payload.requestId;
  if (!requestId) return;

  const pending = pendingCalls.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingCalls.delete(requestId);
  pending.resolve(payload as ServerLLMResult);
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Request a chat completion from the server.
 * Uses the server's registered LLM clients — no API keys needed locally.
 */
export async function serverLLMCall(options: {
  provider?: string;
  role?: string;
  model?: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
}): Promise<ServerLLMResult> {
  if (!wsSend) {
    throw new Error("Server LLM not initialized — WS connection not established");
  }

  const requestId = nanoid();

  const message = {
    type: "llm_call_request",
    id: requestId,
    timestamp: Date.now(),
    payload: {
      provider: options.provider,
      role: options.role,
      model: options.model,
      messages: options.messages,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    },
  };

  return new Promise<ServerLLMResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(requestId);
      reject(new Error("Server LLM call timed out (2 minutes)"));
    }, CALL_TIMEOUT_MS);

    pendingCalls.set(requestId, { resolve, reject, timer });
    wsSend!(message);
  });
}
