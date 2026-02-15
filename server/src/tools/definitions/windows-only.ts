/**
 * Windows-Only Tools
 *
 * Tools that require Windows platform (WIN).
 * These are filtered out on Linux, macOS, and web platforms.
 */

import type { CoreToolDefinition } from "../core-registry.js";
import type { Platform } from "../types.js";

const WIN: Platform[] = ["windows"];

// ============================================
// WINDOWS-ONLY TOOLS
// ============================================

// Registry Operations
export const registry: CoreToolDefinition[] = [
  { id: "registry.read", name: "registry_read", description: "Read a Windows registry key value.", category: "registry", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { path: { type: "string", description: "Registry path (e.g., 'HKCU:\\Software\\Microsoft\\Windows')" }, name: { type: "string", description: "Value name to read" } }, required: ["path", "name"] }, annotations: { readOnlyHint: true } },
  { id: "registry.write", name: "registry_write", description: "Write or update a Windows registry key value.", category: "registry", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { path: { type: "string", description: "Registry path" }, name: { type: "string", description: "Value name" }, value: { type: "string", description: "Value to write" }, type: { type: "string", description: "Registry value type (String, DWord, QWord, Binary, MultiString, ExpandString)", enum: ["String", "DWord", "QWord", "Binary", "MultiString", "ExpandString"] } }, required: ["path", "name", "value"] }, annotations: { destructiveHint: true, requiresConfirmation: true } },
  { id: "registry.delete", name: "registry_delete", description: "Delete a Windows registry key or value.", category: "registry", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { path: { type: "string", description: "Registry path" }, name: { type: "string", description: "Value name to delete (omit to delete entire key)" }, recurse: { type: "boolean", description: "Recursively delete subkeys" } }, required: ["path"] }, annotations: { destructiveHint: true, requiresConfirmation: true } },
  { id: "registry.search", name: "registry_search", description: "Search Windows registry for keys or values matching a pattern.", category: "registry", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { root: { type: "string", description: "Root path to search from" }, pattern: { type: "string", description: "Search pattern (supports wildcards)" }, search_keys: { type: "boolean", description: "Search key names" }, search_values: { type: "boolean", description: "Search value names" }, max_results: { type: "number", description: "Maximum results to return" } }, required: ["root", "pattern"] }, annotations: { readOnlyHint: true } },
];

// Window Management
export const window: CoreToolDefinition[] = [
  { id: "window.list", name: "list_windows", description: "List all open windows with titles, process names, and PIDs.", category: "window", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { filter: { type: "string", description: "Filter by window title or process name" } } }, annotations: { readOnlyHint: true } },
  { id: "window.focus", name: "focus_window", description: "Bring a window to the foreground by title or process name.", category: "window", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { title: { type: "string", description: "Window title (supports partial match)" }, process: { type: "string", description: "Process name" } } }, annotations: { destructiveHint: true } },
  { id: "window.resize", name: "resize_window", description: "Resize and/or move a window to specific coordinates and dimensions.", category: "window", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { title: { type: "string", description: "Window title" }, process: { type: "string", description: "Process name" }, x: { type: "number", description: "X position" }, y: { type: "number", description: "Y position" }, width: { type: "number", description: "Width in pixels" }, height: { type: "number", description: "Height in pixels" }, state: { type: "string", description: "Window state", enum: ["normal", "minimized", "maximized"] } } }, annotations: { destructiveHint: true } },
  { id: "window.close", name: "close_window", description: "Close a window by title or process name.", category: "window", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { title: { type: "string", description: "Window title" }, process: { type: "string", description: "Process name" }, force: { type: "boolean", description: "Force close without saving" } } }, annotations: { destructiveHint: true, requiresConfirmation: true } },
  { id: "screen.capture", name: "capture_screen", description: "Capture full screen, specific window, or region as image file.", category: "window", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { output_path: { type: "string", description: "Path to save screenshot" }, mode: { type: "string", description: "Capture mode", enum: ["fullscreen", "window", "region"] }, window_title: { type: "string", description: "Window title (for window mode)" }, x: { type: "number", description: "X coordinate (for region mode)" }, y: { type: "number", description: "Y coordinate (for region mode)" }, width: { type: "number", description: "Width (for region mode)" }, height: { type: "number", description: "Height (for region mode)" }, format: { type: "string", description: "Image format", enum: ["png", "jpg", "bmp"] } }, required: ["output_path"] }, annotations: { destructiveHint: true } },
  { id: "screen.record", name: "record_screen", description: "Record screen video with audio to file.", category: "window", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { output_path: { type: "string", description: "Path to save video file" }, duration: { type: "number", description: "Recording duration in seconds" }, fps: { type: "number", description: "Frames per second (default: 30)" }, audio: { type: "boolean", description: "Record system audio" }, region: { type: "object", description: "Specific region to record (x, y, width, height)" } }, required: ["output_path"] }, annotations: { destructiveHint: true, longRunningHint: true } },
];

