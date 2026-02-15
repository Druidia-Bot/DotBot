/**
 * Premium Providers — Registry
 *
 * All premium providers register here. The executor and list modules
 * iterate this array — they never import providers directly.
 * To add a new provider, import it and append to PROVIDERS.
 */

import type { PremiumProvider } from "../types.js";
import { scrapingDogProvider } from "./scrapingdog/index.js";

export const PROVIDERS: PremiumProvider[] = [
  scrapingDogProvider,
];
