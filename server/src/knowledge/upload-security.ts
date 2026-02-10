/**
 * Upload Security Module
 *
 * Validates uploaded files and archive entries to prevent:
 * - Zip bombs (compression ratio attacks)
 * - Path traversal via malicious filenames
 * - Executable/system file uploads (magic bytes + extension)
 * - Resource exhaustion (size limits, entry count limits)
 * - Nested archive recursion bombs
 *
 * Design principle: files are processed in memory and never executed,
 * so the primary threats are resource exhaustion and defense-in-depth
 * against executable content.
 */

import { createComponentLogger } from "../logging.js";

const log = createComponentLogger("upload.security");

// ============================================
// MAGIC BYTES — detect executables regardless of extension
// ============================================

const EXECUTABLE_SIGNATURES: Array<{ name: string; bytes: number[] }> = [
  { name: "Windows PE/EXE",    bytes: [0x4D, 0x5A] },                          // MZ
  { name: "ELF binary",        bytes: [0x7F, 0x45, 0x4C, 0x46] },              // \x7fELF
  { name: "Mach-O 64-bit",     bytes: [0xCF, 0xFA, 0xED, 0xFE] },
  { name: "Mach-O 32-bit",     bytes: [0xCE, 0xFA, 0xED, 0xFE] },
  { name: "Mach-O fat binary", bytes: [0xCA, 0xFE, 0xBA, 0xBE] },
  { name: "DEX (Android)",     bytes: [0x64, 0x65, 0x78, 0x0A] },              // dex\n
  { name: "Windows COM+",      bytes: [0x4D, 0x53, 0x43, 0x46] },              // MSCF (CAB)
  { name: "MSI installer",     bytes: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1] }, // OLE2 compound doc
];

/**
 * Check if a buffer starts with known executable magic bytes.
 * Returns the detected type name, or null if safe.
 */
export function detectExecutableMagic(buffer: Buffer): string | null {
  if (buffer.length < 6) return null;

  for (const sig of EXECUTABLE_SIGNATURES) {
    if (buffer.length >= sig.bytes.length) {
      const match = sig.bytes.every((b, i) => buffer[i] === b);
      if (match) return sig.name;
    }
  }

  return null;
}

// ============================================
// DANGEROUS EXTENSIONS
// ============================================

// Files that should NEVER be processed — executables, system files, installers.
// Source code (.js, .py, .sh, etc.) is intentionally ALLOWED because
// it's legitimate knowledge content and we never execute uploaded files.
const DANGEROUS_EXTENSIONS = new Set([
  // Windows executables & installers
  ".exe", ".dll", ".com", ".scr", ".pif", ".cpl", ".msi", ".msp", ".mst",
  // Windows script hosts (these could be confused with source code, but
  // they're specifically Windows automation attack vectors)
  ".bat", ".cmd", ".vbs", ".vbe", ".wsf", ".wsh", ".hta",
  // PowerShell scripts
  ".ps1", ".psm1", ".psd1",
  // Unix binaries
  ".so", ".dylib",
  // System/driver files
  ".sys", ".drv", ".ocx", ".inf", ".reg",
  // Shortcuts & links (can trigger execution on Windows)
  ".lnk", ".url", ".desktop", ".webloc",
  // Nested archives (prevent recursion bombs)
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".lz", ".lzma", ".zst",
  ".7z", ".rar", ".cab", ".iso", ".dmg", ".img", ".wim",
  // Java archives (contain executable bytecode)
  ".jar", ".war", ".ear",
  // Raw binary blobs
  ".bin", ".dat", ".dmp",
]);

/**
 * Check if a file extension is on the blocklist.
 * This is for files INSIDE archives — top-level archive formats are handled separately.
 */
export function isDangerousExtension(filename: string): boolean {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  return DANGEROUS_EXTENSIONS.has(ext);
}

// ============================================
// FILENAME SANITIZATION
// ============================================

/**
 * Sanitize an archive entry name to prevent path traversal and injection.
 * Returns null if the name is irrecoverably dangerous.
 */
export function sanitizeEntryName(name: string): string | null {
  if (!name || name.length === 0) return null;

  // Reject null bytes (classic path traversal)
  if (name.includes("\0")) {
    log.warn("Rejected entry with null byte in name", { name: name.substring(0, 50) });
    return null;
  }

  // Reject control characters (except common whitespace)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(name)) {
    log.warn("Rejected entry with control characters", { name: name.substring(0, 50) });
    return null;
  }

  // Normalize path separators
  let clean = name.replace(/\\/g, "/");

  // Strip leading slashes (absolute paths)
  clean = clean.replace(/^\/+/, "");

  // Strip drive letters (Windows: C:\, D:\)
  clean = clean.replace(/^[A-Za-z]:\/?/, "");

  // Remove path traversal sequences
  const parts = clean.split("/").filter(p => p !== ".." && p !== ".");
  clean = parts.join("/");

  // Strip any remaining leading dots (hidden files in archives can be suspicious)
  // But keep them if they're part of a filename like .gitignore (not ..something)
  if (clean.startsWith("../") || clean === "..") return null;

  // Final sanity check — must have something left
  if (clean.length === 0 || clean === "/") return null;

  return clean;
}

