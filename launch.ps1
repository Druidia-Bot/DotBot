# DotBot Launcher
# Auto-detects installed components and starts them.
#
# Usage:
#   launch.ps1            -- Interactive mode (Start Menu shortcut, visible window)
#   launch.ps1 -Service   -- Background service mode (Task Scheduler, hidden, logs to file)

param([switch]$Service)

$Root = $PSScriptRoot
$BotDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".bot"

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -Force

# Detect what's installed
# INSTALL-14: Load .env file into process environment
$envFile = Join-Path $BotDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$' -and $_ -notmatch '^\s*#') {
            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"').Trim("'"), "Process")
        }
    }
}

$hasAgent = Test-Path (Join-Path $Root "local-agent\dist\index.js")
$hasServer = Test-Path (Join-Path $Root "server\dist\index.js")

if (-not $hasAgent -and -not $hasServer) {
    if (-not $Service) {
        Write-Host "  [X] No DotBot components found. Run the installer first." -ForegroundColor Red
        Read-Host "  Press Enter to exit"
    }
    exit 1
}

# -- Service mode: hidden, log to file, no browser --

if ($Service) {
    if (-not (Test-Path $BotDir)) { New-Item -ItemType Directory -Path $BotDir -Force | Out-Null }
    $logFile = Join-Path $BotDir "agent.log"

    # Rotate log if > 10MB
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 10MB) {
        $rotated = Join-Path $BotDir "agent.log.1"
        Move-Item -Force $logFile $rotated
    }

    Set-Location $Root

    if ($hasServer -and $hasAgent) {
        $serverLog = Join-Path $BotDir "server.log"
        $serverProc = Start-Process -FilePath "node" -ArgumentList "server/dist/index.js" `
            -WorkingDirectory $Root -NoNewWindow -PassThru `
            -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $BotDir "server-error.log")
        Start-Sleep -Seconds 3
        # INSTALL-15: Verify server is still running before starting agent
        if ($serverProc.HasExited) {
            $errLog = Join-Path $BotDir "server-error.log"
            if (Test-Path $errLog) { Get-Content $errLog -Tail 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
            Write-Host "  [X] Server exited immediately (code $($serverProc.ExitCode)). Check $serverLog" -ForegroundColor Red
            exit 1
        }
    }

    if ($hasAgent) {
        $proc = Start-Process -FilePath "node" -ArgumentList "local-agent/dist/index.js" `
            -WorkingDirectory $Root -NoNewWindow -PassThru `
            -RedirectStandardOutput $logFile -RedirectStandardError (Join-Path $BotDir "agent-error.log")
        $proc.WaitForExit()
    } elseif ($hasServer) {
        $proc = Start-Process -FilePath "node" -ArgumentList "server/dist/index.js" `
            -WorkingDirectory $Root -NoNewWindow -PassThru `
            -RedirectStandardOutput $logFile -RedirectStandardError (Join-Path $BotDir "server-error.log")
        $proc.WaitForExit()
    }
    exit $proc.ExitCode
}

# -- Interactive mode: visible window --

# Stop the background scheduled task so two agents don't fight over the same device connection
try { Stop-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue } catch {}
# Kill any leftover node processes from the service
try { Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 1

$Host.UI.RawUI.WindowTitle = "DotBot"

Write-Host ""
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host "               DotBot                      " -ForegroundColor Cyan
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host ""

# Start server in a new window if both are installed
if ($hasServer -and $hasAgent) {
    Write-Host "  Starting server in new window..." -ForegroundColor Green
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-ExecutionPolicy", "RemoteSigned", "-Command",
        "`$Host.UI.RawUI.WindowTitle = 'DotBot Server'; Set-Location '$Root'; node server/dist/index.js"
    )
    Start-Sleep -Seconds 3
}

# Start the primary component in this window
if ($hasAgent) {
    $Host.UI.RawUI.WindowTitle = "DotBot Agent"
    Write-Host "  DotBot Local Agent" -ForegroundColor Cyan
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""
    Set-Location $Root
    node local-agent/dist/index.js
} elseif ($hasServer) {
    $Host.UI.RawUI.WindowTitle = "DotBot Server"
    Write-Host "  DotBot Server" -ForegroundColor Cyan
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""
    Set-Location $Root
    node server/dist/index.js
}
