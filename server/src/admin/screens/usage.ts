/**
 * Admin TUI — Usage Stats Screen
 */

import blessed from "blessed";
import { getDatabase } from "../../db/index.js";
import {
  THEME, createListTable, showInputPrompt, truncate, formatDate,
} from "../helpers.js";

interface UsageRow {
  device_id: string;
  model: string;
  role: string;
  total_input: number;
  total_output: number;
  call_count: number;
}

function getUsageByDevice(days: number): UsageRow[] {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT device_id, model, role,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      COUNT(*) as call_count
    FROM token_usage
    WHERE timestamp > ?
    GROUP BY device_id, model, role
    ORDER BY total_input + total_output DESC
  `).all(cutoff) as UsageRow[];
}

interface DeviceSummary {
  device_id: string;
  total_input: number;
  total_output: number;
  call_count: number;
}

function getDeviceSummaries(days: number): DeviceSummary[] {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT device_id,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      COUNT(*) as call_count
    FROM token_usage
    WHERE timestamp > ?
    GROUP BY device_id
    ORDER BY total_input + total_output DESC
  `).all(cutoff) as DeviceSummary[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function showUsageScreen(screen: blessed.Widgets.Screen, onBack: () => void): void {
  const container = blessed.box({ parent: screen, top: 0, left: 0, width: "100%", height: "100%" });

  const table = createListTable(screen, {
    label: "Token Usage",
    top: 0,
    height: "100%-3",
    parent: container,
  });

  const bar = blessed.box({
    parent: container,
    bottom: 0, left: 0, width: "100%", height: 1,
    content: " {yellow-fg}Enter{/}=Device Detail  {yellow-fg}D{/}=Change Days  {yellow-fg}Esc{/}=Back",
    tags: true,
    style: { fg: THEME.headerFg, bg: THEME.headerBg },
  });

  let days = 7;
  let summaries: DeviceSummary[] = [];

  function refresh(): void {
    summaries = getDeviceSummaries(days);
    table.setLabel(` Token Usage (last ${days} days) `);

    const rows: string[][] = [
      ["Device", "Input Tokens", "Output Tokens", "Total", "Calls"],
    ];

    let totalIn = 0, totalOut = 0, totalCalls = 0;
    for (const s of summaries) {
      totalIn += s.total_input;
      totalOut += s.total_output;
      totalCalls += s.call_count;
      rows.push([
        truncate(s.device_id, 24),
        formatTokens(s.total_input),
        formatTokens(s.total_output),
        formatTokens(s.total_input + s.total_output),
        String(s.call_count),
      ]);
    }

    if (summaries.length > 1) {
      rows.push([
        "{yellow-fg}TOTAL{/}",
        `{yellow-fg}${formatTokens(totalIn)}{/}`,
        `{yellow-fg}${formatTokens(totalOut)}{/}`,
        `{yellow-fg}${formatTokens(totalIn + totalOut)}{/}`,
        `{yellow-fg}${totalCalls}{/}`,
      ]);
    }

    table.setData(rows);
    screen.render();
  }

  // Detail by model for selected device
  table.key(["enter"], () => {
    const sel = (table as any).selected as number;
    if (sel < 1 || sel - 1 >= summaries.length) return;
    const deviceId = summaries[sel - 1].device_id;

    const detail = getUsageByDevice(days).filter(r => r.device_id === deviceId);
    let content = `  {yellow-fg}Device:{/}  ${deviceId}\n`;
    content += `  {yellow-fg}Period:{/}  Last ${days} days\n\n`;
    content += `  ${"Model".padEnd(35)} ${"Role".padEnd(12)} ${"Input".padStart(10)} ${"Output".padStart(10)} ${"Calls".padStart(8)}\n`;
    content += `  ${"─".repeat(35)} ${"─".repeat(12)} ${"─".repeat(10)} ${"─".repeat(10)} ${"─".repeat(8)}\n`;

    for (const r of detail) {
      content += `  ${truncate(r.model, 35).padEnd(35)} ${r.role.padEnd(12)} ${formatTokens(r.total_input).padStart(10)} ${formatTokens(r.total_output).padStart(10)} ${String(r.call_count).padStart(8)}\n`;
    }

    const box = blessed.box({
      parent: container,
      label: ` Usage: ${truncate(deviceId, 30)} `,
      content,
      top: "center",
      left: "center",
      width: "85%",
      height: "80%",
      border: { type: "line" },
      tags: true,
      keys: true,
      vi: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "█", style: { bg: "cyan" } },
      style: {
        border: { fg: THEME.border },
        fg: THEME.tableFg,
        label: { fg: THEME.accentFg },
      },
    });
    box.focus();
    box.key(["escape", "q", "enter"], () => {
      box.destroy();
      table.focus();
      screen.render();
    });
    screen.render();
  });

  // Change days
  table.key(["d"], () => {
    showInputPrompt(screen, "Time Range", `Days to include (current: ${days}):`, (val) => {
      if (val) {
        const n = parseInt(val);
        if (n > 0) days = n;
      }
      refresh();
      table.focus();
    });
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
