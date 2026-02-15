/**
 * Network Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, safeInt, runPowershell } from "../_shared/powershell.js";

export async function handleNetwork(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "network.ping": {
      const count = safeInt(args.count, 4);
      return runPowershell(`Test-Connection -ComputerName "${sanitizeForPS(args.host)}" -Count ${count} | Format-Table -AutoSize | Out-String`);
    }
    case "network.dns_lookup": {
      // Validate DNS type is alphanumeric only
      const type = /^[A-Z]{1,10}$/i.test(args.type || "") ? args.type : "A";
      return runPowershell(`Resolve-DnsName -Name "${sanitizeForPS(args.domain)}" -Type ${type} | Format-Table -AutoSize | Out-String`);
    }
    case "network.port_check": {
      const port = safeInt(args.port, 0);
      if (port < 1 || port > 65535) return { success: false, output: "", error: "Invalid port (1-65535)" };
      return runPowershell(`$r = Test-NetConnection -ComputerName "${sanitizeForPS(args.host)}" -Port ${port} -WarningAction SilentlyContinue; "Host: $($r.ComputerName) Port: ${port} Open: $($r.TcpTestSucceeded)"`);
    }
    default:
      return { success: false, output: "", error: `Unknown network tool: ${toolId}` };
  }
}
