/**
 * Screenshot Handler — Image Extraction Wrapper
 *
 * Wraps any tool handler to detect screenshot/image data in results
 * and convert them to proper LLM image content blocks instead of
 * sending raw base64 as text.
 *
 * Supports two paths:
 *   1. screenshot_ref — image uploaded via HTTP POST, resolved from in-memory store
 *   2. image_base64 — inline base64 fallback
 */

import { createComponentLogger } from "../../logging.js";
import { resolveScreenshot } from "../../gui/screenshot-store.js";
import type { ToolHandler, ToolContext, ToolHandlerResult } from "../types.js";

const log = createComponentLogger("tool-loop.screenshot");

/**
 * Extract image from a tool result JSON string.
 * Returns null if no image found.
 */
function extractImageFromResult(result: string): {
  textContent: string;
  image: { base64: string; media_type: "image/jpeg" | "image/png" };
} | null {
  try {
    const parsed = JSON.parse(result);

    // Path 1: HTTP-uploaded screenshot (preferred)
    if (parsed.screenshot_ref && typeof parsed.screenshot_ref === "string") {
      const resolved = resolveScreenshot(parsed.screenshot_ref);
      if (resolved) {
        const summary = { ...parsed };
        delete summary.screenshot_ref;
        summary._image_attached = true;
        return { textContent: JSON.stringify(summary), image: resolved };
      }
      log.warn(`Screenshot ref ${parsed.screenshot_ref} not found in store (expired?)`);
    }

    // Path 2: Inline base64 fallback
    if (parsed.image_base64 && typeof parsed.image_base64 === "string") {
      const imageData = parsed.image_base64;
      const mediaType: "image/jpeg" | "image/png" =
        parsed.format === "png" ? "image/png" : "image/jpeg";

      const summary = { ...parsed };
      delete summary.image_base64;
      summary._image_attached = true;

      return {
        textContent: JSON.stringify(summary),
        image: { base64: imageData, media_type: mediaType },
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Wrap a handler to extract images from tool results.
 * If the result contains a screenshot, returns a ToolHandlerResult
 * with proper image content blocks.
 */
export function withScreenshotExtraction(
  toolId: string,
  inner: ToolHandler,
): ToolHandler {
  return async (ctx: ToolContext, args: Record<string, any>): Promise<string | ToolHandlerResult> => {
    const raw = await inner(ctx, args);
    const resultText = typeof raw === "string" ? raw : raw.content;
    const existingImages = typeof raw !== "string" ? raw.images : undefined;
    const existingBreak = typeof raw !== "string" ? raw.breakBatch : undefined;

    const imageExtraction = extractImageFromResult(resultText);
    if (imageExtraction) {
      log.info(`Tool ${toolId} returned image (${imageExtraction.image.media_type})`);
      const images = existingImages
        ? [...existingImages, imageExtraction.image]
        : [imageExtraction.image];
      return {
        content: imageExtraction.textContent,
        images,
        breakBatch: existingBreak,
      };
    }

    return raw;
  };
}
