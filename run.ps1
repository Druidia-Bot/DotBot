<#
.SYNOPSIS
    DotBot — Single entry point for running, updating, and managing DotBot.
.DESCRIPTION
    One script does everything. Replaces launch.ps1, launcher.ps1, and dotbot.ps1.

    .\run.ps1                  Start agent (+ server if present), interactive
    .\run.ps1 -Service         Background service mode (Task Scheduler)
    .\run.ps1 -Agent           Start only the local agent
    .\run.ps1 -Server          Start only the server
    .\run.ps1 -Update          Pull latest + rebuild + restart
    .\run.ps1 -Stop            Kill all DotBot processes
    .\run.ps1 -Status          Show what's running
    .\run.ps1 -Open            Open the browser UI
    .\run.ps1 -Logs            Tail the agent log
#>

param(
    [switch]$Server,
    [switch]$Agent,
    [switch]$Update,
    [switch]$Stop,
    [switch]$Service,
    [switch]$Status,
    [switch]$Open,
    [switch]$Logs
)

# ============================================
# BOOTSTRAP — elevation, PATH, root resolution
# ============================================

# Status, Open, and Logs don't need admin
$needsAdmin = -not ($Status -or $Open -or $Logs)

if ($needsAdmin -and -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $argList = @("-ExecutionPolicy", "Bypass")
    if (-not $Service) { $argList += "-NoExit" }
    $argList += @("-File", "`"$PSCommandPath`"")
    if ($Server)  { $argList += "-Server" }
    if ($Agent)   { $argList += "-Agent" }
    if ($Update)  { $argList += "-Update" }
    if ($Stop)    { $argList += "-Stop" }
    if ($Service) { $argList += "-Service" }
    try {
        Start-Process powershell -Verb RunAs -ArgumentList $argList
    } catch {
        Write-Host "  [X] Administrator privileges required." -ForegroundColor Red
        exit 1
    }
    exit 0
}

# Refresh PATH — elevated sessions often have stale PATH missing node/git
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

# Load ~/.bot/.env into process environment
$BotDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".bot"
$_envFile = Join-Path $BotDir ".env"
if (Test-Path $_envFile) {
    Get-Content $_envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$' -and $_ -notmatch '^\s*#') {
            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"').Trim("'"), "Process")
        }
    }
}

# Resolve install root — $PSScriptRoot can be empty when launched via shortcut + UAC
$Root = $PSScriptRoot
if (-not $Root -or -not (Test-Path (Join-Path $Root "package.json"))) {
    foreach ($c in @($env:DOTBOT_INSTALL_DIR, "C:\.bot", (Get-Location).Path)) {
        if ($c -and (Test-Path (Join-Path $c "package.json"))) { $Root = $c; break }
    }
}

# Migrate from old install location (C:\Program Files\.bot → C:\.bot)
$OldInstallDir = Join-Path $env:ProgramFiles ".bot"
if ((Test-Path (Join-Path $OldInstallDir "package.json")) -and -not (Test-Path (Join-Path "C:\.bot" "package.json"))) {
    Write-Host "  Migrating install from '$OldInstallDir' to 'C:\.bot'..." -ForegroundColor Yellow
    try {
        # Stop any running DotBot processes first
        Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                if ($cmdLine -and $cmdLine -match '[Dd]ot[Bb]ot|\.bot') {
                    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                }
            } catch {}
        }
        Start-Sleep -Seconds 1

        # Move the directory
        Move-Item -Path $OldInstallDir -Destination "C:\.bot" -Force
        $Root = "C:\.bot"

        # Update scheduled task if it exists
        try {
            $task = Get-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue
            if ($task) {
                $runPath = Join-Path "C:\.bot" "run.ps1"
                $Action = New-ScheduledTaskAction -Execute "powershell.exe" `
                    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runPath`" -Service" `
                    -WorkingDirectory "C:\.bot"
                Set-ScheduledTask -TaskName "DotBot" -Action $Action | Out-Null
                Write-Host "  [OK] Updated scheduled task to new location" -ForegroundColor Green
            }
        } catch { Write-Host "  [!] Could not update scheduled task" -ForegroundColor Yellow }

        # Update Start Menu shortcut
        try {
            $lnkPath = Join-Path ([Environment]::GetFolderPath("Programs")) "DotBot.lnk"
            if (Test-Path $lnkPath) {
                $shell = New-Object -ComObject WScript.Shell
                $shortcut = $shell.CreateShortcut($lnkPath)
                $shortcut.Arguments = "-ExecutionPolicy Bypass -NoExit -File `"$(Join-Path 'C:\.bot' 'run.ps1')`""
                $shortcut.WorkingDirectory = "C:\.bot"
                $shortcut.Save()
            }
        } catch {}

        Write-Host "  [OK] Migrated to C:\.bot" -ForegroundColor Green
    } catch {
        Write-Host "  [X] Migration failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "      DotBot will continue from the old location." -ForegroundColor Gray
        $Root = $OldInstallDir
    }
}

$LauncherLog = Join-Path $BotDir "launcher.log"

# ============================================
# HELPERS
# ============================================

function Find-DotBotPids {
    $pids = @()
    Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
            if (($_.Path -and $_.Path -match '[Dd]ot[Bb]ot|\.bot') -or ($cmdLine -and $cmdLine -match '[Dd]ot[Bb]ot|\.bot')) {
                $pids += $_.Id
            }
        } catch {}
    }
    return ($pids | Sort-Object -Unique)
}

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] [$Level] $Message"
    if (-not $Service) { Write-Host $line }
    Add-Content -Path $LauncherLog -Value $line -ErrorAction SilentlyContinue
}

# ============================================
# COMMAND: -Stop
# ============================================

if ($Stop) {
    Write-Host ""
    Write-Host "  Stopping DotBot..." -ForegroundColor Yellow
    $pids = Find-DotBotPids
    if ($pids.Count -gt 0) {
        foreach ($p in $pids) {
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
            Write-Host "  Killed PID $p" -ForegroundColor Gray
        }
        Write-Host "  [OK] DotBot stopped" -ForegroundColor Green
    } else {
        Write-Host "  No running DotBot processes found" -ForegroundColor Gray
    }
    Write-Host ""
    exit 0
}

# ============================================
# COMMAND: -Status
# ============================================

if ($Status) {
    Write-Host ""
    Write-Host "=== DotBot Status ===" -ForegroundColor Cyan

    # Scheduled task
    $task = Get-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue
    if ($task) {
        Write-Host "Service:  $($task.State)" -ForegroundColor $(if ($task.State -eq "Running") { "Green" } else { "Yellow" })
    } else {
        Write-Host "Service:  Not registered" -ForegroundColor Red
    }

    # Agent process
    $pids = Find-DotBotPids
    if ($pids.Count -gt 0) {
        Write-Host "Agent:    Running (PID $($pids -join ', '))" -ForegroundColor Green
    } else {
        Write-Host "Agent:    Not running" -ForegroundColor Yellow
    }

    Write-Host "Install:  $Root" -ForegroundColor Gray
    Write-Host "Data:     $BotDir" -ForegroundColor Gray

    if (Test-Path $LauncherLog) {
        $lastLine = Get-Content $LauncherLog -Tail 1
        Write-Host "Last log: $lastLine" -ForegroundColor DarkGray
    }
    Write-Host ""
    exit 0
}

# ============================================
# COMMAND: -Open
# ============================================

if ($Open) {
    $serverUrl = $env:DOTBOT_SERVER
    if (-not $serverUrl) { $serverUrl = "http://localhost:3001" }
    $browserUrl = $serverUrl -replace "^wss://", "https://" -replace "^ws://", "http://" -replace "/ws$", ""
    Write-Host "  Opening DotBot UI at $browserUrl ..." -ForegroundColor Green
    Start-Process $browserUrl
    exit 0
}

# ============================================
# COMMAND: -Logs
# ============================================

if ($Logs) {
    if (Test-Path $LauncherLog) {
        Write-Host "=== DotBot Logs (Ctrl+C to stop) ===" -ForegroundColor Cyan
        Get-Content $LauncherLog -Tail 50 -Wait
    } else {
        Write-Host "  No log file found at $LauncherLog" -ForegroundColor Yellow
    }
    exit 0
}

# ============================================
# COMMAND: -Update
# ============================================

if ($Update) {
    Write-Host ""
    Write-Host "  Updating DotBot..." -ForegroundColor Yellow
    Write-Host ""

    Push-Location $Root
    try {
        $out = & cmd /c "git pull 2>&1"
        if ($LASTEXITCODE -ne 0) { Write-Host "    $out" -ForegroundColor DarkGray; throw "git pull failed" }
        Write-Host "  [OK] Code updated" -ForegroundColor Green

        Write-Host "  Installing dependencies..." -ForegroundColor Gray
        $out = & cmd /c "npm install 2>&1"
        if ($LASTEXITCODE -ne 0) { Write-Host "    $out" -ForegroundColor DarkGray; throw "npm install failed" }
        Write-Host "  [OK] Dependencies installed" -ForegroundColor Green

        Write-Host "  Building shared..." -ForegroundColor Gray
        $out = & cmd /c "npm run build -w shared 2>&1"
        if ($LASTEXITCODE -ne 0) { Write-Host "    $out" -ForegroundColor DarkGray; throw "shared/ build failed" }
        Write-Host "  [OK] shared/ built" -ForegroundColor Green

        Write-Host "  Building local-agent..." -ForegroundColor Gray
        $out = & cmd /c "npm run build -w local-agent 2>&1"
        if ($LASTEXITCODE -ne 0) { Write-Host "    $out" -ForegroundColor DarkGray; throw "local-agent/ build failed" }
        Write-Host "  [OK] local-agent/ built" -ForegroundColor Green

        if (Test-Path "$Root\server\package.json") {
            Write-Host "  Building server..." -ForegroundColor Gray
            $out = & cmd /c "npm run build -w server 2>&1"
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  [!] server/ build failed (non-fatal on client machines)" -ForegroundColor Yellow
            } else {
                Write-Host "  [OK] server/ built" -ForegroundColor Green
            }
        }

        # Update the CLI copy in ~/.bot/
        $cliSource = Join-Path $Root "local-agent\scripts\dotbot.ps1"
        $cliDest = Join-Path $BotDir "dotbot.ps1"
        if (Test-Path $cliSource) { Copy-Item -Force $cliSource $cliDest -ErrorAction SilentlyContinue }

        Write-Host ""
        Write-Host "  [OK] Update complete!" -ForegroundColor Green
        Write-Host ""
    } catch {
        Write-Host "  [X] Update failed: $($_.Exception.Message)" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Pop-Location

    # If not also starting, exit
    if (-not $Agent -and -not $Server -and -not $Service) { exit 0 }
}

# ============================================
# DETECT DEV VS PRODUCTION
# ============================================

$hasTsx = Test-Path (Join-Path $Root "node_modules\.bin\tsx.cmd")
$hasAgentDist = Test-Path (Join-Path $Root "local-agent\dist\index.js")
$hasServerDist = Test-Path (Join-Path $Root "server\dist\index.js")

if (-not $hasTsx -and -not $hasAgentDist -and -not $hasServerDist) {
    Write-Host "  [X] DotBot is not built. Run the installer or: npm run build -w shared -w local-agent" -ForegroundColor Red
    exit 1
}

# ============================================
# AGENT RESTART LOOP
# ============================================

function Start-AgentLoop {
    if (-not $hasTsx -and -not $hasAgentDist) {
        Write-Host "  [X] Local agent not built. Run: npm run build -w shared -w local-agent" -ForegroundColor Red
        exit 1
    }

    $restartCount = 0
    $maxRestarts = 10

    while ($true) {
        $startTime = Get-Date
        Write-Log "Starting local agent (attempt $($restartCount + 1))..."

        if ($hasTsx) {
            Set-Location "$Root\local-agent"
            npm run dev
        } else {
            Set-Location $Root
            node local-agent/dist/index.js
        }

        $exitCode = $LASTEXITCODE
        $runSeconds = ((Get-Date) - $startTime).TotalSeconds
        Write-Log "Agent exited with code $exitCode after $([math]::Round($runSeconds))s"

        # Exit code 42 = intentional restart (system.update / system.restart)
        if ($exitCode -eq 42) {
            Write-Log "Intentional restart requested (exit code 42)"
            if (-not $Service) { Write-Host "  Restarting agent..." -ForegroundColor Yellow }
            $restartCount = 0
            Start-Sleep -Seconds 1
            continue
        }

        # Stable for 5+ minutes → reset crash counter
        if ($runSeconds -gt 300) { $restartCount = 0 }

        $restartCount++
        if ($restartCount -ge $maxRestarts) {
            Write-Log "Max restarts ($maxRestarts) reached — giving up" "ERROR"
            if (-not $Service) { Write-Host "  [X] Agent crashed $maxRestarts times — giving up" -ForegroundColor Red }
            break
        }

        $backoff = [math]::Min(2 * $restartCount, 30)
        Write-Log "Restarting in ${backoff}s..."
        if (-not $Service) { Write-Host "  Agent exited (code $exitCode). Restarting in ${backoff}s..." -ForegroundColor Yellow }
        Start-Sleep -Seconds $backoff
    }
}

# ============================================
# COMMAND: -Service (background mode for Task Scheduler)
# ============================================

if ($Service) {
    # Log rotation (10MB limit)
    if ((Test-Path $LauncherLog) -and (Get-Item $LauncherLog).Length -gt 10MB) {
        $backup = "$LauncherLog.1"
        if (Test-Path $backup) { Remove-Item -Force $backup }
        Move-Item -Force $LauncherLog $backup
    }

    Write-Log "=== DotBot Service Started ==="
    Write-Log "Install root: $Root"

    # Start server in background if present
    if ($hasServerDist) {
        $serverLog = Join-Path $BotDir "server.log"
        $serverProc = Start-Process -FilePath "node" -ArgumentList "server/dist/index.js" `
            -WorkingDirectory $Root -NoNewWindow -PassThru `
            -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $BotDir "server-error.log")
        Start-Sleep -Seconds 3
        if ($serverProc.HasExited) {
            Write-Log "Server exited immediately (code $($serverProc.ExitCode))" "ERROR"
        } else {
            Write-Log "Server started (PID: $($serverProc.Id))"
        }
    }

    # Run agent in restart loop (blocks)
    Start-AgentLoop
    Write-Log "=== DotBot Service Stopped ==="
    exit 0
}

# ============================================
# INTERACTIVE MODE
# ============================================

# Stop the background scheduled task so two agents don't fight
try { Stop-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue } catch {}
# Kill any leftover node processes from the service
$pids = Find-DotBotPids
foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
if ($pids.Count -gt 0) { Start-Sleep -Seconds 1 }

$Host.UI.RawUI.WindowTitle = "DotBot"

Write-Host ""
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host "               DotBot                      " -ForegroundColor Cyan
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host ""

if ($Agent) {
    $Host.UI.RawUI.WindowTitle = "DotBot Agent"
    Write-Host "  Starting Local Agent..." -ForegroundColor Green
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""
    Start-AgentLoop
}
elseif ($Server) {
    $Host.UI.RawUI.WindowTitle = "DotBot Server"
    Write-Host "  Starting Server..." -ForegroundColor Green
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""
    if ($hasTsx) {
        Set-Location "$Root\server"
        npm run dev
    } elseif ($hasServerDist) {
        Set-Location $Root
        node server/dist/index.js
    } else {
        Write-Host "  [X] Server not built." -ForegroundColor Red
        exit 1
    }
}
else {
    # Start server in new window if present
    if ($hasServerDist -or ($hasTsx -and (Test-Path "$Root\server"))) {
        Write-Host "  Starting Server in new window..." -ForegroundColor Green
        if ($hasTsx) {
            Start-Process powershell -ArgumentList @(
                "-NoExit", "-Command",
                "Set-Location '$Root\server'; `$Host.UI.RawUI.WindowTitle = 'DotBot Server'; npm run dev"
            )
        } else {
            Start-Process powershell -ArgumentList @(
                "-NoExit", "-Command",
                "Set-Location '$Root'; `$Host.UI.RawUI.WindowTitle = 'DotBot Server'; node server/dist/index.js"
            )
        }
        Start-Sleep -Seconds 2
    }

    $Host.UI.RawUI.WindowTitle = "DotBot Agent"
    Write-Host "  Starting Local Agent..." -ForegroundColor Green
    Write-Host ""
    Write-Host "  -----------------------------------------------" -ForegroundColor DarkGray
    Write-Host "    Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host "    Run: .\run.ps1 -Stop   to kill everything" -ForegroundColor Gray
    Write-Host "    Run: .\run.ps1 -Status to check status" -ForegroundColor Gray
    Write-Host "  -----------------------------------------------" -ForegroundColor DarkGray
    Write-Host ""

    Start-AgentLoop
}
