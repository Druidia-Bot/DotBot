/**
 * ScrapingDog Client
 *
 * Encapsulates all HTTP communication with the ScrapingDog API.
 * Handles auth (API key injection), GET/POST dispatch, gzip,
 * timeouts, and error formatting.
 */

import * as https from "https";
import * as zlib from "zlib";
import { createComponentLogger } from "#logging.js";

const log = createComponentLogger("scrapingdog.client");

export interface ScrapingDogEndpoint {
  endpoint: string;
  method?: "GET" | "POST";
}

export class ScrapingDogClient {
  private readonly apiKey: string;
  private readonly timeout: number;

  constructor(apiKey: string, timeout = 60_000) {
    this.apiKey = apiKey;
    this.timeout = timeout;
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Call a ScrapingDog endpoint. Automatically chooses GET or POST
   * based on the endpoint config and args.
   */
  async call(
    endpoint: ScrapingDogEndpoint,
    args: Record<string, any>,
  ): Promise<string> {
    const usePost = endpoint.method === "POST" || args.body || args.headers;

    if (usePost) {
      return this.post(endpoint.endpoint, args);
    }
    return this.get(endpoint.endpoint, args);
  }

  // ============================================
  // GET
  // ============================================

  private get(endpoint: string, args: Record<string, any>): Promise<string> {
    const params = new URLSearchParams();
    params.set("api_key", this.apiKey);

    for (const [key, value] of Object.entries(args)) {
      if (key === "api") continue;
      params.set(key, String(value));
    }

    const url = `${endpoint}?${params.toString()}`;
    log.debug("GET", { endpoint, paramCount: params.size });

    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: this.timeout }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let body = "";
          res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          res.on("end", () => {
            reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 500)}`));
          });
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        res.on("end", () => {
          resolve(this.decodeResponse(Buffer.concat(chunks), res.headers["content-encoding"]));
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timed out (${this.timeout / 1000}s)`));
      });
    });
  }

  // ============================================
  // POST
  // ============================================

  private post(endpoint: string, args: Record<string, any>): Promise<string> {
    const payload: Record<string, any> = { api_key: this.apiKey };

    for (const [key, value] of Object.entries(args)) {
      if (key === "api") continue;
      if (key === "headers" && typeof value === "string") {
        try { payload.headers = JSON.parse(value); } catch { payload.headers = value; }
      } else {
        payload[key] = value;
      }
    }

    const data = JSON.stringify(payload);
    const urlObj = new URL(endpoint);
    log.debug("POST", { endpoint, bodyLength: data.length });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: "POST",
        timeout: this.timeout,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      };
      const req = https.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let respBody = "";
          res.on("data", (chunk: Buffer) => { respBody += chunk.toString(); });
          res.on("end", () => {
            reject(new Error(`HTTP ${res.statusCode}: ${respBody.substring(0, 500)}`));
          });
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        res.on("end", () => {
          resolve(this.decodeResponse(Buffer.concat(chunks), res.headers["content-encoding"]));
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timed out (${this.timeout / 1000}s)`));
      });
      req.write(data);
      req.end();
    });
  }

  // ============================================
  // RESPONSE DECODING
  // ============================================

  private decodeResponse(buf: Buffer, encoding?: string): string {
    if (encoding === "gzip") {
      try { return zlib.gunzipSync(buf).toString(); } catch { /* use raw */ }
    }
    return buf.toString();
  }
}
