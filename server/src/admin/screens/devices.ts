/**
 * Admin TUI — Devices Screen
 */

import blessed from "blessed";
import { listDevices, revokeDevice, unrevokeDevice, getDevice } from "../../auth/device-store.js";
import { getDatabase } from "../../db/index.js";
import {
  THEME, createListTable, createStatusBar, showMessage,
  showConfirm, truncate, formatDate, statusColor,
} from "../helpers.js";

export function showDevicesScreen(screen: blessed.Widgets.Screen, onBack: () => void): void {
  const container = blessed.box({ parent: screen, top: 0, left: 0, width: "100%", height: "100%" });

  const table = createListTable(screen, {
    label: "Devices",
    top: 0,
    height: "100%-3",
    parent: container,
  });

  const bar = createStatusBar(screen, "");
  bar.setContent(
    " {yellow-fg}Enter{/}=Details  {yellow-fg}R{/}=Revoke  {yellow-fg}U{/}=Unrevoke  {yellow-fg}A{/}=Toggle Admin  {yellow-fg}Esc{/}=Back"
  );
  (bar as any).parent = container;

  function refresh(): void {
    const devices = listDevices();
    const rows: string[][] = [
      ["ID", "Label", "Status", "Admin", "Last Seen", "IP"],
    ];
    for (const d of devices) {
      rows.push([
        truncate(d.deviceId, 24),
        truncate(d.label, 20),
        statusColor(d.status),
        d.isAdmin ? "{green-fg}YES{/}" : "no",
        formatDate(d.lastSeenAt),
        truncate(d.lastSeenIp, 15),
      ]);
    }
    table.setData(rows);
    screen.render();
  }

  function getSelectedDeviceId(): string | null {
    const sel = (table as any).selected as number;
    if (sel < 1) return null; // header row
    const devices = listDevices();
    if (sel - 1 >= devices.length) return null;
    return devices[sel - 1].deviceId;
  }

  // Details
  table.key(["enter"], () => {
    const id = getSelectedDeviceId();
    if (!id) return;
    const d = getDevice(id);
    if (!d) return;

    const db = getDatabase();
    const events = db.prepare(
      "SELECT * FROM auth_events WHERE device_id = ? ORDER BY created_at DESC LIMIT 20"
    ).all(id) as any[];

    let content = "";
    content += `  {yellow-fg}Device ID:{/}    ${d.deviceId}\n`;
    content += `  {yellow-fg}Label:{/}        ${d.label}\n`;
    content += `  {yellow-fg}Status:{/}       ${statusColor(d.status)}\n`;
    content += `  {yellow-fg}Admin:{/}        ${d.isAdmin ? "{green-fg}YES{/}" : "no"}\n`;
    content += `  {yellow-fg}Registered:{/}   ${formatDate(d.registeredAt)}\n`;
    content += `  {yellow-fg}Last Seen:{/}    ${formatDate(d.lastSeenAt)}\n`;
    content += `  {yellow-fg}Last IP:{/}      ${d.lastSeenIp}\n`;
    content += `  {yellow-fg}Fingerprint:{/}  ${truncate(d.hwFingerprint, 40)}\n`;
    content += "\n  {yellow-fg}Recent Auth Events:{/}\n";

    if (events.length === 0) {
      content += "  (none)\n";
    }
    for (const e of events) {
      const typeCol = e.event_type === "auth_success" ? `{green-fg}${e.event_type}{/}` :
        e.event_type === "auth_failure" ? `{red-fg}${e.event_type}{/}` :
          `{cyan-fg}${e.event_type}{/}`;
      content += `  ${formatDate(e.created_at)}  ${typeCol}`;
      if (e.reason) content += `  ${e.reason}`;
      if (e.ip) content += `  (${e.ip})`;
      content += "\n";
    }

    const box = blessed.box({
      parent: container,
      label: ` Device: ${truncate(d.label, 30)} `,
      content,
      top: "center",
      left: "center",
      width: "80%",
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

  // Revoke
  table.key(["r"], () => {
    const id = getSelectedDeviceId();
    if (!id) return;
    const d = getDevice(id);
    if (!d) return;
    if (d.status === "revoked") {
      showMessage(screen, "Info", `\n  Device is already revoked.`, () => table.focus());
      return;
    }
    showConfirm(screen, "Revoke Device",
      `\n  Revoke device?\n\n  {yellow-fg}${d.label}{/}\n  ${d.deviceId}`,
      () => {
        revokeDevice(id);
        refresh();
        table.focus();
        showMessage(screen, "Done", `\n  Device revoked.`, () => table.focus());
      },
      () => table.focus(),
    );
  });

  // Unrevoke
  table.key(["u"], () => {
    const id = getSelectedDeviceId();
    if (!id) return;
    const d = getDevice(id);
    if (!d) return;
    if (d.status !== "revoked") {
      showMessage(screen, "Info", `\n  Device is not revoked.`, () => table.focus());
      return;
    }
    showConfirm(screen, "Unrevoke Device",
      `\n  Restore device?\n\n  {yellow-fg}${d.label}{/}\n  ${d.deviceId}`,
      () => {
        unrevokeDevice(id);
        refresh();
        table.focus();
        showMessage(screen, "Done", `\n  Device restored.`, () => table.focus());
      },
      () => table.focus(),
    );
  });

  // Toggle admin
  table.key(["a"], () => {
    const id = getSelectedDeviceId();
    if (!id) return;
    const d = getDevice(id);
    if (!d) return;
    const newAdmin = !d.isAdmin;
    const verb = newAdmin ? "Promote to admin" : "Remove admin";
    showConfirm(screen, verb,
      `\n  ${verb}?\n\n  {yellow-fg}${d.label}{/}\n  ${d.deviceId}`,
      () => {
        const db = getDatabase();
        db.prepare("UPDATE devices SET is_admin = ? WHERE id = ?").run(newAdmin ? 1 : 0, id);
        refresh();
        table.focus();
        showMessage(screen, "Done", `\n  ${verb} complete.`, () => table.focus());
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
