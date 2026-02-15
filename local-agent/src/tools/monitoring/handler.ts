/**
 * Performance Monitoring Tool Handler
 */

import type { ToolExecResult } from "../_shared/types.js";
import { sanitizeForPS, safeInt, runPowershell } from "../_shared/powershell.js";

export async function handleMonitoring(toolId: string, args: Record<string, any>): Promise<ToolExecResult> {
  switch (toolId) {
    case "monitoring.cpu_usage": {
      if (args.process) {
        const p = sanitizeForPS(args.process);
        return runPowershell('Get-Process -Name "' + p + '" -ErrorAction SilentlyContinue | Select-Object Name, Id, CPU, @{N="WorkingSetMB";E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String');
      }
      return runPowershell('$cpu = (Get-CimInstance Win32_Processor).LoadPercentage; "CPU Usage: $cpu%"; ""; Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name, Id, CPU, @{N="MemMB";E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String');
    }
    case "monitoring.memory_usage": {
      if (args.process) {
        const p = sanitizeForPS(args.process);
        return runPowershell('Get-Process -Name "' + p + '" -ErrorAction SilentlyContinue | Select-Object Name, Id, @{N="WorkingSetMB";E={[math]::Round($_.WorkingSet64/1MB,1)}}, @{N="PrivateMB";E={[math]::Round($_.PrivateMemorySize64/1MB,1)}} | Format-Table -AutoSize | Out-String');
      }
      return runPowershell('$os = Get-CimInstance Win32_OperatingSystem; $total = [math]::Round($os.TotalVisibleMemorySize/1MB,1); $free = [math]::Round($os.FreePhysicalMemory/1MB,1); $used = $total - $free; $pct = [math]::Round(($used/$total)*100,1); "RAM: $used GB / $total GB ($pct% used, $free GB free)"; ""; Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Name, Id, @{N="MemMB";E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String');
    }
    case "monitoring.disk_io": {
      const drive = args.drive ? sanitizeForPS(args.drive) : "_Total";
      return runPowershell('Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, @{N="SizeGB";E={[math]::Round($_.Size/1GB,1)}}, @{N="FreeGB";E={[math]::Round($_.FreeSpace/1GB,1)}}, @{N="UsedPct";E={if($_.Size -gt 0){[math]::Round((($_.Size-$_.FreeSpace)/$_.Size)*100,1)}else{0}}} | Format-Table -AutoSize | Out-String');
    }
    case "monitoring.network_traffic": {
      return runPowershell('Get-NetAdapterStatistics | Select-Object Name, ReceivedBytes, SentBytes, @{N="RecvMB";E={[math]::Round($_.ReceivedBytes/1MB,1)}}, @{N="SentMB";E={[math]::Round($_.SentBytes/1MB,1)}} | Format-Table -AutoSize | Out-String');
    }
    default:
      return { success: false, output: "", error: "Unknown monitoring tool: " + toolId };
  }
}
