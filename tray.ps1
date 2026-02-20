<#
.SYNOPSIS
    DotBot System Tray — Invisible background launcher with tray icon.
.DESCRIPTION
    Launches DotBot as a hidden background service and provides a system tray
    icon with status info and a Shutdown option. No console windows are shown.

    This script is the intended entry point for the Start Menu shortcut and
    Task Scheduler. It replaces the old interactive-mode launch that opened
    visible PowerShell windows.

    Features:
      - Single-instance guard (mutex) — second launch shows balloon tip and exits
      - System tray icon with context menu: Status, Open UI, Shutdown
      - Balloon tip splash on startup ("DotBot is now running")
      - Starts run.ps1 -Service in a completely hidden process
      - Monitors the service process and updates tray icon on crash
      - Clean shutdown: kills service process tree on exit
#>

# ============================================
# SELF-ELEVATE TO ADMINISTRATOR
# ============================================

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
    try {
        Start-Process powershell -Verb RunAs -ArgumentList @(
            "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$scriptPath`""
        )
    } catch {
        # Silently fail — no console to write to
    }
    exit 0
}

# ============================================
# SINGLE-INSTANCE GUARD (named mutex)
# ============================================

$mutexName = "Global\DotBotTray_SingleInstance"
$createdNew = $false
try {
    $mutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$createdNew)
} catch {
    # Mutex creation failed (permissions, etc.) — fall through to the
    # process-kill section below which handles duplicates as a safety net.
    $mutex = $null
    $createdNew = $true
}

if (-not $createdNew) {
    # Another instance is already running — show a transient notification and exit
    Add-Type -AssemblyName System.Windows.Forms
    $tempIcon = [System.Windows.Forms.NotifyIcon]::new()
    $tempIcon.Icon = [System.Drawing.SystemIcons]::Information
    $tempIcon.Visible = $true
    $tempIcon.ShowBalloonTip(3000, "DotBot", "DotBot is already running.", [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Seconds 3
    $tempIcon.Visible = $false
    $tempIcon.Dispose()
    if ($mutex) { $mutex.Dispose() }
    exit 0
}

# ============================================
# SETUP — Paths, assemblies, hidden window
# ============================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# Refresh PATH — elevated sessions often have stale PATH
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

# Load ~/.bot/.env
$BotDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".bot"
$envFile = Join-Path $BotDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$' -and $_ -notmatch '^\s*#') {
            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"').Trim("'"), "Process")
        }
    }
}

# Resolve install root
$Root = $PSScriptRoot
if (-not $Root -or -not (Test-Path (Join-Path $Root "package.json"))) {
    foreach ($c in @($env:DOTBOT_INSTALL_DIR, 'C:\.bot', (Get-Location).Path)) {
        if ($c -and (Test-Path (Join-Path $c "package.json"))) { $Root = $c; break }
    }
}

$RunScript = Join-Path $Root "run.ps1"
$LauncherLog = Join-Path $BotDir "launcher.log"

# ============================================
# CREATE TRAY ICON
# ============================================

# Use a built-in Windows icon (green shield = running)
$trayIcon = [System.Windows.Forms.NotifyIcon]::new()
$trayIcon.Icon = [System.Drawing.SystemIcons]::Application
$trayIcon.Text = "DotBot — Starting..."
$trayIcon.Visible = $true

# Context menu
$contextMenu = [System.Windows.Forms.ContextMenuStrip]::new()

$statusItem = [System.Windows.Forms.ToolStripMenuItem]::new("Status: Starting...")
$statusItem.Enabled = $false
$contextMenu.Items.Add($statusItem) | Out-Null

$contextMenu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new()) | Out-Null

$openItem = [System.Windows.Forms.ToolStripMenuItem]::new("Open UI")
$openItem.Add_Click({
    $serverUrl = $env:DOTBOT_SERVER
    if (-not $serverUrl) { $serverUrl = "http://localhost:3001" }
    $browserUrl = $serverUrl -replace "^wss://", "https://" -replace "^ws://", "http://" -replace "/ws$", ""
    Start-Process $browserUrl
})
$contextMenu.Items.Add($openItem) | Out-Null

$logsItem = [System.Windows.Forms.ToolStripMenuItem]::new("View Logs")
$logsItem.Add_Click({
    if (Test-Path $LauncherLog) {
        Start-Process "notepad.exe" -ArgumentList $LauncherLog
    }
})
$contextMenu.Items.Add($logsItem) | Out-Null

