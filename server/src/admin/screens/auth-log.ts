/**
 * Admin TUI — Auth Log Screen
 */

import blessed from "blessed";
import { getDatabase } from "../../db/index.js";
import {
  THEME, createListTable, showInputPrompt, truncate, formatDate,
} from "../helpers.js";

interface AuthEvent {
  id: string;
  event_type: string;
  device_id: string | null;
  ip: string | null;
  reason: string | null;
  metadata: string | null;
  created_at: string;
}

function queryEvents(limit: number, typeFilter?: string, ipFilter?: string): AuthEvent[] {
  const db = getDatabase();
  let sql = "SELECT * FROM auth_events WHERE 1=1";
  const params: any[] = [];

  if (typeFilter) {
    sql += " AND event_type = ?";
    params.push(typeFilter);
  }
  if (ipFilter) {
    sql += " AND ip = ?";
    params.push(ipFilter);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as AuthEvent[];
}

function eventColor(type: string): string {
  switch (type) {
    case "auth_success": return `{green-fg}${type}{/}`;
    case "auth_failure": return `{red-fg}${type}{/}`;
    case "register": return `{cyan-fg}${type}{/}`;
    case "revoke": return `{yellow-fg}${type}{/}`;
    case "fingerprint_mismatch": return `{magenta-fg}${type}{/}`;
    default: return type;
  }
}

export function showAuthLogScreen(screen: blessed.Widgets.Screen, onBack: () => void): void {
  const container = blessed.box({ parent: screen, top: 0, left: 0, width: "100%", height: "100%" });

  const table = createListTable(screen, {
    label: "Auth Events",
    top: 0,
    height: "100%-3",
    parent: container,
  });

  const bar = blessed.box({
    parent: container,
    bottom: 0, left: 0, width: "100%", height: 1,
    content: " {yellow-fg}F{/}=Filter Type  {yellow-fg}I{/}=Filter IP  {yellow-fg}C{/}=Clear Filters  {yellow-fg}Esc{/}=Back",
    tags: true,
    style: { fg: THEME.headerFg, bg: THEME.headerBg },
  });

  let typeFilter: string | undefined;
  let ipFilter: string | undefined;

  function refresh(): void {
    const events = queryEvents(200, typeFilter, ipFilter);
    const filterStr = [typeFilter && `type=${typeFilter}`, ipFilter && `ip=${ipFilter}`].filter(Boolean).join(", ");
    table.setLabel(` Auth Events${filterStr ? " [" + filterStr + "]" : ""} (${events.length}) `);

    const rows: string[][] = [
      ["Time", "Type", "Device", "IP", "Reason"],
    ];
    for (const e of events) {
      rows.push([
        formatDate(e.created_at),
        eventColor(e.event_type),
        truncate(e.device_id || "—", 20),
        truncate(e.ip || "—", 15),
        truncate(e.reason || "", 25),
      ]);
    }
    table.setData(rows);
    screen.render();
  }

  // Filter by type
  table.key(["f"], () => {
    const types = ["auth_success", "auth_failure", "register", "revoke", "fingerprint_mismatch"];
    const list = blessed.list({
      parent: container,
      label: " Filter by Type ",
      top: "center",
      left: "center",
      width: 35,
      height: types.length + 2,
      border: { type: "line" },
      keys: true,
      vi: true,
      mouse: true,
      items: types,
      style: {
        border: { fg: THEME.inputBorder },
        selected: { fg: THEME.selectedFg, bg: THEME.selectedBg },
        item: { fg: THEME.tableFg },
      },
    });
    list.focus();
    list.on("select", (_item: any, idx: number) => {
      typeFilter = types[idx];
      list.destroy();
      refresh();
      table.focus();
    });
    list.key(["escape"], () => {
      list.destroy();
      table.focus();
      screen.render();
    });
    screen.render();
  });

  // Filter by IP
  table.key(["i"], () => {
    showInputPrompt(screen, "Filter by IP", "IP address:", (ip: string | null) => {
      if (ip) ipFilter = ip;
      refresh();
      table.focus();
    });
  });

  // Clear filters
  table.key(["c"], () => {
    typeFilter = undefined;
    ipFilter = undefined;
    refresh();
  });

  // Back
  table.key(["escape"], () => {
    container.destroy();
    bar.destroy();
    onBack();
  });

  table.focus();
  refresh();
}
