/**
 * Knowledge Ingestion Engine
 *
 * Processes URLs, PDFs, images, and other content into structured JSON
 * knowledge documents using the Gemini API.
 *
 * For binary/large content (PDFs, images, video, audio):
 *   1. Download the content
 *   2. Upload to Gemini Files API (temporary, 48h TTL)
 *   3. Send processing prompt with file URI
 *   4. Get structured JSON back
 *   5. Delete the uploaded file immediately
 *
 * For text/HTML content:
 *   Send directly to Gemini inline (no file upload needed).
 */

import { createComponentLogger } from "#logging.js";
import { PROVIDER_CONFIGS } from "#llm/config.js";

const log = createComponentLogger("knowledge.ingest");

const GEMINI_BASE = PROVIDER_CONFIGS.gemini.baseUrl!;
const PROCESSING_MODEL = "gemini-2.0-flash";

// ============================================
// MIME TYPE DETECTION
// ============================================

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
};

export function detectMimeFromExtension(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  return MIME_MAP[ext] || "application/octet-stream";
}

export function detectMimeType(url: string, contentTypeHeader?: string): string {
  // Prefer content-type header if present
  if (contentTypeHeader) {
    const ct = contentTypeHeader.split(";")[0].trim().toLowerCase();
    if (ct && ct !== "application/octet-stream") return ct;
  }

  // Fall back to URL extension
  const urlPath = new URL(url).pathname.toLowerCase();
  for (const [ext, mime] of Object.entries(MIME_MAP)) {
    if (urlPath.endsWith(ext)) return mime;
  }

  return "text/html"; // Default assumption for web URLs
}

export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml"
  );
}

export function detectSourceType(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  return "file";
}

// ============================================
// GEMINI FILES API
// ============================================

interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  state: string;
}

async function uploadToGeminiFiles(
  buffer: Buffer,
  mimeType: string,
  displayName: string,
  apiKey: string
): Promise<GeminiFile> {
  const url = `${GEMINI_BASE}/upload/v1beta/files?key=${apiKey}`;

  log.info(`Uploading to Gemini Files API`, { displayName, mimeType, size: buffer.length });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": mimeType,
      "X-Goog-Upload-Protocol": "raw",
      "X-Goog-Upload-Display-Name": displayName,
    },
    body: new Uint8Array(buffer),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini Files upload failed (${response.status}): ${errorText}`);
  }

  const result = await response.json() as { file: GeminiFile };
  log.info(`Upload complete`, { fileName: result.file.name, uri: result.file.uri, state: result.file.state });

  // Wait for processing if needed (some file types need time)
  if (result.file.state === "PROCESSING") {
    return await waitForFileReady(result.file.name, apiKey);
  }

  return result.file;
}

async function waitForFileReady(fileName: string, apiKey: string, maxWaitMs = 120_000): Promise<GeminiFile> {
  const startTime = Date.now();
  const pollInterval = 3_000;

  while (Date.now() - startTime < maxWaitMs) {
    const url = `${GEMINI_BASE}/v1beta/${fileName}?key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to check file status: ${response.status}`);

    const result = await response.json() as GeminiFile;
    if (result.state === "ACTIVE") return result;
    if (result.state === "FAILED") throw new Error(`File processing failed: ${fileName}`);

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error(`File processing timed out after ${maxWaitMs / 1000}s: ${fileName}`);
}

async function deleteGeminiFile(fileName: string, apiKey: string): Promise<void> {
  try {
    const url = `${GEMINI_BASE}/v1beta/${fileName}?key=${apiKey}`;
    await fetch(url, { method: "DELETE" });
    log.info(`Deleted file from Gemini`, { fileName });
  } catch (err) {
    // Non-fatal — file will auto-expire in 48h
    log.warn(`Failed to delete Gemini file (will auto-expire)`, { fileName, error: String(err) });
  }
}

// ============================================
// PROCESSING PROMPT
// ============================================

const PROCESSING_PROMPT = `You are a knowledge extraction engine. Your job is to process the provided content into a structured JSON object that captures EVERY detail.

RULES:
1. Output ONLY valid JSON — no markdown fences, no commentary, no preamble
2. Every key should be a meaningful concept or topic area
3. Values should be exhaustive — include every fact, every detail, every nuance
4. Use arrays for lists of items (features, steps, gotchas, examples, etc.)
5. Use nested objects for complex structured sections
6. Include code examples in full (not snippets)
7. Note version numbers, dates, compatibility requirements
8. Capture edge cases, caveats, and warnings
9. If there are images or diagrams, describe what they show in detail
10. Think: "If someone had only this JSON and no other source, could they fully understand this topic?"

