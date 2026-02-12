/**
 * Credential Proxy — Server-Side Authenticated HTTP Calls
 * 
 * The local agent sends an encrypted credential blob + HTTP request details.
 * This module decrypts the credential, injects it into the request, makes
 * the HTTP call, and returns the response. The plaintext credential only
 * exists in memory during the call, then is garbage collected.
 * 
 * This is a GENERIC HTTP proxy — it doesn't know about Discord, OpenAI, etc.
 * The local agent still handles all business logic; this just does the
 * authenticated HTTP call.
 */

import { decryptCredential } from "./crypto.js";

// ============================================
// TYPES
// ============================================

export interface ProxyHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  files?: ProxyFile[];
}

export interface ProxyFile {
  fieldName: string;   // e.g., "files[0]"
  filename: string;    // e.g., "image.png"
  contentType: string; // e.g., "image/png"
  data: string;        // base64-encoded file content
}

export interface CredentialPlacement {
  header: string;   // e.g., "Authorization"
  prefix: string;   // e.g., "Bot " or "Bearer "
}

export interface ProxyHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ============================================
// PROXY EXECUTION
// ============================================

/**
 * Execute a proxied HTTP request with a decrypted credential.
 * 
 * 1. Decrypts the credential blob
 * 2. Injects the credential into the request headers
 * 3. Makes the HTTP call
 * 4. Returns the response
 * 
 * The plaintext credential is only in local variables — once this function
 * returns, it's eligible for garbage collection.
 */

/** Ports commonly used by internal services that should never be proxy targets. */
const BLOCKED_PORTS = new Set([
  6379,  // Redis
  27017, // MongoDB
  5432,  // PostgreSQL
  3306,  // MySQL
  11211, // Memcached
  9200,  // Elasticsearch
  2379,  // etcd
  8500,  // Consul
]);

function validateProxyUrl(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error("Invalid proxy target URL");
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Proxy only supports HTTP/HTTPS (got ${parsed.protocol})`);
  }

  // Strip IPv6 brackets for comparison
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // --- Localhost / loopback ---
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === '::') {
    throw new Error('Proxy cannot target localhost');
  }
  // Full 127.0.0.0/8 loopback range
  if (/^127\./.test(host)) {
    throw new Error('Proxy cannot target localhost');
  }

  // --- IPv6 private ---
  // fe80:: link-local, fc00::/7 unique-local (fc00:: and fd00::)
  if (/^fe80/i.test(host) || /^fc/i.test(host) || /^fd/i.test(host)) {
    throw new Error('Proxy cannot target private IPv6 addresses');
  }

  // --- Cloud metadata endpoints ---
  if (host === '169.254.169.254' || host === 'metadata.google.internal' ||
      host === 'metadata.internal' || host === '100.100.100.200') {
    throw new Error('Proxy cannot target cloud metadata endpoints');
  }
  // Link-local range 169.254.0.0/16 (AWS/Azure/GCP metadata lives here)
  if (/^169\.254\./.test(host)) {
    throw new Error('Proxy cannot target link-local addresses');
  }

  // --- IPv4 private ranges ---
  if (/^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^192\.168\./.test(host)) {
    throw new Error('Proxy cannot target private IP addresses');
  }

  // --- Blocked service ports ---
  const port = parsed.port ? parseInt(parsed.port, 10) : undefined;
  if (port && BLOCKED_PORTS.has(port)) {
    throw new Error(`Proxy cannot target service port ${port}`);
  }
}

/**
 * Execute a proxied HTTP request with an encrypted credential blob.
 * Decrypts the blob, then delegates to executeDirectProxyRequest.
 */
export async function executeProxyRequest(
  encryptedBlob: string,
  request: ProxyHttpRequest,
  placement: CredentialPlacement,
): Promise<ProxyHttpResponse> {
  // URL validation happens inside executeDirectProxyRequest
  const requestDomain = new URL(request.url).hostname;
  const credential = decryptCredential(encryptedBlob, requestDomain);

  return executeDirectProxyRequest(credential, request, placement);
}

/**
 * Execute a proxied HTTP request with a plaintext credential.
 * Internal helper — callers use executeProxyRequest() which handles decryption.
 * 
 * The plaintext credential is only in local variables — once this function
 * returns, it's eligible for garbage collection.
 */
async function executeDirectProxyRequest(
  credential: string,
  request: ProxyHttpRequest,
  placement: CredentialPlacement,
): Promise<ProxyHttpResponse> {
  validateProxyUrl(request.url);

  // Build request headers with credential injected
  const headers = { ...request.headers };
  headers[placement.header] = placement.prefix + credential;

  // Build request body (multipart if files present, plain otherwise)
  let fetchBody: any = request.body || undefined;

  if (request.files && request.files.length > 0) {
    const boundary = `----DotBotBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
    const parts: Buffer[] = [];

    if (request.body) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${request.body}\r\n`
      ));
    }

    for (const file of request.files) {
      const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`;
      parts.push(Buffer.from(fileHeader));
      parts.push(Buffer.from(file.data, "base64"));
      parts.push(Buffer.from("\r\n"));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    fetchBody = Buffer.concat(parts);
    headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
  }

  // Make the HTTP call with timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(request.url, {
      method: request.method,
      headers,
      body: fetchBody,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const body = await res.text();

    const responseHeaders: Record<string, string> = {};
    const safeHeaders = ["content-type", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"];
    for (const key of safeHeaders) {
      const val = res.headers.get(key);
      if (val) responseHeaders[key] = val;
    }

    return {
      status: res.status,
      headers: responseHeaders,
      body,
    };
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { status: 504, headers: {}, body: JSON.stringify({ error: "Proxy request timed out (30s)" }) };
    }
    return { status: 502, headers: {}, body: JSON.stringify({ error: `Proxy request failed: ${err.message}` }) };
  }
}
