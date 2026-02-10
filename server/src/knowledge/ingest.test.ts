/**
 * Knowledge Ingestion Engine — Tests
 *
 * Tests pure utility functions (MIME detection, source type, text classification)
 * and the executeKnowledgeIngest entry point (with mocked fetch).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectMimeType,
  isTextMime,
  detectSourceType,
  executeKnowledgeIngest,
} from "./ingest.js";

// ============================================
// MIME TYPE DETECTION
// ============================================

describe("detectMimeType", () => {
  it("prefers content-type header over URL extension", () => {
    expect(detectMimeType("https://example.com/doc.pdf", "application/json; charset=utf-8"))
      .toBe("application/json");
  });

  it("falls back to URL extension when no header", () => {
    expect(detectMimeType("https://example.com/doc.pdf")).toBe("application/pdf");
  });

  it("falls back to URL extension when header is octet-stream", () => {
    expect(detectMimeType("https://example.com/image.png", "application/octet-stream"))
      .toBe("image/png");
  });

  it("detects common extensions", () => {
    expect(detectMimeType("https://x.com/file.jpg")).toBe("image/jpeg");
    expect(detectMimeType("https://x.com/file.jpeg")).toBe("image/jpeg");
    expect(detectMimeType("https://x.com/file.png")).toBe("image/png");
    expect(detectMimeType("https://x.com/file.gif")).toBe("image/gif");
    expect(detectMimeType("https://x.com/file.webp")).toBe("image/webp");
    expect(detectMimeType("https://x.com/file.mp4")).toBe("video/mp4");
    expect(detectMimeType("https://x.com/file.mp3")).toBe("audio/mpeg");
    expect(detectMimeType("https://x.com/file.csv")).toBe("text/csv");
    expect(detectMimeType("https://x.com/file.json")).toBe("application/json");
    expect(detectMimeType("https://x.com/file.xml")).toBe("application/xml");
    expect(detectMimeType("https://x.com/file.md")).toBe("text/markdown");
    expect(detectMimeType("https://x.com/file.html")).toBe("text/html");
    expect(detectMimeType("https://x.com/file.htm")).toBe("text/html");
    expect(detectMimeType("https://x.com/file.txt")).toBe("text/plain");
  });

  it("defaults to text/html for unknown extensions", () => {
    expect(detectMimeType("https://example.com/page")).toBe("text/html");
    expect(detectMimeType("https://example.com/api/v1/data")).toBe("text/html");
  });

  it("handles content-type with charset parameter", () => {
    expect(detectMimeType("https://x.com/page", "text/html; charset=utf-8"))
      .toBe("text/html");
  });

  it("is case-insensitive for URL paths", () => {
    expect(detectMimeType("https://x.com/FILE.PDF")).toBe("application/pdf");
    expect(detectMimeType("https://x.com/Image.PNG")).toBe("image/png");
  });
});

// ============================================
// TEXT vs BINARY CLASSIFICATION
// ============================================

describe("isTextMime", () => {
  it("classifies text/* as text", () => {
    expect(isTextMime("text/html")).toBe(true);
    expect(isTextMime("text/plain")).toBe(true);
    expect(isTextMime("text/markdown")).toBe(true);
    expect(isTextMime("text/csv")).toBe(true);
  });

  it("classifies application/json as text", () => {
    expect(isTextMime("application/json")).toBe(true);
  });

  it("classifies application/xml as text", () => {
    expect(isTextMime("application/xml")).toBe(true);
  });

  it("classifies binary types as not text", () => {
    expect(isTextMime("application/pdf")).toBe(false);
    expect(isTextMime("image/png")).toBe(false);
    expect(isTextMime("video/mp4")).toBe(false);
    expect(isTextMime("audio/mpeg")).toBe(false);
    expect(isTextMime("application/octet-stream")).toBe(false);
  });
});

// ============================================
// SOURCE TYPE DETECTION
// ============================================

describe("detectSourceType", () => {
  it("detects image types", () => {
    expect(detectSourceType("image/png")).toBe("image");
    expect(detectSourceType("image/jpeg")).toBe("image");
    expect(detectSourceType("image/gif")).toBe("image");
  });

  it("detects video types", () => {
    expect(detectSourceType("video/mp4")).toBe("video");
    expect(detectSourceType("video/webm")).toBe("video");
  });

  it("detects audio types", () => {
    expect(detectSourceType("audio/mpeg")).toBe("audio");
    expect(detectSourceType("audio/wav")).toBe("audio");
  });

  it("detects PDF", () => {
    expect(detectSourceType("application/pdf")).toBe("pdf");
  });

  it("defaults to 'file' for unknown binary types", () => {
    expect(detectSourceType("application/zip")).toBe("file");
    expect(detectSourceType("application/octet-stream")).toBe("file");
  });
});

// ============================================
// EXECUTE KNOWLEDGE INGEST — Input Validation
// ============================================

describe("executeKnowledgeIngest", () => {
  it("rejects missing source", async () => {
    const result = await executeKnowledgeIngest({}, "fake-key");
    expect(result.success).toBe(false);
    expect(result.error).toContain("source (URL or file path) is required");
  });

  it("rejects invalid URLs", async () => {
    const result = await executeKnowledgeIngest({ source: "not-a-url" }, "fake-key");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid URL");
  });

  it("accepts args.url as alias for args.source", async () => {
    // This will fail on fetch (no real server) but should get past validation
    const result = await executeKnowledgeIngest({ url: "not-a-url" }, "fake-key");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid URL");
  });

  it("returns error for fetch failures", async () => {
    // Use a URL that will fail — internal IP that won't resolve
    const result = await executeKnowledgeIngest(
      { source: "http://0.0.0.0:1/fail" },
      "fake-key"
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