STRUCTURE GUIDELINES:
- "overview" — high-level summary of what this content is about
- Use descriptive key names that explain the concept (e.g., "authentication_flow" not "section3")
- Group related information under nested objects
- For API documentation: capture every endpoint, parameter, response format, error code
- For tutorials: capture every step, code example, expected output
- For reference material: capture every option, configuration, default value

Output the JSON object now:`;

// ============================================
// MAIN INGESTION FUNCTION
// ============================================

export interface IngestResult {
  success: boolean;
  /** Structured JSON knowledge object (ready for knowledge.save) */
  knowledge?: Record<string, any>;
  /** Source metadata */
  meta?: {
    source_url: string;
    source_type: string;
    mime_type: string;
    content_length: number;
  };
  error?: string;
}

export async function ingestFromUrl(
  url: string,
  geminiApiKey: string
): Promise<IngestResult> {
  log.info(`Starting ingestion`, { url });

  // Step 1: Download the content
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DotBot/1.0; Knowledge Ingestion)",
        "Accept": "*/*",
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return { success: false, error: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
  }

  const contentType = response.headers.get("content-type") || "";
  const mimeType = detectMimeType(url, contentType);

  log.info(`Downloaded content`, { url, mimeType, status: response.status });

  // Step 2: Route based on content type
  if (isTextMime(mimeType)) {
    return await processTextContent(url, mimeType, response, geminiApiKey);
  } else {
    return await processBinaryContent(url, mimeType, response, geminiApiKey);
  }
}

/**
 * Process text content (HTML, JSON, plain text, markdown).
 * Sent inline to Gemini — no file upload needed.
 */
async function processTextContent(
  url: string,
  mimeType: string,
  response: Response,
  apiKey: string
): Promise<IngestResult> {
  const text = await response.text();

  if (text.length < 50) {
    return { success: false, error: `Content too short to extract knowledge (${text.length} chars)` };
  }

  // For very large text, truncate to ~200K chars (Gemini can handle it but diminishing returns)
  const truncated = text.length > 200_000
    ? text.substring(0, 200_000) + "\n\n[...truncated at 200K chars]"
    : text;

  log.info(`Processing text content with Gemini`, { url, mimeType, length: text.length });

  const knowledge = await callGeminiForKnowledge(
    [{ text: `Source URL: ${url}\nContent type: ${mimeType}\n\n${truncated}` }, { text: PROCESSING_PROMPT }],
    apiKey
  );

  if (!knowledge) {
    return { success: false, error: "Gemini failed to produce valid JSON knowledge from the content" };
  }

  return {
    success: true,
    knowledge,
    meta: { source_url: url, source_type: "url", mime_type: mimeType, content_length: text.length },
  };
}

/**
 * Process binary content (PDF, images, video, audio).
 * Uploaded to Gemini Files API, then processed.
 */
async function processBinaryContent(
  url: string,
  mimeType: string,
  response: Response,
  apiKey: string
): Promise<IngestResult> {
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length < 100) {
    return { success: false, error: `Content too small (${buffer.length} bytes)` };
  }

  // Max 100MB for Gemini Files API
  if (buffer.length > 100 * 1024 * 1024) {
    return { success: false, error: `File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Gemini Files API limit is 100MB.` };
  }

  const displayName = new URL(url).pathname.split("/").pop() || "document";

  log.info(`Processing binary content via Gemini Files API`, { url, mimeType, size: buffer.length });

  // Upload to Gemini
  let file: GeminiFile;
  try {
    file = await uploadToGeminiFiles(buffer, mimeType, displayName, apiKey);
  } catch (err) {
    return { success: false, error: `Upload failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Process with Gemini
  try {
    const knowledge = await callGeminiForKnowledge(
      [
        { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
        { text: `Source URL: ${url}\n\n${PROCESSING_PROMPT}` },
      ],
      apiKey
    );

    if (!knowledge) {
      return { success: false, error: "Gemini failed to produce valid JSON knowledge from the file" };
    }

    return {
      success: true,
      knowledge,
      meta: { source_url: url, source_type: detectSourceType(mimeType), mime_type: mimeType, content_length: buffer.length },
    };
  } finally {
    // Always cleanup the uploaded file
    await deleteGeminiFile(file.name, apiKey);
  }
}

// ============================================
// GEMINI GENERATE CONTENT
// ============================================

