/**
 * Network Interceptor — API Schema Learner
 * 
 * Phase 3: Intercepts XHR/fetch requests from the headless browser,
 * records API endpoints and response shapes, and stores learned schemas
 * at ~/.bot/api-schemas/. Captures auth tokens from response headers.
 * 
 * This bridges GUI automation to the Fluid UI system — by browsing a
 * site in headless mode, DotBot learns its API surface automatically.
 * 
 * Design:
 * - Recording is opt-in (start_recording / stop_recording)
 * - Only intercepts XHR/fetch (not images, CSS, scripts)
 * - Response bodies are sampled (first 3 responses per endpoint)
 * - Schema inference from JSON responses (field names, types, nesting)
 * - Auth tokens detected from Authorization, Set-Cookie, X-*-Token headers
 * - Schemas stored as JSON at ~/.bot/api-schemas/{domain}/{endpoint}.json
 */

import { promises as fs } from "fs";
import { join } from "path";
import os from "os";
import type { BrowserContext, Route, Request, Response } from "playwright";

// ============================================
// PATHS
// ============================================

const API_SCHEMAS_DIR = join(os.homedir(), ".bot", "api-schemas");

// ============================================
// TYPES
// ============================================

export interface RecordedEndpoint {
  url: string;
  method: string;
  domain: string;
  path: string;
  /** Inferred JSON schema of the response body */
  responseSchema: JsonSchemaNode | null;
  /** Sample response bodies (up to 3) */
  samples: any[];
  /** Request headers that look like auth */
  authHeaders: Record<string, string>;
  /** Response headers that look like auth */
  authResponseHeaders: Record<string, string>;
  /** HTTP status codes observed */
  statusCodes: number[];
  /** Content types observed */
  contentTypes: string[];
  /** Number of times this endpoint was hit */
  hitCount: number;
  /** First seen timestamp */
  firstSeen: string;
  /** Last seen timestamp */
  lastSeen: string;
}

export interface JsonSchemaNode {
  type: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  /** Example value (from first sample) */
  example?: any;
}

export interface RecordingSession {
  domain: string;
  startedAt: string;
  endpoints: Map<string, RecordedEndpoint>;
  authTokens: Map<string, string>;
}

// ============================================
// SCHEMA INFERENCE
// ============================================

/**
 * Infer a JSON schema from a value. Recursively describes the shape
 * of JSON responses so the LLM knows what fields are available.
 */
function inferSchema(value: any, depth = 0): JsonSchemaNode {
  if (depth > 5) return { type: "unknown" };

  if (value === null || value === undefined) {
    return { type: "null" };
  }
  if (typeof value === "string") {
    return { type: "string", example: value.length > 100 ? value.slice(0, 100) + "..." : value };
  }
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number", example: value };
  }
  if (typeof value === "boolean") {
    return { type: "boolean", example: value };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: { type: "unknown" } };
    // Infer schema from first element
    return { type: "array", items: inferSchema(value[0], depth + 1) };
  }
  if (typeof value === "object") {
    const properties: Record<string, JsonSchemaNode> = {};
    const keys = Object.keys(value).slice(0, 30); // Cap at 30 properties
    for (const key of keys) {
      properties[key] = inferSchema(value[key], depth + 1);
    }
    return { type: "object", properties };
  }
  return { type: typeof value };
}

/**
 * Create a stable endpoint key from method + URL (without query params for grouping).
 */
function endpointKey(method: string, url: string): string {
  try {
    const parsed = new URL(url);
    // Normalize: strip query params and fragments for grouping
    // But keep them in the stored URL for reference
    return `${method} ${parsed.origin}${parsed.pathname}`;
  } catch {
    return `${method} ${url}`;
  }
}

// ============================================
// AUTH TOKEN DETECTION
// ============================================

const AUTH_REQUEST_HEADERS = ["authorization", "x-api-key", "x-auth-token", "x-access-token", "x-csrf-token"];
const AUTH_RESPONSE_HEADERS = ["set-cookie", "x-auth-token", "x-access-token", "x-csrf-token", "x-request-id"];

function extractAuthHeaders(headers: Record<string, string>, lookFor: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (lookFor.includes(key.toLowerCase())) {
      // Truncate long cookie values
      found[key] = value.length > 200 ? value.slice(0, 200) + "..." : value;
    }
  }
  return found;
}

// ============================================
// NETWORK INTERCEPTOR CLASS
// ============================================

export class NetworkInterceptor {
  private session: RecordingSession | null = null;
  private routeHandler: ((route: Route) => Promise<void>) | null = null;

