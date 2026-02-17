/**
 * Screen Capture Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const screenTools: DotBotTool[] = [
  {
    id: "screen.capture", name: "capture_screen", category: "screen", source: "core", executor: "local", runtime: "powershell",
    description: "Capture full screen, specific window, or region as image file.",
    inputSchema: { type: "object", properties: { output_path: { type: "string", description: "Path to save screenshot" }, mode: { type: "string", enum: ["fullscreen", "window", "region"] }, window_title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, format: { type: "string", enum: ["png", "jpg", "bmp"] } }, required: ["output_path"] },
    annotations: { mutatingHint: true },
  },
  {
    id: "screen.record", name: "record_screen", category: "screen", source: "core", executor: "local", runtime: "powershell",
    description: "Record screen video with audio to file.",
    inputSchema: { type: "object", properties: { output_path: { type: "string", description: "Path to save video file" }, duration: { type: "number", description: "Recording duration in seconds" }, fps: { type: "number" }, audio: { type: "boolean" }, region: { type: "object" } }, required: ["output_path"] },
    annotations: { mutatingHint: true },
  },
];
