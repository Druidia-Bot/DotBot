/**
 * DuckDuckGo Instant Answer handler.
 */

import * as https from "https";
import type { ToolExecResult } from "../_shared/types.js";

export async function handleDdgInstant(args: Record<string, any>): Promise<ToolExecResult> {
  if (!args.query) return { success: false, output: "", error: "Missing required field: query" };

  const query = encodeURIComponent(args.query);
  const url = `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const parts: string[] = [];

          // Abstract (Wikipedia-style summary)
          if (json.AbstractText) {
            parts.push(`**Summary**: ${json.AbstractText}`);
            if (json.AbstractSource) parts.push(`Source: ${json.AbstractSource} — ${json.AbstractURL}`);
          }

          // Direct answer (calculations, conversions, etc.)
          if (json.Answer) {
            parts.push(`**Answer**: ${json.Answer}`);
          }

          // Definition
          if (json.Definition) {
            parts.push(`**Definition**: ${json.Definition}`);
            if (json.DefinitionSource) parts.push(`Source: ${json.DefinitionSource}`);
          }

          // Related topics (up to 5)
          if (json.RelatedTopics && json.RelatedTopics.length > 0) {
            const topics = json.RelatedTopics
              .filter((t: any) => t.Text)
              .slice(0, 5)
              .map((t: any) => `- ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ""}`);
            if (topics.length > 0) {
              parts.push(`\n**Related Topics**:\n${topics.join("\n")}`);
            }
          }

          // Infobox
          if (json.Infobox && json.Infobox.content && json.Infobox.content.length > 0) {
            const info = json.Infobox.content
              .slice(0, 8)
              .map((item: any) => `- ${item.label}: ${item.value}`)
              .join("\n");
            parts.push(`\n**Info**:\n${info}`);
          }

          if (parts.length === 0) {
            resolve({ success: true, output: `No instant answer found for "${args.query}". Try rephrasing, or use brave_search for full web results.` });
          } else {
            resolve({ success: true, output: parts.join("\n") });
          }
        } catch {
          resolve({ success: false, output: "", error: "Failed to parse DuckDuckGo response" });
        }
      });
      res.on("error", (err: Error) => {
        resolve({ success: false, output: "", error: `DuckDuckGo request failed: ${err.message}` });
      });
    }).on("error", (err: Error) => {
      resolve({ success: false, output: "", error: `DuckDuckGo request failed: ${err.message}` });
    });
  });
}