// Audio Control
export const audio: CoreToolDefinition[] = [
  { id: "audio.set_volume", name: "set_volume", description: "Set system or application volume level (0-100).", category: "audio", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { volume: { type: "number", description: "Volume level (0-100)" }, target: { type: "string", description: "Target (system or process name)" }, mute: { type: "boolean", description: "Mute/unmute" } }, required: ["volume"] }, annotations: { destructiveHint: true } },
  { id: "audio.get_devices", name: "list_audio_devices", description: "List all audio input and output devices.", category: "audio", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { type: { type: "string", description: "Device type", enum: ["all", "playback", "recording"] } } }, annotations: { readOnlyHint: true } },
  { id: "audio.set_default", name: "set_default_audio", description: "Set default audio playback or recording device.", category: "audio", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { device_name: { type: "string", description: "Device name or ID" }, type: { type: "string", description: "Device type", enum: ["playback", "recording"] } }, required: ["device_name", "type"] }, annotations: { destructiveHint: true } },
  { id: "audio.play_sound", name: "play_sound", description: "Play audio file or system sound.", category: "audio", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { path: { type: "string", description: "Path to audio file or system sound name" }, volume: { type: "number", description: "Playback volume (0-100)" }, wait: { type: "boolean", description: "Wait for playback to complete" } }, required: ["path"] }, annotations: { destructiveHint: true } },
];

// Performance Monitoring
export const monitoring: CoreToolDefinition[] = [
  { id: "monitoring.cpu_usage", name: "get_cpu_usage", description: "Get current CPU usage percentage overall or per process.", category: "monitoring", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { process: { type: "string", description: "Specific process name" }, duration: { type: "number", description: "Monitoring duration in seconds" } } }, annotations: { readOnlyHint: true } },
  { id: "monitoring.memory_usage", name: "get_memory_usage", description: "Get current memory usage (RAM) overall or per process.", category: "monitoring", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { process: { type: "string", description: "Specific process name" }, unit: { type: "string", description: "Memory unit", enum: ["MB", "GB", "percent"] } } }, annotations: { readOnlyHint: true } },
  { id: "monitoring.disk_io", name: "get_disk_io", description: "Monitor disk I/O activity (read/write speeds).", category: "monitoring", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { drive: { type: "string", description: "Drive letter (e.g., 'C:')" }, duration: { type: "number", description: "Monitoring duration in seconds" } } }, annotations: { readOnlyHint: true } },
  { id: "monitoring.network_traffic", name: "get_network_traffic", description: "Monitor network traffic (sent/received bytes).", category: "monitoring", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { interface: { type: "string", description: "Network interface name" }, duration: { type: "number", description: "Monitoring duration in seconds" } } }, annotations: { readOnlyHint: true } },
];

// Package Management
export const packagemgr: CoreToolDefinition[] = [
  { id: "package.winget_install", name: "winget_install", description: "Install application using Windows Package Manager (winget).", category: "package", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { package_id: { type: "string", description: "Package ID (e.g., 'Microsoft.VisualStudioCode')" }, version: { type: "string", description: "Specific version to install" }, silent: { type: "boolean", description: "Silent installation" } }, required: ["package_id"] }, annotations: { destructiveHint: true, longRunningHint: true, requiresConfirmation: true } },
  { id: "package.winget_search", name: "winget_search", description: "Search for packages in winget repository.", category: "package", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" }, limit: { type: "number", description: "Maximum results" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
  { id: "package.choco_install", name: "choco_install", description: "Install package using Chocolatey package manager.", category: "package", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { package_name: { type: "string", description: "Package name" }, version: { type: "string", description: "Specific version" }, params: { type: "string", description: "Additional chocolatey parameters" } }, required: ["package_name"] }, annotations: { destructiveHint: true, longRunningHint: true, requiresConfirmation: true } },
  { id: "package.list_installed", name: "list_installed_apps", description: "List all installed applications on Windows.", category: "package", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { filter: { type: "string", description: "Filter by application name" }, source: { type: "string", description: "Source to query", enum: ["all", "winget", "chocolatey", "registry"] } } }, annotations: { readOnlyHint: true } },
];

