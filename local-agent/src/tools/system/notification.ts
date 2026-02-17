/**
 * System Tools — Windows Toast Notifications
 *
 * Handler for system.notification.
 */

import type { ToolExecResult } from "../_shared/types.js";
import { runPowershell } from "../_shared/powershell.js";

export async function handleNotification(args: Record<string, any>): Promise<ToolExecResult> {
  const title = args.title || "DotBot";
  const message = args.message || "";
  if (!message) return { success: false, output: "", error: "message is required" };

  // M-07 fix: Escape XML special characters first, then PowerShell quotes
  const xmlEscape = (str: string) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const safeTitle = xmlEscape(title);
  const safeMsg = xmlEscape(message);
  return runPowershell(`
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>${safeTitle}</text>
      <text>${safeMsg}</text>
    </binding>
  </visual>
</toast>
"@
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DotBot').Show($toast)
"Notification sent: ${safeTitle}"`, 15_000);
}
