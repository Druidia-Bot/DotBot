/**
 * Audio Control Tool Definitions
 */

import type { DotBotTool } from "../../memory/types.js";

export const audioTools: DotBotTool[] = [
  {
    id: "audio.set_volume", name: "set_volume", category: "audio", source: "core", executor: "local", runtime: "powershell",
    description: "Set system or application volume level (0-100).",
    inputSchema: { type: "object", properties: { volume: { type: "number", description: "Volume level (0-100)" }, target: { type: "string", description: "Target (system or process name)" }, mute: { type: "boolean" } }, required: ["volume"] },
  },
  {
    id: "audio.get_devices", name: "list_audio_devices", category: "audio", source: "core", executor: "local", runtime: "powershell",
    description: "List all audio input and output devices.",
    inputSchema: { type: "object", properties: { type: { type: "string", enum: ["all", "playback", "recording"] } } },
    annotations: { readOnlyHint: true },
  },
  {
    id: "audio.set_default", name: "set_default_audio", category: "audio", source: "core", executor: "local", runtime: "powershell",
    description: "Set default audio playback or recording device.",
    inputSchema: { type: "object", properties: { device_name: { type: "string" }, type: { type: "string", enum: ["playback", "recording"] } }, required: ["device_name", "type"] },
  },
  {
    id: "audio.play_sound", name: "play_sound", category: "audio", source: "core", executor: "local", runtime: "powershell",
    description: "Play audio file or system sound.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to audio file or system sound name" }, volume: { type: "number" }, wait: { type: "boolean" } }, required: ["path"] },
  },
];