// Windows-specific System Tools
export const systemWindows: CoreToolDefinition[] = [
  { id: "system.process_list", name: "process_list", description: "List running processes with CPU and memory usage.", category: "system", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { filter: { type: "string" }, top: { type: "number" } } }, annotations: { readOnlyHint: true } },
  { id: "system.kill_process", name: "kill_process", description: "Kill a process by name or PID.", category: "system", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { name: { type: "string" }, pid: { type: "number" } } }, annotations: { destructiveHint: true, requiresConfirmation: true } },
  { id: "system.info", name: "system_info", description: "Get system information: OS, CPU, RAM, disk space, uptime.", category: "system", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "system.service_list", name: "service_list", description: "List Windows services with their status.", category: "system", executor: "client", platforms: WIN, inputSchema: { type: "object", properties: { filter: { type: "string" }, status: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { id: "system.service_manage", name: "service_manage", description: "Start, stop, or restart a Windows service.", category: "system", executor: "client", platforms: WIN, inputSchema: { type: "object", properties: { name: { type: "string" }, action: { type: "string" } }, required: ["name", "action"] }, annotations: { destructiveHint: true } },
  { id: "system.scheduled_task", name: "scheduled_task", description: "Create, list, or delete Windows Task Scheduler entries.", category: "system", executor: "client", platforms: WIN, inputSchema: { type: "object", properties: { action: { type: "string" }, name: { type: "string" }, command: { type: "string" }, trigger: { type: "string" }, folder: { type: "string" } }, required: ["action"] }, annotations: { destructiveHint: true } },
  { id: "system.notification", name: "notify", description: "Show a desktop toast notification.", category: "system", executor: "client", platforms: WIN, inputSchema: { type: "object", properties: { title: { type: "string" }, message: { type: "string" } }, required: ["title", "message"] } },
];

// Windows-specific Directory Tools
export const directoryWindows: CoreToolDefinition[] = [
  { id: "directory.delete", name: "delete_directory", description: "Delete a directory and all its contents recursively.", category: "directory", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { destructiveHint: true, requiresConfirmation: true } },
  { id: "directory.find", name: "find_files", description: "Search for files matching a pattern within a directory tree.", category: "directory", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, maxDepth: { type: "number" } }, required: ["path", "pattern"] }, annotations: { readOnlyHint: true } },
  { id: "directory.tree", name: "directory_tree", description: "Display directory structure as an indented tree.", category: "directory", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { path: { type: "string" }, maxDepth: { type: "number" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
  { id: "directory.size", name: "directory_size", description: "Calculate total size of a directory and its contents.", category: "directory", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
];

// Windows-specific Filesystem Tools
export const filesystemWindows: CoreToolDefinition[] = [
  { id: "filesystem.move", name: "move_file", description: "Move or rename a file or directory.", category: "filesystem", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] }, annotations: { destructiveHint: true } },
  { id: "filesystem.copy", name: "copy_file", description: "Copy a file or directory to a new location.", category: "filesystem", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" }, recurse: { type: "boolean" } }, required: ["source", "destination"] } },
];

// Windows-specific Shell
export const shellWindows: CoreToolDefinition[] = [
  { id: "shell.powershell", name: "run_command", description: "Run a PowerShell command on the user's Windows PC.", category: "shell", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "number" } }, required: ["command"] }, annotations: { destructiveHint: true } },
];

// Windows-specific Network
export const networkWindows: CoreToolDefinition[] = [
  { id: "network.ping", name: "ping", description: "Ping a host to check connectivity and latency.", category: "network", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { host: { type: "string" }, count: { type: "number" } }, required: ["host"] }, annotations: { readOnlyHint: true } },
  { id: "network.dns_lookup", name: "dns_lookup", description: "Look up DNS records for a domain.", category: "network", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { domain: { type: "string" }, type: { type: "string" } }, required: ["domain"] }, annotations: { readOnlyHint: true } },
  { id: "network.port_check", name: "port_check", description: "Check if a TCP port is open on a host.", category: "network", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { host: { type: "string" }, port: { type: "number" } }, required: ["host", "port"] }, annotations: { readOnlyHint: true } },
];

// Windows-specific Clipboard
export const clipboardWindows: CoreToolDefinition[] = [
  { id: "clipboard.read", name: "clipboard_read", description: "Read the current contents of the system clipboard.", category: "clipboard", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { id: "clipboard.write", name: "clipboard_write", description: "Write text to the system clipboard.", category: "clipboard", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
];

// Windows-specific Browser
export const browserWindows: CoreToolDefinition[] = [
  { id: "browser.open_url", name: "open_url", description: "Open a URL in the user's default web browser.", category: "browser", executor: "client", platforms: WIN, requiredRuntimes: ["powershell"], inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
];

// Windows-specific Search
export const searchWindows: CoreToolDefinition[] = [
  { id: "search.files", name: "search_files", description: "Search for files on the entire computer using Everything (NTFS-indexed).", category: "search", executor: "client", platforms: WIN, inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" }, match_path: { type: "boolean" }, sort: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } },
];

/** All Windows-only tools */
export const WINDOWS_ONLY_TOOLS: CoreToolDefinition[] = [
  ...registry,
  ...window,
  ...audio,
  ...monitoring,
  ...packagemgr,
  ...systemWindows,
  ...directoryWindows,
  ...filesystemWindows,
  ...shellWindows,
  ...networkWindows,
  ...clipboardWindows,
  ...browserWindows,
  ...searchWindows,
];
