/**
 * DotBot Admin CLI — DOS-style interactive management console.
 * 
 * Runs standalone against the SQLite database — no server required.
 * 
 * Usage:
 *   npx tsx --conditions=development src/admin/cli.ts
 *   node dist/admin/cli.js
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, "../../../.env") });

import { initDatabase, getDatabase } from "../db/index.js";
import { initBotEnvironment } from "../init.js";

initDatabase();
initBotEnvironment();

import blessed from "blessed";
import { THEME } from "./helpers.js";
import { showDevicesScreen } from "./screens/devices.js";
import { showTokensScreen } from "./screens/tokens.js";
import { showCreditsScreen } from "./screens/credits.js";
import { showAuthLogScreen } from "./screens/auth-log.js";
import { showUsageScreen } from "./screens/usage.js";
import { showTasksScreen } from "./screens/tasks.js";

// ============================================
// SCREEN SETUP
// ============================================

const screen = blessed.screen({
  smartCSR: true,
  title: "DotBot Admin Console",
  fullUnicode: true,
});

// ============================================
// MAIN MENU
// ============================================

function showMainMenu(): void {
  // ASCII art header
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: "center",
    width: "100%",
    height: 9,
    tags: true,
    content: [
      "",
      "  {cyan-fg}╔══════════════════════════════════════════════════╗{/}",
      "  {cyan-fg}║{/}  {bold}{white-fg}D O T B O T   A D M I N   C O N S O L E{/}  {cyan-fg}║{/}",
      "  {cyan-fg}╠══════════════════════════════════════════════════╣{/}",
      "  {cyan-fg}║{/}  {gray-fg}Server Management Interface v1.0{/}              {cyan-fg}║{/}",
      "  {cyan-fg}║{/}  {gray-fg}Use arrow keys to navigate, Enter to select{/}  {cyan-fg}║{/}",
      "  {cyan-fg}╚══════════════════════════════════════════════════╝{/}",
      "",
    ].join("\n"),
    style: { fg: "white" },
  });

  const menuItems = [
    "  [1]  Devices          Manage registered devices",
    "  [2]  Invite Tokens    Create and manage invite tokens",
    "  [3]  Credits          User credit balances and grants",
    "  [4]  Auth Log         Authentication event history",
    "  [5]  Usage Stats      LLM token usage by device",
    "  [6]  Tasks            View task history and status",
    "",
    "  [Q]  Quit",
  ];

  const menu = blessed.list({
    parent: screen,
    label: " Main Menu ",
    top: 9,
    left: "center",
    width: "60%",
    height: menuItems.length + 2,
    border: { type: "line" },
    keys: true,
    vi: true,
    mouse: true,
    items: menuItems,
    style: {
      border: { fg: THEME.border },
      selected: { fg: THEME.selectedFg, bg: THEME.selectedBg, bold: true },
      item: { fg: THEME.tableFg },
    } as any,
  });

  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    content: " {yellow-fg}↑↓{/}=Navigate  {yellow-fg}Enter{/}=Select  {yellow-fg}Q{/}=Quit",
    tags: true,
    style: { fg: THEME.headerFg, bg: THEME.headerBg },
  });

  // DB stats summary
  const db = getDatabase();
  const deviceCount = (db.prepare("SELECT COUNT(*) as c FROM devices WHERE status = 'active'").get() as any)?.c || 0;
  const tokenCount = (db.prepare("SELECT COUNT(*) as c FROM invite_tokens WHERE status = 'active'").get() as any)?.c || 0;
  const userCount = (db.prepare("SELECT COUNT(*) as c FROM user_credits").get() as any)?.c || 0;
  const taskCount = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'running'").get() as any)?.c || 0;

  const statsBox = blessed.box({
    parent: screen,
    top: 9 + menuItems.length + 3,
    left: "center",
    width: "60%",
    height: 5,
    border: { type: "line" },
    label: " System Status ",
    tags: true,
    content: [
      `  {green-fg}Devices:{/} ${deviceCount} active    {green-fg}Tokens:{/} ${tokenCount} active`,
      `  {green-fg}Users:{/}   ${userCount}             {green-fg}Tasks:{/}  ${taskCount} running`,
    ].join("\n"),
    style: {
      border: { fg: THEME.border },
      fg: THEME.tableFg,
      label: { fg: THEME.accentFg },
    },
  });

  function navigateTo(screenFn: (screen: blessed.Widgets.Screen, onBack: () => void) => void): void {
    header.destroy();
    menu.destroy();
    statusBar.destroy();
    statsBox.destroy();
    screenFn(screen, () => showMainMenu());
  }

  menu.on("select", (_item: any, idx: number) => {
    switch (idx) {
      case 0: navigateTo(showDevicesScreen); break;
      case 1: navigateTo(showTokensScreen); break;
      case 2: navigateTo(showCreditsScreen); break;
      case 3: navigateTo(showAuthLogScreen); break;
      case 4: navigateTo(showUsageScreen); break;
      case 5: navigateTo(showTasksScreen); break;
      case 7: process.exit(0); break;
    }
  });

  // Number key shortcuts (bound to menu, not screen — destroyed with menu)
  menu.key(["1"], () => navigateTo(showDevicesScreen));
  menu.key(["2"], () => navigateTo(showTokensScreen));
  menu.key(["3"], () => navigateTo(showCreditsScreen));
  menu.key(["4"], () => navigateTo(showAuthLogScreen));
  menu.key(["5"], () => navigateTo(showUsageScreen));
  menu.key(["6"], () => navigateTo(showTasksScreen));
  menu.key(["q"], () => process.exit(0));

  menu.focus();
  screen.render();
}

// Ctrl-C always exits (global)
screen.key(["C-c"], () => process.exit(0));

showMainMenu();
