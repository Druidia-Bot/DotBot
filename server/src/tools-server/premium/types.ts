/**
 * Premium Tools — Types
 *
 * Shared interfaces for the premium tool system. Tools are user-facing
 * concepts (e.g., "web scraping", "search"). Providers are implementation
 * details (e.g., ScrapingDog, Serper) that can be swapped without
 * changing the tool ID or manifest.
 */

export interface PremiumToolResult {
  success: boolean;
  output: string;
  error?: string;
  creditsUsed: number;
  creditsRemaining: number;
}

export interface PremiumApiEntry {
  id: string;
  name: string;
  description: string;
  creditCost: number;
  category: string;
  requiredParams: string[];
  optionalParams: string[];
  /** Research cache config — if set, results are cached on the local agent for follow-up use. */
  cache?: {
    mode: "raw" | "enrich";
    type: "web_page" | "web_search" | "api_response" | "pdf_summary" | "video_transcript" | "image_description";
  };
}

/**
 * Contract that every premium provider must implement.
 * The executor resolves which provider handles a given tool ID,
 * then calls execute() on it.
 */
export interface PremiumProvider {
  readonly name: string;

  /** Return the catalog entries this provider can serve. */
  getCatalog(): PremiumApiEntry[];

  /** Check if this provider can handle the given tool ID. */
  handles(toolId: string): boolean;

  /** Execute the API call. Throws on HTTP/network failure. */
  execute(apiEntry: PremiumApiEntry, args: Record<string, any>): Promise<string>;
}