// ============================================
// COMPRESSION RATIO CHECK (zip bomb detection)
// ============================================

const MAX_COMPRESSION_RATIO = 100; // 100:1 max ratio

/**
 * Check if the compression ratio is suspicious (potential zip bomb).
 * Returns false if the ratio is dangerously high.
 */
export function isCompressionRatioSafe(compressedSize: number, extractedSize: number): boolean {
  if (compressedSize <= 0) return false;
  const ratio = extractedSize / compressedSize;
  if (ratio > MAX_COMPRESSION_RATIO) {
    log.warn("Suspicious compression ratio detected", {
      compressedSize,
      extractedSize,
      ratio: ratio.toFixed(1),
      maxRatio: MAX_COMPRESSION_RATIO,
    });
    return false;
  }
  return true;
}

// ============================================
// COMBINED VALIDATION
// ============================================

export interface ValidationResult {
  safe: boolean;
  reason?: string;
}

/**
 * Validate a file for knowledge ingestion (works for both top-level and archive entries).
 * Checks magic bytes, extension, and filename safety.
 */
export function validateFileForIngestion(
  buffer: Buffer,
  filename: string
): ValidationResult {
  // Check magic bytes first — catches executables regardless of extension
  const execType = detectExecutableMagic(buffer);
  if (execType) {
    log.warn("Blocked executable file", { filename, type: execType });
    return { safe: false, reason: `File contains executable content (${execType}). Executables cannot be processed for knowledge.` };
  }

  // Check extension blocklist
  if (isDangerousExtension(filename)) {
    const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
    log.warn("Blocked dangerous extension", { filename, ext });
    return { safe: false, reason: `File type '${ext}' is not allowed. Only document, text, and media files can be processed.` };
  }

  return { safe: true };
}

/**
 * Validate an archive entry — includes filename sanitization + file content checks.
 * Returns the sanitized filename if safe, or a validation error.
 */
export function validateArchiveEntry(
  entryName: string,
  entryBuffer: Buffer
): ValidationResult & { sanitizedName?: string } {
  // Sanitize the filename
  const sanitized = sanitizeEntryName(entryName);
  if (!sanitized) {
    return { safe: false, reason: `Invalid or dangerous entry name: ${entryName.substring(0, 80)}` };
  }

  // Validate the file content
  const fileCheck = validateFileForIngestion(entryBuffer, sanitized);
  if (!fileCheck.safe) {
    return { safe: false, reason: `${sanitized}: ${fileCheck.reason}` };
  }

  return { safe: true, sanitizedName: sanitized };
}

// ============================================
// SUPPORTED ARCHIVE FORMATS
// ============================================

export type ArchiveType = "zip" | "tar.gz" | "tar" | "gz" | null;

/**
 * Detect the archive type from filename (extension-based).
 * Returns null if not a recognized archive format.
 */
export function detectArchiveType(filename: string): ArchiveType {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".gz") && !lower.endsWith(".tar.gz")) return "gz";
  return null;
}

/** Unsupported formats — return a helpful error message */
const UNSUPPORTED_ARCHIVES = new Set([".rar", ".7z", ".bz2", ".xz", ".lz", ".lzma", ".zst", ".cab", ".iso", ".dmg"]);

export function isUnsupportedArchive(filename: string): string | null {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  if (UNSUPPORTED_ARCHIVES.has(ext)) {
    return `'${ext}' archives are not supported. Please convert to .zip or .tar.gz and try again.`;
  }
  return null;
}

// ============================================
// LIMITS (exported for use by upload handler)
// ============================================

export const UPLOAD_LIMITS = {
  /** Max size for a single uploaded file (100 MB) */
  MAX_FILE_SIZE: 100 * 1024 * 1024,
  /** Max total extracted size from an archive (500 MB) */
  MAX_ARCHIVE_TOTAL_SIZE: 500 * 1024 * 1024,
  /** Max number of files inside an archive */
  MAX_ARCHIVE_ENTRIES: 50,
  /** Max compression ratio before flagging as zip bomb */
  MAX_COMPRESSION_RATIO,
  /** Min file size to bother processing (bytes) */
  MIN_FILE_SIZE: 10,
  /** Min text length for meaningful knowledge extraction */
  MIN_TEXT_LENGTH: 50,
  /** Max request body size (150 MB — slightly above MAX_FILE_SIZE to account for multipart overhead) */
  MAX_REQUEST_BODY: 150 * 1024 * 1024,
};
