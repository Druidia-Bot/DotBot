/**
 * Knowledge Management Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const knowledgeTools: DotBotTool[] = [
  {
    id: "knowledge.ingest",
    name: "ingest_knowledge",
    description: `Process a URL, local file, or compressed archive into structured JSON knowledge using Gemini. Supports web pages, PDFs, images, video, audio, API responses, markdown, text, CSV, JSON files, and compressed archives (.zip, .tar.gz, .tgz, .tar, .gz).

For URLs: content is fetched and processed server-side.
For local files: uploaded from the user's machine to the server for processing (no files stored — processed in memory and discarded immediately).
For compressed archives: each file inside is extracted and processed individually, returning knowledge for every file. Supported: .zip, .tar.gz, .tgz, .tar, .gz
For PDFs and binary files: uploaded to Gemini Files API (temporary, deleted immediately after processing).
For text/HTML: sent inline to Gemini (no file upload).

Security: all uploads are validated — executables are blocked (magic bytes + extension), archive entries are sanitized against path traversal, compression ratio checks detect zip bombs. Max 50 files per archive, 100MB per file, 500MB total extracted.

This tool returns the structured JSON — you should review it, add a title and tags, then save it with knowledge.save.
For archives, each extracted file returns separate knowledge — save each one individually.

Example workflows:
1. knowledge.ingest(source: "https://react.dev/reference/rsc/server-components")
2. knowledge.ingest(source: "C:\\Users\\me\\Documents\\api-spec.pdf")
3. knowledge.ingest(source: "C:\\Users\\me\\Downloads\\docs.tar.gz")
4. Review the returned JSON structure
5. knowledge.save(title: "React Server Components Reference", content: <the JSON>, tags: "react,rsc")`,
    source: "core",
    category: "knowledge",
    executor: "server-proxy",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "URL or local file path to process. URLs: web pages, API endpoints. Local files: PDFs, images, video, audio, markdown, text, CSV, JSON, HTML. Archives: .zip, .tar.gz, .tgz, .tar, .gz" },
      },
      required: ["source"],
    },
  },
  {
    id: "knowledge.save",
    name: "save_knowledge",
    description: `Save a knowledge document as a structured JSON file. Use this after you've fetched and processed content from a URL, PDF, API response, image description, or any other source.

The content parameter is a JSON string where each key is an "aspect" of the knowledge and each value is the detail. Structure it like a mental model — keys are concepts, values are everything you know about them. Be exhaustive in the values.

Example content: {"overview": "React Server Components run on...", "directives": ["use server", "use client", "cache()"], "gotchas": ["No useState in server components", ...], "compatibility": "React 19+, Next.js 14+"}

The system automatically builds a compact skeleton from the JSON keys for efficient retrieval — the LLM sees just the structure and can request specific sections on demand via knowledge.read with the section parameter.

If persona_slug is provided, saves to that persona's knowledge directory. Otherwise saves to general knowledge (~/.bot/knowledge/).`,
    source: "core",
    category: "knowledge",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Document title — descriptive and specific (e.g., 'React 19 Server Components API Reference')" },
        content: { type: "string", description: "JSON string with structured knowledge. Keys are aspects/topics, values are detailed content. Example: {\"overview\": \"...\", \"api\": [...], \"gotchas\": [...]}" },
        description: { type: "string", description: "One-line description of what this document covers" },
        tags: { type: "string", description: "Comma-separated tags for discovery (e.g., 'react,server-components,api,reference')" },
        source_url: { type: "string", description: "URL the content was sourced from (if applicable)" },
        source_type: { type: "string", description: "Type of source: 'url', 'pdf', 'image', 'api', 'manual', 'conversation'" },
        persona_slug: { type: "string", description: "Optional: save to a specific persona's knowledge directory instead of general knowledge. The persona must already exist as a local persona." },
      },
      required: ["title", "content"],
    },
    annotations: { destructiveHint: true },
  },
  {
    id: "knowledge.list",
    name: "list_knowledge",
    description: "List saved knowledge documents with their structural skeletons. Shows the keys and truncated values of each document so you can decide what to read in detail. Short values appear inline; long values show previews with word/item counts.",
    source: "core",
    category: "knowledge",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        persona_slug: { type: "string", description: "Optional: list knowledge for a specific persona instead of general knowledge" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "knowledge.read",
    name: "read_knowledge",
    description: "Read a knowledge document. Use the 'section' parameter to retrieve a specific key from the JSON (supports dot-notation for nested keys like 'api.endpoints'). Without 'section', returns the full document.",
    source: "core",
    category: "knowledge",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename of the knowledge document (e.g., 'react-server-components.json')" },
        section: { type: "string", description: "Optional: specific key to read (e.g., 'gotchas' or 'api.endpoints'). Returns only that section's content instead of the full document." },
        persona_slug: { type: "string", description: "Optional: read from a specific persona's knowledge directory" },
      },
      required: ["filename"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "knowledge.search",
    name: "search_knowledge",
    description: "Search across knowledge documents for a keyword or phrase. Searches both key names and values. Returns matching sections with their paths so you can retrieve them with knowledge.read.",
    source: "core",
    category: "knowledge",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or phrase to search for across all knowledge documents" },
        persona_slug: { type: "string", description: "Optional: search within a specific persona's knowledge only" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    id: "knowledge.delete",
    name: "delete_knowledge",
    description: "Delete a knowledge document by filename.",
    source: "core",
    category: "knowledge",
    executor: "local",
    runtime: "internal",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename of the knowledge document to delete" },
        persona_slug: { type: "string", description: "Optional: delete from a specific persona's knowledge directory" },
      },
      required: ["filename"],
    },
    annotations: { destructiveHint: true },
  },
];
