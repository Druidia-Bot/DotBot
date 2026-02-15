# ============================================================
# DotBot Local Agent -- Launcher with Self-Update Support
# ============================================================
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File launcher.ps1
#
# What this does:
#   - Starts the local agent (node dist/index.js)
#   - Watches for a self-update staging marker
#   - On update: stops agent, backs up dist, promotes staged build, restarts
#   - On startup failure: rolls back to backup automatically
#   - Logs everything to ~/.bot/launcher.log
#
# Self-update flow:
#   1. DotBot compiles changes in ~/.bot/workspace/dotbot/local-agent/
#   2. DotBot writes staged build to ~/.bot/workspace/staged-dist/
#   3. DotBot creates marker file ~/.bot/workspace/update-pending
#   4. This launcher detects the marker, applies the update, restarts
#
# ============================================================

# -- Self-elevate to administrator (DotBot needs full PC control) --

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
    try {
        Start-Process powershell -Verb RunAs -ArgumentList @(
            "-ExecutionPolicy", "Bypass", "-File", "`"$scriptPath`""
        )
    } catch {
        Write-Host "  [X] Administrator privileges required for DotBot launcher." -ForegroundColor Red
        exit 1
    }
    exit 0
}

$ErrorActionPreference = "Stop"

# --- Paths ---
$BotDir = Join-Path $env:USERPROFILE ".bot"
$WorkspaceDir = Join-Path $BotDir "workspace"
$StagedDistDir = Join-Path $WorkspaceDir "staged-dist"
$UpdateMarker = Join-Path $WorkspaceDir "update-pending"
$BackupDistDir = Join-Path $WorkspaceDir "dist-backup"
$RollbackMarker = Join-Path $WorkspaceDir "rollback-pending"
$LauncherLog = Join-Path $BotDir "launcher.log"

# Resolve agent root -- look for package.json with name "dotbot-local"
# Try: script's grandparent, or CWD
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Get-Location }
$AgentRoot = Split-Path $ScriptDir -Parent
if (-not (Test-Path (Join-Path $AgentRoot "package.json"))) {
    $AgentRoot = Get-Location
}
$AgentDist = Join-Path $AgentRoot "dist"
$AgentEntry = Join-Path $AgentDist "index.js"

# --- Logging ---
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] [$Level] $Message"
    Write-Host $line
    Add-Content -Path $LauncherLog -Value $line -ErrorAction SilentlyContinue
}

# --- Ensure directories ---
New-Item -ItemType Directory -Path $WorkspaceDir -Force | Out-Null

# --- Log rotation (10MB limit, keep one backup) ---
$MaxLogSizeMB = 10
if (Test-Path $LauncherLog) {
    $logSize = (Get-Item $LauncherLog).Length / 1MB
    if ($logSize -gt $MaxLogSizeMB) {
        $backupLog = "$LauncherLog.1"
        if (Test-Path $backupLog) { Remove-Item -Force $backupLog }
        Move-Item -Force $LauncherLog $backupLog
        Write-Log "Log rotated (was $([math]::Round($logSize, 1))MB)"
    }
}

# --- Startup check ---
if (-not (Test-Path $AgentEntry)) {
    Write-Log "Agent entry point not found at $AgentEntry" "ERROR"
    Write-Log "Run 'npm run build' in the local-agent directory first." "ERROR"
    exit 1
}

# --- Main loop ---
$MaxRestarts = 10
$RestartCount = 0
$RestartWindow = 300  # Reset counter after 5 minutes of stable running
$Running = $true

Write-Log "=== DotBot Launcher Started ==="
Write-Log "Agent root: $AgentRoot"
Write-Log "Agent entry: $AgentEntry"

while ($Running) {
    # --- Check for pending update BEFORE starting ---
    if (Test-Path $UpdateMarker) {
        Write-Log "Update marker detected -- applying staged update..."

        if (Test-Path $StagedDistDir) {
            # Backup current dist
            if (Test-Path $BackupDistDir) {
                Remove-Item -Recurse -Force $BackupDistDir
            }
            if (Test-Path $AgentDist) {
                Copy-Item -Recurse -Force $AgentDist $BackupDistDir
                Write-Log "Backed up current dist to $BackupDistDir"
            }

            # Promote staged dist
            if (Test-Path $AgentDist) {
                Remove-Item -Recurse -Force $AgentDist
            }
            Copy-Item -Recurse -Force $StagedDistDir $AgentDist
            Write-Log "Promoted staged dist to $AgentDist"

            # Clean up
            Remove-Item -Force $UpdateMarker
            Remove-Item -Recurse -Force $StagedDistDir
            Write-Log "Update applied successfully"
        }
        else {
            Write-Log "Update marker found but no staged-dist directory -- ignoring" "WARN"
            Remove-Item -Force $UpdateMarker
        }
    }

    # --- Check for rollback ---
    if (Test-Path $RollbackMarker) {
        Write-Log "Rollback marker detected -- restoring backup..."
        if (Test-Path $BackupDistDir) {
            if (Test-Path $AgentDist) {
                Remove-Item -Recurse -Force $AgentDist
            }
            Copy-Item -Recurse -Force $BackupDistDir $AgentDist
            Remove-Item -Force $RollbackMarker
            Write-Log "Rollback complete -- restored from backup"
        }
        else {
            Write-Log "Rollback requested but no backup found!" "ERROR"
            Remove-Item -Force $RollbackMarker
        }
    }

    # --- Start the agent ---
    Write-Log "Starting local agent (attempt $($RestartCount + 1))..."
    $StartTime = Get-Date

    try {
        $process = Start-Process -FilePath "node" -ArgumentList $AgentEntry `
            -WorkingDirectory $AgentRoot -NoNewWindow -PassThru

        Write-Log "Agent started (PID: $($process.Id))"

        # Wait for process to exit
        $process.WaitForExit()
        $ExitCode = $process.ExitCode
        $RunDuration = (Get-Date) - $StartTime

        Write-Log "Agent exited with code $ExitCode after $([math]::Round($RunDuration.TotalSeconds))s"
    }
    catch {
        Write-Log "Failed to start agent: $_" "ERROR"
        $ExitCode = 1
        $RunDuration = New-TimeSpan -Seconds 0
    }

    # --- Decide what to do ---

    # Exit code 42 = intentional restart request (from system.restart tool)
    if ($ExitCode -eq 42) {
        Write-Log "Intentional restart requested (exit code 42) -- restarting immediately..."
        continue
    }

    # If it ran long enough, reset the restart counter
    if ($RunDuration.TotalSeconds -gt $RestartWindow) {
        $RestartCount = 0
    }

    # If an update is pending, don't count this as a crash
    if (Test-Path $UpdateMarker) {
        Write-Log "Update pending -- restarting to apply..."
        continue
    }

    # If it crashed immediately after an update, rollback
    if ($RunDuration.TotalSeconds -lt 10 -and (Test-Path $BackupDistDir)) {
        Write-Log "Agent crashed within 10s -- auto-rolling back to previous version" "WARN"
        if (Test-Path $AgentDist) {
            Remove-Item -Recurse -Force $AgentDist
        }
        Copy-Item -Recurse -Force $BackupDistDir $AgentDist
        Write-Log "Auto-rollback complete"
        # Don't count this crash against restart limit -- it's a known recovery
        continue
    }

    # Normal restart with backoff
    $RestartCount++
    if ($RestartCount -ge $MaxRestarts) {
        Write-Log "Max restarts ($MaxRestarts) reached -- giving up" "ERROR"
        $Running = $false
        break
    }

    $BackoffSeconds = [math]::Min(2 * $RestartCount, 30)
    Write-Log "Restarting in ${BackoffSeconds}s..."
    Start-Sleep -Seconds $BackoffSeconds
}

Write-Log "=== DotBot Launcher Stopped ==="
