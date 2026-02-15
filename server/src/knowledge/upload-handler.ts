/**
 * Knowledge Ingest Upload Handler
 *
 * HTTP multipart upload endpoint for local file ingestion.
 * Files are processed entirely in memory — nothing touches disk.
 *
 * Supports:
 * - Single files (PDF, images, text, markdown, etc.) → Gemini processing
 * - ZIP archives → extracted in memory, each file processed individually
 * - TAR / TAR.GZ / TGZ archives → extracted in memory via tar-stream
 * - GZ files → decompressed in memory, processed as single file
 *
 * Security:
 * - Magic bytes detection blocks executables regardless of extension
 * - Filename sanitization prevents path traversal in archive entries
 * - Compression ratio checks detect zip bombs
 * - Dangerous extension blocklist (executables, system files, nested archives)
 * - Size limits at every level (request, file, archive total, per-entry)
 *
 * All buffers are released after the request completes (GC handles cleanup).
 */

import type { Hono } from "hono";
import { gunzipSync } from "node:zlib";
import AdmZip from "adm-zip";
import { extract as tarExtract } from "tar-stream";
import { Readable } from "node:stream";
import { createComponentLogger } from "#logging.js";
import {
  ingestFromContent,
  detectMimeFromExtension,
  type IngestResult,
} from "./ingest.js";
import {
  validateFileForIngestion,
  validateArchiveEntry,
  isCompressionRatioSafe,
  detectArchiveType,
  isUnsupportedArchive,
  UPLOAD_LIMITS,
  type ArchiveType,
} from "./upload-security.js";

const log = createComponentLogger("knowledge.upload");

// ============================================
// ROUTE REGISTRATION
// ============================================

