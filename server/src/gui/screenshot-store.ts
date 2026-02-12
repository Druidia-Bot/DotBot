/**
 * Screenshot Store — In-memory temporary storage for GUI screenshots.
 * 
 * Screenshots are uploaded via HTTP POST from the local agent (binary, no base64
 * overhead) and stored here with a short TTL. The tool-loop resolves screenshot
 * references to actual image data when building LLM messages.
 * 
 * This avoids sending large base64 blobs through the WebSocket message queue,
 * which is 33% larger and blocks other messages.
 * 
 * Lifecycle:
 * 1. Local agent captures screenshot → HTTP POST /api/screenshot (raw binary)
 * 2. Server stores in memory Map, returns { id: "ss_..." }
 * 3. Tool result over WebSocket has { screenshot_ref: "ss_..." } (tiny JSON)
 * 4. tool-loop.ts calls resolveScreenshot(id) → { base64, media_type }
 * 5. Image auto-expires after TTL (default 5 minutes)
 */

import { nanoid } from "nanoid";
import type { Hono } from "hono";
import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("screenshot-store");

// ============================================
// STORAGE
// ============================================

interface StoredScreenshot {
  buffer: Buffer;
  media_type: "image/jpeg" | "image/png";
  width?: number;
  height?: number;
  created: number;
}

/** In-memory screenshot store with auto-expiry */
const store = new Map<string, StoredScreenshot>();

/** TTL in milliseconds (5 minutes) */
const TTL_MS = 5 * 60 * 1000;

/** Max stored screenshots (prevent memory leak) */
const MAX_STORED = 50;

/** Max single screenshot size (10 MB) */
const MAX_SIZE = 10 * 1024 * 1024;

/** Max total memory for all screenshots (200 MB) */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

let totalBytes = 0;

// Cleanup expired entries every 60 seconds
let cleanupTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, entry] of store) {
    if (now - entry.created > TTL_MS) {
      totalBytes -= entry.buffer.length;
      store.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log.info(`Cleaned ${cleaned} expired screenshots, ${store.size} remaining, ${Math.round(totalBytes / 1024 / 1024)}MB used`);
  }
}, 60_000);

export function stopScreenshotCleanup(): void {
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Resolve a screenshot reference to image data for the LLM.
 * Returns null if not found (expired or invalid).
 */
export function resolveScreenshot(id: string): {
  base64: string;
  media_type: "image/jpeg" | "image/png";
} | null {
  const entry = store.get(id);
  if (!entry) return null;

  // Don't delete — the same screenshot might be referenced in retries
  return {
    base64: entry.buffer.toString("base64"),
    media_type: entry.media_type,
  };
}

/**
 * Store a screenshot and return its reference ID.
 */
function storeScreenshot(
  buffer: Buffer,
  mediaType: "image/jpeg" | "image/png",
  width?: number,
  height?: number,
): string {
  // Evict oldest entries if at capacity or over memory limit
  while (store.size >= MAX_STORED || totalBytes + buffer.length > MAX_TOTAL_BYTES) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    const evicted = store.get(oldest);
    if (evicted) totalBytes -= evicted.buffer.length;
    store.delete(oldest);
  }

  const id = `ss_${nanoid(16)}`;
  store.set(id, {
    buffer,
    media_type: mediaType,
    width,
    height,
    created: Date.now(),
  });
  totalBytes += buffer.length;
  return id;
}

// ============================================
// HTTP ENDPOINT
// ============================================

/**
 * Register POST /api/screenshot endpoint.
 * 
 * Accepts raw binary image data (JPEG or PNG).
 * Returns: { id: "ss_...", size_kb: N }
 * 
 * Headers:
 * - Content-Type: image/jpeg or image/png (required)
 * - X-Screenshot-Width: number (optional)
 * - X-Screenshot-Height: number (optional)
 */
export function registerScreenshotRoute(app: Hono): void {
  app.post("/api/screenshot", async (c) => {
    const contentType = c.req.header("content-type") || "";
    
    let mediaType: "image/jpeg" | "image/png";
    if (contentType.includes("image/png")) {
      mediaType = "image/png";
    } else if (contentType.includes("image/jpeg") || contentType.includes("image/jpg")) {
      mediaType = "image/jpeg";
    } else {
      return c.json({ error: "Content-Type must be image/jpeg or image/png" }, 400);
    }

    const contentLength = parseInt(c.req.header("content-length") || "0", 10);
    if (contentLength > MAX_SIZE) {
      return c.json({ error: `Screenshot too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Max ${MAX_SIZE / 1024 / 1024} MB.` }, 413);
    }

    const width = parseInt(c.req.header("x-screenshot-width") || "0", 10) || undefined;
    const height = parseInt(c.req.header("x-screenshot-height") || "0", 10) || undefined;

    try {
      const arrayBuffer = await c.req.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length === 0) {
        return c.json({ error: "Empty request body" }, 400);
      }

      const id = storeScreenshot(buffer, mediaType, width, height);
      log.info(`Stored screenshot`, { id, size_kb: Math.round(buffer.length / 1024), mediaType, width, height });

      return c.json({ id, size_kb: Math.round(buffer.length / 1024) });
    } catch (err) {
      log.error("Screenshot upload failed", { error: String(err) });
      return c.json({ error: `Upload failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  log.info("Registered POST /api/screenshot endpoint");
}
