/**
 * Admin TUI — Shared Helpers
 * 
 * Common widgets and utilities for the DOS-style admin interface.
 */

import blessed from "blessed";

// ============================================
// COLORS / THEME
// ============================================

export const THEME = {
  border: "cyan",
  headerFg: "white",
  headerBg: "blue",
  tableFg: "white",
  tableHeaderFg: "yellow",
  selectedFg: "black",
  selectedBg: "cyan",
  statusFg: "green",
  errorFg: "red",
  mutedFg: "gray",
  accentFg: "cyan",
  inputBorder: "yellow",
} as const;

// ============================================
// COMMON WIDGET FACTORIES
// ============================================

export function createListTable(
  screen: blessed.Widgets.Screen,
  opts: {
    label: string;
    top?: number | string;
    left?: number | string;
    width?: number | string;
    height?: number | string;
    parent?: blessed.Widgets.Node;
  },
): blessed.Widgets.ListTableElement {
  return blessed.listtable({
    parent: opts.parent || screen,
    label: ` ${opts.label} `,
    top: opts.top ?? 0,
    left: opts.left ?? 0,
    width: opts.width ?? "100%",
    height: opts.height ?? "100%-2",
    border: { type: "line" },
    align: "left",
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    noCellBorders: true,
    scrollbar: {
      ch: "█",
      style: { bg: "cyan" },
    },
    style: {
      border: { fg: THEME.border },
      header: { fg: THEME.tableHeaderFg, bold: true },
      cell: { fg: THEME.tableFg, selected: { fg: THEME.selectedFg, bg: THEME.selectedBg } },
    },
  });
}

export function createInfoBox(
  screen: blessed.Widgets.Screen,
  opts: {
    label: string;
    content: string;
    top?: number | string;
    left?: number | string;
    width?: number | string;
    height?: number | string;
    parent?: blessed.Widgets.Node;
  },
): blessed.Widgets.BoxElement {
  return blessed.box({
    parent: opts.parent || screen,
    label: ` ${opts.label} `,
    content: opts.content,
    top: opts.top ?? "center",
    left: opts.left ?? "center",
    width: opts.width ?? "80%",
    height: opts.height ?? "80%",
    border: { type: "line" },
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: "█",
      style: { bg: "cyan" },
    },
    style: {
      border: { fg: THEME.border },
      fg: THEME.tableFg,
      label: { fg: THEME.accentFg },
    },
  });
}

export function createStatusBar(
  screen: blessed.Widgets.Screen,
  text: string,
): blessed.Widgets.BoxElement {
  return blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    content: text,
    tags: true,
    style: {
      fg: THEME.headerFg,
      bg: THEME.headerBg,
    },
  });
}

export function showMessage(
  screen: blessed.Widgets.Screen,
  title: string,
  content: string,
  callback?: () => void,
): blessed.Widgets.BoxElement {
  const msg = blessed.box({
    parent: screen,
    label: ` ${title} `,
    content,
    top: "center",
    left: "center",
    width: "50%",
    height: "40%",
    border: { type: "line" },
    tags: true,
    keys: true,
    style: {
      border: { fg: "yellow" },
      fg: THEME.tableFg,
      label: { fg: "yellow" },
    },
  });
  msg.focus();
  msg.key(["enter", "escape", "q"], () => {
    msg.destroy();
    screen.render();
    if (callback) callback();
  });
  screen.render();
  return msg;
}

export function showConfirm(
  screen: blessed.Widgets.Screen,
  title: string,
  content: string,
  onConfirm: () => void,
  onCancel?: () => void,
): void {
  const box = blessed.box({
    parent: screen,
    label: ` ${title} `,
    content: content + "\n\n  {yellow-fg}[Y]{/} Yes   {yellow-fg}[N]{/} No",
    top: "center",
    left: "center",
    width: "50%",
    height: "40%",
    border: { type: "line" },
    tags: true,
    keys: true,
    style: {
      border: { fg: "red" },
      fg: THEME.tableFg,
      label: { fg: "red" },
    },
  });
  box.focus();
  box.key(["y"], () => {
    box.destroy();
    screen.render();
    onConfirm();
  });
  box.key(["n", "escape"], () => {
    box.destroy();
    screen.render();
    if (onCancel) onCancel();
  });
  screen.render();
}

export function showInputPrompt(
  screen: blessed.Widgets.Screen,
  title: string,
  label: string,
  callback: (value: string | null) => void,
): void {
  const form = blessed.form({
    parent: screen,
    label: ` ${title} `,
    top: "center",
    left: "center",
    width: "50%",
    height: 7,
    border: { type: "line" },
    keys: true,
    tags: true,
    style: {
      border: { fg: THEME.inputBorder },
      label: { fg: THEME.inputBorder },
    },
  }) as blessed.Widgets.FormElement<{ input: string }>;

  blessed.text({
    parent: form,
    content: label,
    top: 0,
    left: 1,
    style: { fg: THEME.tableFg },
  });

  const input = blessed.textbox({
    parent: form,
    name: "input",
    top: 1,
    left: 1,
    width: "100%-4",
    height: 1,
    inputOnFocus: true,
    style: {
      fg: "white",
      bg: "black",
      focus: { bg: "blue" },
    },
  });

  blessed.text({
    parent: form,
    content: "{yellow-fg}Enter{/}=OK  {yellow-fg}Esc{/}=Cancel",
    tags: true,
    top: 3,
    left: 1,
    style: { fg: THEME.mutedFg },
  });

  input.focus();

  input.key("enter", () => {
    const val = input.getValue().trim();
    form.destroy();
    screen.render();
    callback(val || null);
  });

  input.key("escape", () => {
    form.destroy();
    screen.render();
    callback(null);
  });

  screen.render();
}

// ============================================
// FORMATTING HELPERS
// ============================================

export function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "~" : str;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      + " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return iso.slice(0, 16);
  }
}

export function statusColor(status: string): string {
  switch (status) {
    case "active": return `{green-fg}${status}{/}`;
    case "revoked": case "expired": case "failed": case "timeout": case "cancelled": return `{red-fg}${status}{/}`;
    case "consumed": return `{yellow-fg}${status}{/}`;
    case "running": case "pending": return `{cyan-fg}${status}{/}`;
    case "completed": return `{green-fg}${status}{/}`;
    default: return status;
  }
}