export function registerIngestUploadRoute(app: Hono): void {
  app.post("/api/ingest-upload", async (c) => {
    const startTime = Date.now();

    // Enforce request body size limit
    const contentLength = parseInt(c.req.header("content-length") || "0", 10);
    if (contentLength > UPLOAD_LIMITS.MAX_REQUEST_BODY) {
      return c.json({ success: false, error: `Request too large (${(contentLength / 1024 / 1024).toFixed(1)} MB). Maximum is ${UPLOAD_LIMITS.MAX_REQUEST_BODY / 1024 / 1024} MB.` }, 413);
    }

    // Get Gemini API key
    const { getApiKeyForProvider } = await import("#llm/model-selector.js");
    const geminiKey = getApiKeyForProvider("gemini");
    if (!geminiKey) {
      return c.json({ success: false, error: "Gemini API key not configured" }, 500);
    }

    // Parse multipart body
    const body = await c.req.parseBody();
    const file = body["file"];
    const sourceLabel = typeof body["source"] === "string" ? body["source"] : "uploaded file";

    if (!file || !(file instanceof File)) {
      return c.json({ success: false, error: "No file provided. Send as multipart form-data with field name 'file'" }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const filename = file.name || "unknown";

    log.info("Received file upload", { filename, size: buffer.length, sourceLabel });

    // Check for unsupported archive formats first (helpful error)
    const unsupported = isUnsupportedArchive(filename);
    if (unsupported) {
      return c.json({ success: false, error: unsupported }, 400);
    }

    // Detect if this is an archive
    const archiveType = detectArchiveType(filename);

    // For non-archives, enforce file size limit and run security checks
    if (!archiveType) {
      if (buffer.length > UPLOAD_LIMITS.MAX_FILE_SIZE) {
        return c.json({ success: false, error: `File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Limit is ${UPLOAD_LIMITS.MAX_FILE_SIZE / 1024 / 1024} MB.` }, 413);
      }

      // Security: validate file content (magic bytes + extension)
      const validation = validateFileForIngestion(buffer, filename);
      if (!validation.safe) {
        return c.json({ success: false, error: validation.reason }, 403);
      }
    }

    try {
      // Archive — extract and process each file
      if (archiveType) {
        const result = await processArchive(archiveType, buffer, sourceLabel, geminiKey);
        log.info("Archive processing complete", {
          sourceLabel, type: archiveType, files: result.filesProcessed,
          elapsed: Date.now() - startTime,
        });
        return c.json(result);
      }

      // Single file
      const mimeType = detectMimeFromExtension(filename);
      const result = await ingestFromContent(buffer, mimeType, sourceLabel, geminiKey);
      log.info("File processing complete", { sourceLabel, success: result.success, elapsed: Date.now() - startTime });

      if (!result.success) {
        return c.json({ success: false, error: result.error || "Processing failed" });
      }

      return c.json({
        success: true,
        message: "Content processed successfully. Use knowledge.save to save this structured knowledge.",
        source: result.meta,
        knowledge: result.knowledge,
      });
    } catch (err) {
      log.error("Upload processing failed", { error: String(err) });
      return c.json({ success: false, error: `Processing failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  log.info("Registered POST /api/ingest-upload endpoint");
}

// ============================================
// ARCHIVE RESULT TYPE
// ============================================

interface ArchiveProcessResult {
  success: boolean;
  message: string;
  filesProcessed: number;
  filesSkipped: number;
  securityBlocked: number;
  results: Array<{
    filename: string;
    success: boolean;
    knowledge?: Record<string, any>;
    source?: IngestResult["meta"];
    error?: string;
  }>;
}

// ============================================
// ARCHIVE ROUTING
// ============================================

async function processArchive(
  type: ArchiveType,
  buffer: Buffer,
  sourceLabel: string,
  geminiApiKey: string
): Promise<ArchiveProcessResult> {
  switch (type) {
    case "zip":
      return processZipArchive(buffer, sourceLabel, geminiApiKey);
    case "tar.gz":
      return processTarGzArchive(buffer, sourceLabel, geminiApiKey);
    case "tar":
      return processTarArchive(buffer, sourceLabel, geminiApiKey);
    case "gz":
      return processGzFile(buffer, sourceLabel, geminiApiKey);
    default:
      return { success: false, message: "Unknown archive type", filesProcessed: 0, filesSkipped: 0, securityBlocked: 0, results: [] };
  }
}

// ============================================
// SHARED: process validated entries through Gemini
// ============================================

interface ExtractedEntry {
  name: string;
  buffer: Buffer;
}

async function processExtractedEntries(
  entries: ExtractedEntry[],
  sourceLabel: string,
  archiveType: string,
  compressedSize: number,
  totalSkipped: number,
  totalBlocked: number,
  geminiApiKey: string
): Promise<ArchiveProcessResult> {
  if (entries.length === 0) {
    return {
      success: false,
      message: `Archive contains no processable files.` +
        (totalSkipped > 0 ? ` ${totalSkipped} entries skipped.` : "") +
        (totalBlocked > 0 ? ` ${totalBlocked} entries blocked by security checks.` : ""),
      filesProcessed: 0,
      filesSkipped: totalSkipped,
      securityBlocked: totalBlocked,
      results: [],
    };
  }

  // Zip bomb check: compare total extracted size to compressed size
  const totalExtracted = entries.reduce((sum, e) => sum + e.buffer.length, 0);
  if (!isCompressionRatioSafe(compressedSize, totalExtracted)) {
    return {
      success: false,
      message: `Suspicious compression ratio detected (${(totalExtracted / compressedSize).toFixed(0)}:1). ` +
        `This looks like a compression bomb. Maximum ratio is ${UPLOAD_LIMITS.MAX_COMPRESSION_RATIO}:1.`,
      filesProcessed: 0,
      filesSkipped: 0,
      securityBlocked: entries.length,
      results: [],
    };
  }

  // Enforce total extracted size limit
  if (totalExtracted > UPLOAD_LIMITS.MAX_ARCHIVE_TOTAL_SIZE) {
    return {
      success: false,
      message: `Total extracted size too large (${(totalExtracted / 1024 / 1024).toFixed(1)} MB). Maximum is ${UPLOAD_LIMITS.MAX_ARCHIVE_TOTAL_SIZE / 1024 / 1024} MB.`,
      filesProcessed: 0,
      filesSkipped: entries.length,
      securityBlocked: 0,
      results: [],
    };
  }

  // Process each file sequentially
  const results: ArchiveProcessResult["results"] = [];

  for (const entry of entries) {
    const entryMime = detectMimeFromExtension(entry.name);
    const entryLabel = `${sourceLabel} → ${entry.name}`;

    log.info("Processing archive entry", { entry: entry.name, mime: entryMime, size: entry.buffer.length });

    try {
      // For unrecognized binary types, try as text if small enough
      const mime = entryMime === "application/octet-stream" && entry.buffer.length < 1024 * 1024
        ? "text/plain"
        : entryMime;

      const result = await ingestFromContent(entry.buffer, mime, entryLabel, geminiApiKey);
      results.push({
        filename: entry.name,
        success: result.success,
        knowledge: result.knowledge,
        source: result.meta,
        error: result.error,
      });
    } catch (err) {
      results.push({
        filename: entry.name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const successCount = results.filter(r => r.success).length;
  return {
    success: successCount > 0,
    message: `${archiveType.toUpperCase()} processed: ${successCount}/${results.length} files processed successfully.` +
      (totalSkipped > 0 ? ` ${totalSkipped} entries skipped.` : "") +
      (totalBlocked > 0 ? ` ${totalBlocked} entries blocked by security.` : "") +
      ` Use knowledge.save to save each result.`,
    filesProcessed: successCount,
    filesSkipped: totalSkipped,
    securityBlocked: totalBlocked,
    results,
  };
}

// ============================================
// ZIP ARCHIVE
// ============================================

async function processZipArchive(
  zipBuffer: Buffer,
  sourceLabel: string,
  geminiApiKey: string
): Promise<ArchiveProcessResult> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    return {
      success: false,
      message: `Invalid ZIP archive: ${err instanceof Error ? err.message : String(err)}`,
      filesProcessed: 0, filesSkipped: 0, securityBlocked: 0, results: [],
    };
  }

  const rawEntries = zip.getEntries();
  const validated: ExtractedEntry[] = [];
  let skipped = 0;
  let blocked = 0;

  for (const entry of rawEntries) {
    if (entry.isDirectory) { skipped++; continue; }

    const entryBuffer = entry.getData();

    // Security validation (sanitize name + check content)
    const check = validateArchiveEntry(entry.entryName, entryBuffer);
    if (!check.safe) {
      log.warn("Blocked ZIP entry", { entry: entry.entryName, reason: check.reason });
      blocked++;
      continue;
    }

    // Size checks
    if (entryBuffer.length > UPLOAD_LIMITS.MAX_FILE_SIZE) { skipped++; continue; }
    if (entryBuffer.length < UPLOAD_LIMITS.MIN_FILE_SIZE) { skipped++; continue; }

    validated.push({ name: check.sanitizedName!, buffer: entryBuffer });

    if (validated.length >= UPLOAD_LIMITS.MAX_ARCHIVE_ENTRIES) {
      log.warn("Hit max archive entries limit", { limit: UPLOAD_LIMITS.MAX_ARCHIVE_ENTRIES });
      skipped += rawEntries.length - (validated.length + skipped + blocked);
      break;
    }
  }

  log.info("ZIP archive scanned", { sourceLabel, total: rawEntries.length, valid: validated.length, skipped, blocked });
  return processExtractedEntries(validated, sourceLabel, "zip", zipBuffer.length, skipped, blocked, geminiApiKey);
}

// ============================================
// TAR.GZ / TGZ ARCHIVE
// ============================================

async function processTarGzArchive(
  gzBuffer: Buffer,
  sourceLabel: string,
  geminiApiKey: string
): Promise<ArchiveProcessResult> {
  let tarBuffer: Buffer;
  try {
    tarBuffer = gunzipSync(gzBuffer);
  } catch (err) {
    return {
      success: false,
      message: `Failed to decompress gzip: ${err instanceof Error ? err.message : String(err)}`,
      filesProcessed: 0, filesSkipped: 0, securityBlocked: 0, results: [],
    };
  }

  return processTarBuffer(tarBuffer, gzBuffer.length, sourceLabel, "tar.gz", geminiApiKey);
}

// ============================================
// TAR ARCHIVE
// ============================================

async function processTarArchive(
  tarBuffer: Buffer,
  sourceLabel: string,
  geminiApiKey: string
): Promise<ArchiveProcessResult> {
  return processTarBuffer(tarBuffer, tarBuffer.length, sourceLabel, "tar", geminiApiKey);
}

async function processTarBuffer(
  tarBuffer: Buffer,
  compressedSize: number,
  sourceLabel: string,
  archiveType: string,
  geminiApiKey: string
): Promise<ArchiveProcessResult> {
  const validated: ExtractedEntry[] = [];
  let skipped = 0;
  let blocked = 0;

  try {
    const entries = await extractTarEntries(tarBuffer);

    for (const entry of entries) {
      // Security validation
      const check = validateArchiveEntry(entry.name, entry.buffer);
      if (!check.safe) {
        log.warn("Blocked tar entry", { entry: entry.name, reason: check.reason });
        blocked++;
        continue;
      }

      if (entry.buffer.length > UPLOAD_LIMITS.MAX_FILE_SIZE) { skipped++; continue; }
      if (entry.buffer.length < UPLOAD_LIMITS.MIN_FILE_SIZE) { skipped++; continue; }

      validated.push({ name: check.sanitizedName!, buffer: entry.buffer });

      if (validated.length >= UPLOAD_LIMITS.MAX_ARCHIVE_ENTRIES) {
        log.warn("Hit max archive entries limit", { limit: UPLOAD_LIMITS.MAX_ARCHIVE_ENTRIES });
        break;
      }
    }
  } catch (err) {
    return {
      success: false,
      message: `Invalid tar archive: ${err instanceof Error ? err.message : String(err)}`,
      filesProcessed: 0, filesSkipped: 0, securityBlocked: 0, results: [],
    };
  }

  log.info("TAR archive scanned", { sourceLabel, valid: validated.length, skipped, blocked });
  return processExtractedEntries(validated, sourceLabel, archiveType, compressedSize, skipped, blocked, geminiApiKey);
}

/** Extract all file entries from a tar buffer into memory */
async function extractTarEntries(tarBuffer: Buffer): Promise<ExtractedEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ExtractedEntry[] = [];
    const extractor = tarExtract();

    extractor.on("entry", (header, stream, next) => {
      if (header.type !== "file") {
        stream.resume();
        next();
        return;
      }

      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        entries.push({ name: header.name, buffer: Buffer.concat(chunks) });
        next();
      });
      stream.on("error", next);
    });

    extractor.on("finish", () => resolve(entries));
    extractor.on("error", reject);

    Readable.from(tarBuffer).pipe(extractor);
  });
}

// ============================================
// GZ FILE (single compressed file)
// ============================================

async function processGzFile(
  gzBuffer: Buffer,
  sourceLabel: string,
  geminiApiKey: string
): Promise<ArchiveProcessResult> {
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(gzBuffer);
  } catch (err) {
    return {
      success: false,
      message: `Failed to decompress gzip: ${err instanceof Error ? err.message : String(err)}`,
      filesProcessed: 0, filesSkipped: 0, securityBlocked: 0, results: [],
    };
  }

  // Zip bomb check
  if (!isCompressionRatioSafe(gzBuffer.length, decompressed.length)) {
    return {
      success: false,
      message: `Suspicious compression ratio (${(decompressed.length / gzBuffer.length).toFixed(0)}:1). Rejected as potential compression bomb.`,
      filesProcessed: 0, filesSkipped: 0, securityBlocked: 1, results: [],
    };
  }

  if (decompressed.length > UPLOAD_LIMITS.MAX_FILE_SIZE) {
    return {
      success: false,
      message: `Decompressed file too large (${(decompressed.length / 1024 / 1024).toFixed(1)} MB). Limit is ${UPLOAD_LIMITS.MAX_FILE_SIZE / 1024 / 1024} MB.`,
      filesProcessed: 0, filesSkipped: 1, securityBlocked: 0, results: [],
    };
  }

  // Derive inner filename by stripping .gz extension
  const innerName = sourceLabel.replace(/\.gz$/i, "") || "decompressed";

  // Security check on decompressed content
  const validation = validateFileForIngestion(decompressed, innerName);
  if (!validation.safe) {
    return {
      success: false,
      message: validation.reason || "File blocked by security checks",
      filesProcessed: 0, filesSkipped: 0, securityBlocked: 1, results: [],
    };
  }

  const mimeType = detectMimeFromExtension(innerName);
  const result = await ingestFromContent(decompressed, mimeType, sourceLabel, geminiApiKey);

  if (!result.success) {
    return {
      success: false,
      message: result.error || "Processing failed",
      filesProcessed: 0, filesSkipped: 0, securityBlocked: 0, results: [],
    };
  }

  return {
    success: true,
    message: "Decompressed and processed successfully. Use knowledge.save to save this structured knowledge.",
    filesProcessed: 1,
    filesSkipped: 0,
    securityBlocked: 0,
    results: [{
      filename: innerName,
      success: true,
      knowledge: result.knowledge,
      source: result.meta,
    }],
  };
}
