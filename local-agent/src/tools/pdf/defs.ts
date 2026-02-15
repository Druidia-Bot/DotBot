/**
 * PDF Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const pdfTools: DotBotTool[] = [
  {
    id: "pdf.read", name: "read_pdf", category: "pdf", source: "core", executor: "local",
    description: "Extract text content from PDF file.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to PDF file" }, pages: { type: "string", description: "Page range (e.g., '1-5', 'all')" }, format: { type: "string", enum: ["text", "json"] } }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    id: "pdf.merge", name: "merge_pdfs", category: "pdf", source: "core", executor: "local",
    description: "Combine multiple PDF files into a single PDF.",
    inputSchema: { type: "object", properties: { input_paths: { type: "array", description: "Array of PDF file paths to merge", items: { type: "string" } }, output_path: { type: "string" } }, required: ["input_paths", "output_path"] },
  },
  {
    id: "pdf.split", name: "split_pdf", category: "pdf", source: "core", executor: "local",
    description: "Split PDF into multiple files by page range or individual pages.",
    inputSchema: { type: "object", properties: { input_path: { type: "string" }, output_dir: { type: "string" }, mode: { type: "string", enum: ["pages", "ranges"] }, ranges: { type: "array", items: { type: "string" } } }, required: ["input_path", "output_dir"] },
  },
  {
    id: "pdf.to_images", name: "pdf_to_images", category: "pdf", source: "core", executor: "local",
    description: "Convert PDF pages to image files (PNG, JPG).",
    inputSchema: { type: "object", properties: { input_path: { type: "string" }, output_dir: { type: "string" }, format: { type: "string", enum: ["png", "jpg"] }, dpi: { type: "number" }, pages: { type: "string" } }, required: ["input_path", "output_dir"] },
  },
];
