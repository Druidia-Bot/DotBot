/**
 * Admin TUI — Invite Tokens Screen
 */

import blessed from "blessed";
import { createInviteToken, listTokens } from "../../auth/invite-tokens.js";
import { getDatabase } from "../../db/index.js";
import {
  THEME, createListTable, createStatusBar, showMessage,
  showConfirm, showInputPrompt, truncate, formatDate, statusColor,
} from "../helpers.js";

export function showTokensScreen(screen: blessed.Widgets.Screen, onBack: () => void): void {
  const container = blessed.box({ parent: screen, top: 0, left: 0, width: "100%", height: "100%" });

  const table = createListTable(screen, {
    label: "Invite Tokens",
    top: 0,
    height: "100%-3",
    parent: container,
  });

  const bar = blessed.box({
    parent: container,
    bottom: 0, left: 0, width: "100%", height: 1,
    content: " {yellow-fg}C{/}=Create  {yellow-fg}R{/}=Revoke  {yellow-fg}Esc{/}=Back",
    tags: true,
    style: { fg: THEME.headerFg, bg: THEME.headerBg },
  });

  let tokens = listTokens();

  function refresh(): void {
    tokens = listTokens();
    const rows: string[][] = [
      ["ID", "Label", "Status", "Uses", "Expires", "Created"],
    ];
    for (const t of tokens) {
      rows.push([
        truncate(t.tokenHash.slice(0, 16), 18),
        truncate(t.label || "", 25),
        statusColor(t.status),
        `${t.usedCount}/${t.maxUses}`,
        formatDate(t.expiresAt),
        formatDate(t.createdAt),
      ]);
    }
    table.setData(rows);
    screen.render();
  }

  function getSelectedIndex(): number {
    const sel = (table as any).selected as number;
    if (sel < 1 || sel - 1 >= tokens.length) return -1;
    return sel - 1;
  }

  // Create
  table.key(["c"], () => {
    showInputPrompt(screen, "Create Token", "Label (or blank):", (label) => {
      showInputPrompt(screen, "Create Token", "Max uses (default 1):", (usesStr) => {
        showInputPrompt(screen, "Create Token", "Expiry days (default 7):", (daysStr) => {
          const maxUses = usesStr ? parseInt(usesStr) || 1 : 1;
          const expiryDays = daysStr ? parseInt(daysStr) || 7 : 7;
          try {
            const { token, expiresAt } = createInviteToken({
              label: label || "Admin CLI token",
              maxUses,
              expiryDays,
            });
            const publicUrl = process.env.PUBLIC_URL || "http://localhost:3000";
            const inviteUrl = `${publicUrl}/invite/${token}`;
            refresh();
            showMessage(screen, "Token Created",
              `\n  {yellow-fg}Token:{/}   ${token}\n\n` +
              `  {yellow-fg}URL:{/}     ${inviteUrl}\n\n` +
              `  {yellow-fg}Expires:{/} ${expiresAt.slice(0, 10)}\n` +
              `  {yellow-fg}Uses:{/}    ${maxUses}\n\n` +
              `  {red-fg}Copy this now — the plaintext token\n  is never shown again.{/}`,
              () => table.focus(),
            );
          } catch (err: any) {
            showMessage(screen, "Error", `\n  ${err.message}`, () => table.focus());
          }
        });
      });
    });
  });

  // Revoke — note: we can't revoke by plaintext since we only have hashes.
  // Instead we revoke by setting status directly.
  table.key(["r"], () => {
    const idx = getSelectedIndex();
    if (idx < 0) return;
    const t = tokens[idx];
    if (t.status === "revoked") {
      showMessage(screen, "Info", `\n  Token is already revoked.`, () => table.focus());
      return;
    }
    showConfirm(screen, "Revoke Token",
      `\n  Revoke token?\n\n  {yellow-fg}${t.label}{/}`,
      () => {
        const db = getDatabase();
        db.prepare("UPDATE invite_tokens SET status = 'revoked' WHERE token_hash = ?").run(t.tokenHash);
        refresh();
        table.focus();
        showMessage(screen, "Done", `\n  Token revoked.`, () => table.focus());
      },
      () => table.focus(),
    );
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