$contextMenu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new()) | Out-Null

$shutdownItem = [System.Windows.Forms.ToolStripMenuItem]::new("Shutdown DotBot")
$shutdownItem.Add_Click({
    # Kill the service process tree
    if ($script:serviceProc -and -not $script:serviceProc.HasExited) {
        try {
            # Kill the process tree (node children)
            $script:serviceProc | Stop-Process -Force -ErrorAction SilentlyContinue
            # Also kill any remaining DotBot node processes
            Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
                try {
                    $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                    if (($_.Path -and $_.Path -match '[Dd]ot[Bb]ot|\.bot') -or ($cmdLine -and $cmdLine -match '[Dd]ot[Bb]ot|\.bot')) {
                        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                    }
                } catch {}
            }
        } catch {}
    }

    # Stop the scheduled task too (in case it would restart)
    try { Stop-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue } catch {}

    $trayIcon.Visible = $false
    $trayIcon.Dispose()
    if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
    [System.Windows.Forms.Application]::Exit()
})
$contextMenu.Items.Add($shutdownItem) | Out-Null

$trayIcon.ContextMenuStrip = $contextMenu

# Double-click tray icon → open UI
$trayIcon.Add_DoubleClick({
    $serverUrl = $env:DOTBOT_SERVER
    if (-not $serverUrl) { $serverUrl = "http://localhost:3001" }
    $browserUrl = $serverUrl -replace "^wss://", "https://" -replace "^ws://", "http://" -replace "/ws$", ""
    Start-Process $browserUrl
})

# ============================================
# STOP EXISTING INSTANCES
# ============================================

# Stop the scheduled task so two agents don't fight
try { Stop-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue } catch {}

# Kill any leftover DotBot node processes
Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
        if (($_.Path -and $_.Path -match '[Dd]ot[Bb]ot|\.bot') -or ($cmdLine -and $cmdLine -match '[Dd]ot[Bb]ot|\.bot')) {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}
Start-Sleep -Seconds 1

# ============================================
# START SERVICE (hidden)
# ============================================

$script:serviceProc = $null

if (Test-Path $RunScript) {
    $script:serviceProc = Start-Process powershell -ArgumentList @(
        "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $RunScript, "-Service"
    ) -WindowStyle Hidden -PassThru
}

if ($script:serviceProc) {
    $trayIcon.Text = "DotBot — Running (PID: $($script:serviceProc.Id))"
    $statusItem.Text = "Status: Running (PID: $($script:serviceProc.Id))"
    $trayIcon.ShowBalloonTip(4000, "DotBot", "DotBot is now running in the background.", [System.Windows.Forms.ToolTipIcon]::Info)
} else {
    $trayIcon.Text = "DotBot — Failed to start"
    $statusItem.Text = "Status: Failed to start"
    $trayIcon.Icon = [System.Drawing.SystemIcons]::Warning
    $trayIcon.ShowBalloonTip(5000, "DotBot", "Failed to start DotBot service. Check logs.", [System.Windows.Forms.ToolTipIcon]::Error)
}

# ============================================
# HEALTH CHECK TIMER — monitor service process
# ============================================

$healthTimer = [System.Windows.Forms.Timer]::new()
$healthTimer.Interval = 10000  # 10 seconds

$healthTimer.Add_Tick({
    if ($script:serviceProc -and $script:serviceProc.HasExited) {
        $exitCode = $script:serviceProc.ExitCode
        $trayIcon.Text = "DotBot — Stopped (exit code: $exitCode)"
        $statusItem.Text = "Status: Stopped (exit code: $exitCode)"
        $trayIcon.Icon = [System.Drawing.SystemIcons]::Warning
        $trayIcon.ShowBalloonTip(5000, "DotBot", "DotBot service stopped unexpectedly (exit code: $exitCode).", [System.Windows.Forms.ToolTipIcon]::Warning)
        $healthTimer.Stop()
    }
})

$healthTimer.Start()

# ============================================
# RUN MESSAGE LOOP (keeps tray icon alive)
# ============================================

# Application.Run blocks until Application.Exit() is called
[System.Windows.Forms.Application]::Run()

# ============================================
# CLEANUP
# ============================================

$healthTimer.Stop()
$healthTimer.Dispose()
$trayIcon.Visible = $false
$trayIcon.Dispose()
if ($mutex) {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
