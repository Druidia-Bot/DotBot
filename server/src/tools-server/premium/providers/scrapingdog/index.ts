/**
 * ScrapingDog Provider
 *
 * Implements PremiumProvider for all ScrapingDog APIs.
 * The client handles HTTP; the catalog maps tool IDs to endpoints.
 */

import type { PremiumApiEntry, PremiumProvider } from "../../types.js";
import { ScrapingDogClient } from "./client.js";
import { SCRAPINGDOG_APIS, type ScrapingDogApiEntry } from "./catalog.js";

const API_KEY = process.env.SCRAPING_DOG_API_KEY || process.env.SCRAPINGDOG_API_KEY || "";

const client = new ScrapingDogClient(API_KEY);

const apiById = new Map<string, ScrapingDogApiEntry>(
  SCRAPINGDOG_APIS.map(a => [a.id, a]),
);

export const scrapingDogProvider: PremiumProvider = {
  name: "ScrapingDog",

  getCatalog(): PremiumApiEntry[] {
    if (!client.isConfigured) return [];
    return SCRAPINGDOG_APIS;
  },

  handles(toolId: string): boolean {
    return client.isConfigured && apiById.has(toolId);
  },

  async execute(apiEntry: PremiumApiEntry, args: Record<string, any>): Promise<string> {
    if (!client.isConfigured) {
      throw new Error("ScrapingDog API key not configured on the server. This is a SERVER-MANAGED credential — do NOT prompt the user for it. The server administrator must set SCRAPING_DOG_API_KEY in the server environment.");
    }
    const sdEntry = apiById.get(apiEntry.id);
    if (!sdEntry) {
      throw new Error(`ScrapingDog has no endpoint for tool: ${apiEntry.id}`);
    }
    return client.call(
      { endpoint: sdEntry.endpoint, method: sdEntry.method },
      args,
    );
  },
};

export { SCRAPINGDOG_APIS } from "./catalog.js";
export type { ScrapingDogApiEntry } from "./catalog.js";