  /** Whether recording is currently active */
  get isRecording(): boolean {
    return this.session !== null;
  }

  /** Get current session info */
  get currentSession(): RecordingSession | null {
    return this.session;
  }

  /**
   * Start recording API traffic for a domain.
   * Installs a route handler on the browser context that intercepts XHR/fetch.
   */
  async startRecording(context: BrowserContext, domain?: string): Promise<string> {
    if (this.session) {
      return JSON.stringify({
        started: false,
        error: "Recording already active",
        domain: this.session.domain,
        endpoints_so_far: this.session.endpoints.size,
      });
    }

    const activeDomain = domain || "all";

    this.session = {
      domain: activeDomain,
      startedAt: new Date().toISOString(),
      endpoints: new Map(),
      authTokens: new Map(),
    };

    // Install route handler for all requests
    this.routeHandler = async (route: Route) => {
      const request = route.request();
      const resourceType = request.resourceType();

      // Only intercept XHR and fetch requests
      if (resourceType !== "xhr" && resourceType !== "fetch") {
        return route.continue();
      }

      // Domain filter (if specified)
      if (activeDomain !== "all") {
        try {
          const reqUrl = new URL(request.url());
          if (!reqUrl.hostname.includes(activeDomain)) {
            return route.continue();
          }
        } catch {
          return route.continue();
        }
      }

      // Let the request proceed normally, then inspect the response
      try {
        const response = await route.fetch();
        const headers = response.headers();
        const status = response.status();
        const contentType = headers["content-type"] || "";

        // Record the endpoint
        const method = request.method();
        const url = request.url();
        const key = endpointKey(method, url);

        let endpoint = this.session!.endpoints.get(key);
        if (!endpoint) {
          let parsedDomain = "";
          let parsedPath = "";
          try {
            const parsed = new URL(url);
            parsedDomain = parsed.hostname;
            parsedPath = parsed.pathname;
          } catch { /* ignore */ }

          endpoint = {
            url,
            method,
            domain: parsedDomain,
            path: parsedPath,
            responseSchema: null,
            samples: [],
            authHeaders: {},
            authResponseHeaders: {},
            statusCodes: [],
            contentTypes: [],
            hitCount: 0,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
          };
          this.session!.endpoints.set(key, endpoint);
        }

        endpoint.hitCount++;
        endpoint.lastSeen = new Date().toISOString();
        if (!endpoint.statusCodes.includes(status)) {
          endpoint.statusCodes.push(status);
        }
        if (contentType && !endpoint.contentTypes.includes(contentType.split(";")[0].trim())) {
          endpoint.contentTypes.push(contentType.split(";")[0].trim());
        }

        // Extract auth headers from request
        const reqHeaders = request.headers();
        const reqAuth = extractAuthHeaders(reqHeaders, AUTH_REQUEST_HEADERS);
        Object.assign(endpoint.authHeaders, reqAuth);

        // Extract auth headers from response
        const resAuth = extractAuthHeaders(headers, AUTH_RESPONSE_HEADERS);
        Object.assign(endpoint.authResponseHeaders, resAuth);

        // Store auth tokens globally
        for (const [k, v] of Object.entries({ ...reqAuth, ...resAuth })) {
          this.session!.authTokens.set(k, v);
        }

        // Parse JSON response body (only sample first 3)
        if (contentType.includes("json") && endpoint.samples.length < 3) {
          try {
            const body = await response.json();
            endpoint.samples.push(body);
            // Infer schema from first sample
            if (!endpoint.responseSchema) {
              endpoint.responseSchema = inferSchema(body);
            }
          } catch { /* non-JSON body despite content-type */ }
        }

        // Fulfill the route with the original response
        await route.fulfill({ response });
      } catch {
        // If fetch fails, just continue normally
        await route.continue();
      }
    };

    await context.route("**/*", this.routeHandler);

    return JSON.stringify({
      started: true,
      domain: activeDomain,
      message: `Recording API traffic${activeDomain !== "all" ? ` for ${activeDomain}` : ""}. Browse the site normally — I'll learn the API endpoints.`,
    });
  }

