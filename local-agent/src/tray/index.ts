/**
 * System Tray Icon — DotBot tray menu
 * 
 * Provides a system tray icon with menu: Open UI / Status / Updates / Restart / Quit.
 * Uses `systray2` npm package (must be installed: npm install systray2).
 * 
 * The tray icon has three states:
 *   - Green: connected and running normally
 *   - Yellow: disconnected / reconnecting
 *   - Red: error state
 * 
 * This module is optional — if systray2 is not installed, it silently skips.
 */

import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

// Base64-encoded minimal 16x16 green dot ICO (placeholder — replace with real asset)
// To generate a real icon: create a 16/32/48px .ico and base64-encode it
const ICON_GREEN = "";
const ICON_YELLOW = "";
const ICON_RED = "";

let tray: any = null;

export interface TrayCallbacks {
  onOpen: () => void;
  onRestart: () => void;
  onQuit: () => void;
}

/**
 * Start the system tray icon. Silently skips if systray2 is not installed.
 */
export async function startTray(callbacks: TrayCallbacks): Promise<void> {
  try {
    // Dynamic import — skip gracefully if not installed
    const { default: SysTray } = await import("systray2");

    // Try to load icon from file first, fall back to embedded
    let icon = ICON_GREEN;
    try {
      const iconPath = join(homedir(), ".bot", "icon.ico");
      icon = readFileSync(iconPath).toString("base64");
    } catch {
      // Use embedded placeholder
    }

    tray = new SysTray({
      menu: {
        icon,
        title: "DotBot",
        tooltip: "DotBot — Your AI Assistant",
        items: [
          { title: "Open UI", tooltip: "Open DotBot in browser", checked: false, enabled: true },
          { title: "Status", tooltip: "Show connection status", checked: false, enabled: true },
          { title: "---", tooltip: "", checked: false, enabled: true },
          { title: "Restart", tooltip: "Restart the agent", checked: false, enabled: true },
          { title: "Quit", tooltip: "Stop DotBot", checked: false, enabled: true },
        ],
      },
      debug: false,
      copyDir: false,
    });

    tray.onClick((action: any) => {
      switch (action.seq_id) {
        case 0: // Open UI
          callbacks.onOpen();
          break;
        case 1: // Status
          // Update tooltip with current status
          break;
        case 3: // Restart
          callbacks.onRestart();
          break;
        case 4: // Quit
          callbacks.onQuit();
          break;
      }
    });

    console.log("[Tray] System tray icon started");
  } catch {
    // systray2 not installed or platform not supported — skip silently
  }
}

/**
 * Update the tray icon state.
 */
export function updateTrayState(state: "connected" | "disconnected" | "error"): void {
  if (!tray) return;
  try {
    const icon = state === "connected" ? ICON_GREEN : state === "disconnected" ? ICON_YELLOW : ICON_RED;
    const tooltip = state === "connected" ? "DotBot — Connected" : state === "disconnected" ? "DotBot — Disconnected" : "DotBot — Error";
    tray.sendAction({ type: "update-menu", menu: { icon, tooltip } });
  } catch {
    // Ignore tray update errors
  }
}

/**
 * Stop the tray icon.
 */
export function stopTray(): void {
  if (!tray) return;
  try {
    tray.kill(false);
    tray = null;
  } catch {
    // Ignore
  }
}
