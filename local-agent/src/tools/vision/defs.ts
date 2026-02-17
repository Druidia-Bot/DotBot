/**
 * Vision/OCR Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const visionTools: DotBotTool[] = [
  {
    id: "vision.ocr", name: "ocr_extract", category: "vision", source: "core", executor: "local",
    description: "Extract text from image using OCR (Optical Character Recognition).",
    inputSchema: { type: "object", properties: { image_path: { type: "string", description: "Path to image file" }, language: { type: "string", description: "OCR language (default: 'eng')" }, output_format: { type: "string", enum: ["text", "json"] } }, required: ["image_path"] },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
    cache: { mode: "enrich", type: "image_description" },
  },
  {
    id: "vision.analyze_image", name: "analyze_image", category: "vision", source: "core", executor: "local",
    description: "Analyze image contents using vision AI (requires Gemini API key).",
    inputSchema: { type: "object", properties: { image_path: { type: "string" }, prompt: { type: "string", description: "What to analyze" } }, required: ["image_path", "prompt"] },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
    cache: { mode: "enrich", type: "image_description" },
  },
  {
    id: "vision.find_in_image", name: "find_in_image", category: "vision", source: "core", executor: "local",
    description: "Locate UI elements or text in screenshot using template matching or OCR.",
    inputSchema: { type: "object", properties: { image_path: { type: "string" }, target: { type: "string", description: "Text or template to find" }, mode: { type: "string", enum: ["text", "template"] }, threshold: { type: "number" } }, required: ["image_path", "target"] },
    annotations: { readOnlyHint: true, verificationHint: true, mutatingHint: false },
  },
];