  /**
   * Stop recording and save learned schemas to disk.
   */
  async stopRecording(context: BrowserContext): Promise<string> {
    if (!this.session) {
      return JSON.stringify({ stopped: false, error: "No recording active" });
    }

    // Remove route handler
    if (this.routeHandler) {
      try {
        await context.unroute("**/*", this.routeHandler);
      } catch { /* may already be unrouted */ }
      this.routeHandler = null;
    }

    const session = this.session;
    this.session = null;

    // Save schemas to disk
    const endpointCount = session.endpoints.size;
    if (endpointCount === 0) {
      return JSON.stringify({
        stopped: true,
        endpoints_recorded: 0,
        message: "No API endpoints were captured during recording.",
      });
    }

    const savedPaths: string[] = [];
    for (const [, endpoint] of session.endpoints) {
      try {
        const savePath = await this._saveEndpointSchema(endpoint);
        savedPaths.push(savePath);
      } catch (err) {
        console.warn(`[NetworkInterceptor] Failed to save schema for ${endpoint.url}:`, err);
      }
    }

    // Save auth tokens if any
    const authCount = session.authTokens.size;
    if (authCount > 0) {
      try {
        const domain = session.domain === "all" ? "mixed" : session.domain;
        const authDir = join(API_SCHEMAS_DIR, domain);
        await fs.mkdir(authDir, { recursive: true });
        await fs.writeFile(
          join(authDir, "_auth-tokens.json"),
          JSON.stringify(Object.fromEntries(session.authTokens), null, 2),
          "utf-8"
        );
      } catch { /* non-fatal */ }
    }

    return JSON.stringify({
      stopped: true,
      endpoints_recorded: endpointCount,
      schemas_saved: savedPaths.length,
      auth_tokens_captured: authCount,
      domain: session.domain,
      save_directory: API_SCHEMAS_DIR,
      message: `Recorded ${endpointCount} API endpoint(s). Schemas saved to ~/.bot/api-schemas/. ${authCount > 0 ? `Captured ${authCount} auth token(s).` : ""}`,
    });
  }

  /**
   * List all previously saved API schemas.
   */
  async listSchemas(): Promise<string> {
    try {
      await fs.mkdir(API_SCHEMAS_DIR, { recursive: true });
      const domains = await fs.readdir(API_SCHEMAS_DIR);
      const result: { domain: string; endpoints: string[] }[] = [];

      for (const domain of domains) {
        const domainPath = join(API_SCHEMAS_DIR, domain);
        const stat = await fs.stat(domainPath);
        if (!stat.isDirectory()) continue;

        const files = (await fs.readdir(domainPath))
          .filter(f => f.endsWith(".json") && !f.startsWith("_"));
        result.push({ domain, endpoints: files.map(f => f.replace(".json", "")) });
      }

      return JSON.stringify({
        schema_directory: API_SCHEMAS_DIR,
        domains: result,
        total_endpoints: result.reduce((sum, d) => sum + d.endpoints.length, 0),
      }, null, 2);
    } catch {
      return JSON.stringify({ domains: [], total_endpoints: 0 });
    }
  }

  /**
   * Read a specific schema by domain and endpoint path.
   */
  async readSchema(domain: string, endpointFile: string): Promise<string> {
    try {
      const filePath = join(API_SCHEMAS_DIR, domain, `${endpointFile}.json`);
      const content = await fs.readFile(filePath, "utf-8");
      return content;
    } catch {
      return JSON.stringify({ error: `Schema not found: ${domain}/${endpointFile}` });
    }
  }

  // ============================================
  // PRIVATE
  // ============================================

  private async _saveEndpointSchema(endpoint: RecordedEndpoint): Promise<string> {
    const domain = endpoint.domain || "unknown";
    const dir = join(API_SCHEMAS_DIR, domain);
    await fs.mkdir(dir, { recursive: true });

    // Create a filename from the path (sanitize for filesystem)
    const safePath = endpoint.path
      .replace(/^\//, "")
      .replace(/\//g, "_")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 80) || "root";

    const filename = `${endpoint.method.toLowerCase()}_${safePath}.json`;
    const filePath = join(dir, filename);

    // Build the schema document
    const doc = {
      url: endpoint.url,
      method: endpoint.method,
      domain: endpoint.domain,
      path: endpoint.path,
      responseSchema: endpoint.responseSchema,
      statusCodes: endpoint.statusCodes,
      contentTypes: endpoint.contentTypes,
      authHeaders: Object.keys(endpoint.authHeaders).length > 0 ? endpoint.authHeaders : undefined,
      hitCount: endpoint.hitCount,
      firstSeen: endpoint.firstSeen,
      lastSeen: endpoint.lastSeen,
      // Include one sample response for reference
      sampleResponse: endpoint.samples[0] || undefined,
    };

    await fs.writeFile(filePath, JSON.stringify(doc, null, 2), "utf-8");
    return filePath;
  }
}

// Singleton
export const networkInterceptor = new NetworkInterceptor();
