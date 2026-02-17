/**
 * Admin TUI — Credits Screen
 */

import blessed from "blessed";
import { getBalance, addCredits, getTransactions } from "../../credits/service.js";
import { getDatabase } from "../../db/index.js";
import {
  THEME, createListTable, createStatusBar, showMessage,
  showConfirm, showInputPrompt, truncate, formatDate,
} from "../helpers.js";

interface UserCreditRow {
  user_id: string;
  balance: number;
  lifetime_earned: number;
  lifetime_spent: number;
  created_at: string;
  updated_at: string;
}

function getAllUsers(): UserCreditRow[] {
  const db = getDatabase();
  return db.prepare("SELECT * FROM user_credits ORDER BY balance DESC").all() as UserCreditRow[];
}

export function showCreditsScreen(screen: blessed.Widgets.Screen, onBack: () => void): void {
  const container = blessed.box({ parent: screen, top: 0, left: 0, width: "100%", height: "100%" });

  const table = createListTable(screen, {
    label: "User Credits",
    top: 0,
    height: "100%-3",
    parent: container,
  });

  const bar = blessed.box({
    parent: container,
    bottom: 0, left: 0, width: "100%", height: 1,
    content: " {yellow-fg}Enter{/}=Transactions  {yellow-fg}G{/}=Grant  {yellow-fg}S{/}=Set Balance  {yellow-fg}A{/}=Grant All  {yellow-fg}Esc{/}=Back",
    tags: true,
    style: { fg: THEME.headerFg, bg: THEME.headerBg },
  });

  let users: UserCreditRow[] = [];

  function refresh(): void {
    users = getAllUsers();
    const rows: string[][] = [
      ["User ID", "Balance", "Earned", "Spent", "Since"],
    ];
    for (const u of users) {
      rows.push([
        truncate(u.user_id, 24),
        String(u.balance),
        String(u.lifetime_earned),
        String(u.lifetime_spent),
        formatDate(u.created_at),
      ]);
    }
    table.setData(rows);
    screen.render();
  }

  function getSelectedUser(): UserCreditRow | null {
    const sel = (table as any).selected as number;
    if (sel < 1 || sel - 1 >= users.length) return null;
    return users[sel - 1];
  }

  // View transactions
  table.key(["enter"], () => {
    const u = getSelectedUser();
    if (!u) return;

    const txns = getTransactions(u.user_id, 50);
    let content = `  {yellow-fg}User:{/}     ${u.user_id}\n`;
    content += `  {yellow-fg}Balance:{/}  ${u.balance}\n`;
    content += `  {yellow-fg}Earned:{/}   ${u.lifetime_earned}\n`;
    content += `  {yellow-fg}Spent:{/}    ${u.lifetime_spent}\n\n`;
    content += `  {yellow-fg}Recent Transactions:{/}\n\n`;

    if (txns.length === 0) {
      content += "  (none)\n";
    }
    for (const tx of txns) {
      const sign = tx.amount >= 0 ? `{green-fg}+${tx.amount}{/}` : `{red-fg}${tx.amount}{/}`;
      content += `  ${formatDate(tx.createdAt)}  ${sign}  bal=${tx.balanceAfter}`;
      if (tx.toolId) content += `  [${tx.toolId}]`;
      content += `  ${tx.reason}\n`;
    }

    const box = blessed.box({
      parent: container,
      label: ` Credits: ${truncate(u.user_id, 30)} `,
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

  // Grant to selected user
  table.key(["g"], () => {
    const u = getSelectedUser();
    if (!u) return;
    showInputPrompt(screen, "Grant Credits", `Amount for ${truncate(u.user_id, 20)}:`, (amtStr) => {
      if (!amtStr) { table.focus(); return; }
      const amount = parseInt(amtStr);
      if (!amount || amount <= 0) {
        showMessage(screen, "Error", "\n  Invalid amount.", () => table.focus());
        return;
      }
      showInputPrompt(screen, "Grant Credits", "Reason (or blank):", (reason) => {
        addCredits(u.user_id, amount, reason || "Admin grant");
        refresh();
        showMessage(screen, "Done",
          `\n  Granted {green-fg}${amount}{/} credits to\n  ${u.user_id}\n\n  New balance: ${getBalance(u.user_id)}`,
          () => table.focus(),
        );
      });
    });
  });

  // Set balance
  table.key(["s"], () => {
    const u = getSelectedUser();
    if (!u) return;
    showInputPrompt(screen, "Set Balance", `New balance for ${truncate(u.user_id, 20)} (current: ${u.balance}):`, (valStr) => {
      if (!valStr) { table.focus(); return; }
      const newBal = parseInt(valStr);
      if (isNaN(newBal) || newBal < 0) {
        showMessage(screen, "Error", "\n  Invalid balance.", () => table.focus());
        return;
      }
      showConfirm(screen, "Set Balance",
        `\n  Set balance?\n\n  {yellow-fg}${u.user_id}{/}\n  ${u.balance} -> ${newBal}`,
        () => {
          const db = getDatabase();
          const now = new Date().toISOString();
          db.prepare("UPDATE user_credits SET balance = ?, updated_at = ? WHERE user_id = ?").run(newBal, now, u.user_id);
          refresh();
          showMessage(screen, "Done", `\n  Balance set to ${newBal}.`, () => table.focus());
        },
        () => table.focus(),
      );
    });
  });

  // Grant to ALL users
  table.key(["a"], () => {
    showInputPrompt(screen, "Grant All", `Amount for ALL ${users.length} users:`, (amtStr) => {
      if (!amtStr) { table.focus(); return; }
      const amount = parseInt(amtStr);
      if (!amount || amount <= 0) {
        showMessage(screen, "Error", "\n  Invalid amount.", () => table.focus());
        return;
      }
      showInputPrompt(screen, "Grant All", "Reason (or blank):", (reason) => {
        showConfirm(screen, "Grant All",
          `\n  Grant {green-fg}${amount}{/} credits to\n  ALL ${users.length} users?`,
          () => {
            for (const u of users) {
              addCredits(u.user_id, amount, reason || "Admin grant (bulk)");
            }
            refresh();
            showMessage(screen, "Done",
              `\n  Granted {green-fg}${amount}{/} credits\n  to ${users.length} user(s).`,
              () => table.focus(),
            );
          },
          () => table.focus(),
        );
      });
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
