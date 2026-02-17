/**
 * Admin TUI — Tasks Screen
 */

import blessed from "blessed";
import { getDatabase } from "../../db/index.js";
import {
  THEME, createListTable, showInputPrompt, truncate, formatDate, statusColor,
} from "../helpers.js";

interface TaskRow {
  id: string;
  user_id: string;
  description: string;
  persona_id: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  attempt_count: number;
  error: string | null;
  result: string | null;
}

function queryTasks(limit: number, statusFilter?: string, userFilter?: string): TaskRow[] {
  const db = getDatabase();
  let sql = "SELECT * FROM tasks WHERE 1=1";
  const params: any[] = [];

  if (statusFilter) {
    sql += " AND status = ?";
    params.push(statusFilter);
  }
  if (userFilter) {
    sql += " AND user_id = ?";
    params.push(userFilter);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as TaskRow[];
}

export function showTasksScreen(screen: blessed.Widgets.Screen, onBack: () => void): void {
  const container = blessed.box({ parent: screen, top: 0, left: 0, width: "100%", height: "100%" });

  const table = createListTable(screen, {
    label: "Tasks",
    top: 0,
    height: "100%-3",
    parent: container,
  });

  const bar = blessed.box({
    parent: container,
    bottom: 0, left: 0, width: "100%", height: 1,
    content: " {yellow-fg}Enter{/}=Details  {yellow-fg}F{/}=Filter Status  {yellow-fg}U{/}=Filter User  {yellow-fg}C{/}=Clear  {yellow-fg}Esc{/}=Back",
    tags: true,
    style: { fg: THEME.headerFg, bg: THEME.headerBg },
  });

  let statusFilter: string | undefined;
  let userFilter: string | undefined;
  let tasks: TaskRow[] = [];

  function refresh(): void {
    tasks = queryTasks(200, statusFilter, userFilter);
    const filters = [statusFilter && `status=${statusFilter}`, userFilter && `user=${truncate(userFilter, 12)}`].filter(Boolean).join(", ");
    table.setLabel(` Tasks${filters ? " [" + filters + "]" : ""} (${tasks.length}) `);

    const rows: string[][] = [
      ["ID", "User", "Persona", "Status", "Description", "Created"],
    ];
    for (const t of tasks) {
      rows.push([
        truncate(t.id, 18),
        truncate(t.user_id, 16),
        truncate(t.persona_id || "—", 16),
        statusColor(t.status),
        truncate(t.description, 30),
        formatDate(t.created_at),
      ]);
    }
    table.setData(rows);
    screen.render();
  }

  function getSelectedTask(): TaskRow | null {
    const sel = (table as any).selected as number;
    if (sel < 1 || sel - 1 >= tasks.length) return null;
    return tasks[sel - 1];
  }

  // Detail view
  table.key(["enter"], () => {
    const t = getSelectedTask();
    if (!t) return;

    let content = "";
    content += `  {yellow-fg}Task ID:{/}     ${t.id}\n`;
    content += `  {yellow-fg}User:{/}        ${t.user_id}\n`;
    content += `  {yellow-fg}Persona:{/}     ${t.persona_id || "—"}\n`;
    content += `  {yellow-fg}Status:{/}      ${statusColor(t.status)}\n`;
    content += `  {yellow-fg}Created:{/}     ${formatDate(t.created_at)}\n`;
    content += `  {yellow-fg}Completed:{/}   ${formatDate(t.completed_at)}\n`;
    content += `  {yellow-fg}Attempts:{/}    ${t.attempt_count}\n\n`;
    content += `  {yellow-fg}Description:{/}\n  ${t.description}\n`;

    if (t.error) {
      content += `\n  {red-fg}Error:{/}\n  ${t.error}\n`;
    }
    if (t.result) {
      try {
        const parsed = JSON.parse(t.result);
        content += `\n  {yellow-fg}Result:{/}\n  ${JSON.stringify(parsed, null, 2).split("\n").join("\n  ")}\n`;
      } catch {
        content += `\n  {yellow-fg}Result:{/}\n  ${truncate(t.result, 500)}\n`;
      }
    }

    const box = blessed.box({
      parent: container,
      label: ` Task: ${truncate(t.id, 30)} `,
      content,
      top: "center",
      left: "center",
      width: "85%",
      height: "85%",
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

  // Filter by status
  table.key(["f"], () => {
    const statuses = ["pending", "running", "completed", "failed", "timeout", "cancelled"];
    const list = blessed.list({
      parent: container,
      label: " Filter by Status ",
      top: "center",
      left: "center",
      width: 30,
      height: statuses.length + 2,
      border: { type: "line" },
      keys: true,
      vi: true,
      mouse: true,
      items: statuses,
      style: {
        border: { fg: THEME.inputBorder },
        selected: { fg: THEME.selectedFg, bg: THEME.selectedBg },
        item: { fg: THEME.tableFg },
      },
    });
    list.focus();
    list.on("select", (_item: any, idx: number) => {
      statusFilter = statuses[idx];
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

  // Filter by user
  table.key(["u"], () => {
    showInputPrompt(screen, "Filter by User", "User ID:", (uid: string | null) => {
      if (uid) userFilter = uid;
      refresh();
      table.focus();
    });
  });

  // Clear filters
  table.key(["c"], () => {
    statusFilter = undefined;
    userFilter = undefined;
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