async function callGeminiForKnowledge(
  parts: any[],
  apiKey: string
): Promise<Record<string, any> | null> {
  const url = `${GEMINI_BASE}/v1beta/models/${PROCESSING_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 65536,
      responseMimeType: "application/json",
    },
  };

  log.info(`Calling Gemini for knowledge extraction`, { model: PROCESSING_MODEL });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000), // 5 min timeout for large documents
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error(`Gemini processing failed`, { status: response.status, error: errorText });
    return null;
  }

  const result = await response.json() as any;
  const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    log.error(`Gemini returned empty response`, { result: JSON.stringify(result).substring(0, 500) });
    return null;
  }

  // Parse the JSON response
  try {
    // Strip markdown fences if Gemini wraps in ```json ... ```
    const cleaned = text.replace(/^```json\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    log.error(`Failed to parse Gemini JSON output`, { error: String(err), text: text.substring(0, 500) });
    return null;
  }
}

// ============================================
// LOCAL FILE INGESTION
// ============================================

/**
 * Ingest from pre-read content (text or binary buffer).
 * Used when the source is a local file that was read by the local agent.
 */
export async function ingestFromContent(
  content: string | Buffer,
  mimeType: string,
  sourceLabel: string,
  geminiApiKey: string
): Promise<IngestResult> {
  log.info(`Starting content ingestion`, { sourceLabel, mimeType, size: content.length });

  if (isTextMime(mimeType)) {
    const text = typeof content === "string" ? content : content.toString("utf-8");

    if (text.length < 50) {
      return { success: false, error: `Content too short to extract knowledge (${text.length} chars)` };
    }

    const truncated = text.length > 200_000
      ? text.substring(0, 200_000) + "\n\n[...truncated at 200K chars]"
      : text;

    log.info(`Processing text content with Gemini`, { sourceLabel, mimeType, length: text.length });

    const knowledge = await callGeminiForKnowledge(
      [{ text: `Source: ${sourceLabel}\nContent type: ${mimeType}\n\n${truncated}` }, { text: PROCESSING_PROMPT }],
      geminiApiKey
    );

    if (!knowledge) {
      return { success: false, error: "Gemini failed to produce valid JSON knowledge from the content" };
    }

    return {
      success: true,
      knowledge,
      meta: { source_url: sourceLabel, source_type: "local_file", mime_type: mimeType, content_length: text.length },
    };
  } else {
    // Binary content
    const buffer = typeof content === "string" ? Buffer.from(content, "base64") : content;

    if (buffer.length < 100) {
      return { success: false, error: `Content too small (${buffer.length} bytes)` };
    }
    if (buffer.length > 100 * 1024 * 1024) {
      return { success: false, error: `File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Limit is 100MB.` };
    }

    const displayName = sourceLabel.split(/[\/]/).pop() || "document";
    log.info(`Processing binary content via Gemini Files API`, { sourceLabel, mimeType, size: buffer.length });

    let file: GeminiFile;
    try {
      file = await uploadToGeminiFiles(buffer, mimeType, displayName, geminiApiKey);
    } catch (err) {
      return { success: false, error: `Upload failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    try {
      const knowledge = await callGeminiForKnowledge(
        [
          { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
          { text: `Source: ${sourceLabel}\n\n${PROCESSING_PROMPT}` },
        ],
        geminiApiKey
      );

      if (!knowledge) {
        return { success: false, error: "Gemini failed to produce valid JSON knowledge from the file" };
      }

      return {
        success: true,
        knowledge,
        meta: { source_url: sourceLabel, source_type: detectSourceType(mimeType), mime_type: mimeType, content_length: buffer.length },
      };
    } finally {
      await deleteGeminiFile(file.name, geminiApiKey);
    }
  }
}

// ============================================
// EXPORTED EXECUTOR
// ============================================

/**
 * Execute a knowledge.ingest tool call server-side.
 * Called from the tool loop when it detects a knowledge.ingest call.
 * 
 * For URLs: fetches and processes server-side.
 * For local files: runner-factory routes through HTTP upload endpoint
 * (which calls ingestFromContent directly), so this function only handles URLs.
 */
export async function executeKnowledgeIngest(
  args: Record<string, any>,
  geminiApiKey: string
): Promise<{ success: boolean; output: string; error?: string }> {
  const source = args.source || args.url;
  if (!source) {
    return { success: false, output: "", error: "source (URL or file path) is required" };
  }

  try {
    new URL(source);
  } catch {
    return { success: false, output: "", error: `Invalid URL: ${source}. For local files, provide an absolute file path.` };
  }

  const result = await ingestFromUrl(source, geminiApiKey);

  if (!result.success) {
    return { success: false, output: "", error: result.error || "Ingestion failed" };
  }

  return { success: true, output: formatIngestOutput(result) };
}

function formatIngestOutput(result: IngestResult): string {
  return JSON.stringify({
    message: "Content processed successfully. Use knowledge.save to save this structured knowledge.",
    source: result.meta,
    knowledge: result.knowledge,
  }, null, 2);
}
