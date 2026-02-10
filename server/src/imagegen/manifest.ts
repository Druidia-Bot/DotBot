/**
 * Image Generation Tool Manifest
 * 
 * Tool definitions for server-side image generation tools.
 * Gemini (gemini-2.5-flash-image) is primary; OpenAI (gpt-image-1.5) is fallback.
 */

import type { ToolManifestEntry } from "../agents/tools.js";

export const IMAGEGEN_TOOLS: ToolManifestEntry[] = [
  {
    id: "imagegen.generate",
    name: "generate_image",
    description: "Generate an image from a text prompt. Saves the result to the user's machine and returns the file path. Supports aspect ratios, style references (via reference_images), and provider selection. Default provider: Gemini (Nano Banana). Use this for creating new images from scratch — logos, illustrations, ads, social media graphics, etc.",
    category: "imagegen",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the image to generate. Be specific about style, composition, colors, text content." },
        save_path: { type: "string", description: "Where to save the image (e.g., ~/Desktop/logo.png). Defaults to ~/Downloads/generated_<timestamp>.png" },
        aspect_ratio: { type: "string", description: "Aspect ratio: '1:1' (square), '16:9' (landscape), '9:16' (portrait/story), '4:3', '3:4'. Default: '1:1'" },
        reference_images: {
          type: "array",
          description: "Array of reference image objects for style/content guidance. Each has {path: string} pointing to a local file. Max 5 images.",
          items: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
        provider: { type: "string", description: "Force a specific provider: 'gemini' or 'openai'. Default: auto (starts with Gemini)." },
        size: { type: "string", description: "Image size for OpenAI only: '1024x1024', '1024x1792', '1792x1024'. Gemini uses aspect_ratio instead." },
      },
      required: ["prompt"],
    },
  },
  {
    id: "imagegen.edit",
    name: "edit_image",
    description: "Edit an existing image using text instructions. Provide the source image and describe the changes. Default provider: Gemini (best for iterative edits). If Gemini struggles with an edit (user repeats request or expresses frustration), switch provider to 'openai' which may break through edit resistance.",
    category: "imagegen",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Description of the changes to make to the image. Be specific." },
        image_path: { type: "string", description: "Path to the image to edit (local file on user's machine)." },
        save_path: { type: "string", description: "Where to save the edited image. Defaults to same directory with '_edited' suffix." },
        aspect_ratio: { type: "string", description: "Output aspect ratio: '1:1', '16:9', '9:16', '4:3', '3:4'. Default: match input." },
        provider: { type: "string", description: "Force provider: 'gemini' (default, best for iterative edits) or 'openai' (try when Gemini won't cooperate)." },
        reference_images: {
          type: "array",
          description: "Additional reference images for style guidance. Each has {path: string}.",
          items: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
      required: ["prompt", "image_path"],
    },
  },
];
