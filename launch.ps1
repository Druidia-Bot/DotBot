# DotBot Launcher
# Auto-detects installed components and starts them.
#
# Usage:
#   launch.ps1            — Interactive mode (Start Menu shortcut, visible window)
#   launch.ps1 -Service   — Background service mode (Task Scheduler, hidden, logs to file)

param([switch]$Service)

$Root = $PSScriptRoot
$BotDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".bot"

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -Force

# Detect what's installed
$hasAgent = Test-Path (Join-Path $Root "local-agent\dist\index.js")
$hasServer = Test-Path (Join-Path $Root "server\dist\index.js")

if (-not $hasAgent -and -not $hasServer) {
    if (-not $Service) {
        Write-Host "  ❌ No DotBot components found. Run the installer first." -ForegroundColor Red
        Read-Host "  Press Enter to exit"
    }
    exit 1
}

# ── Service mode: hidden, log to file, no browser ──

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
        Start-Process -FilePath "node" -ArgumentList "server/dist/index.js" `
            -WorkingDirectory $Root -NoNewWindow -PassThru `
            -RedirectStandardOutput $serverLog -RedirectStandardError (Join-Path $BotDir "server-error.log") | Out-Null
        Start-Sleep -Seconds 2
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
    exit $LASTEXITCODE
}

# ── Interactive mode: visible window, opens browser ──

$Host.UI.RawUI.WindowTitle = "DotBot"

Write-Host ""
Write-Host "  ╔═══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║             DotBot                     ║" -ForegroundColor Cyan
Write-Host "  ╚═══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Open browser client
$clientPath = Join-Path $Root "client\index.html"
if (Test-Path $clientPath) {
    Start-Process $clientPath
}

# Start server in a new window if both are installed
if ($hasServer -and $hasAgent) {
    Write-Host "  Starting server in new window..." -ForegroundColor Green
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-ExecutionPolicy", "Bypass", "-Command",
        "`$Host.UI.RawUI.WindowTitle = 'DotBot Server'; Set-Location '$Root'; node server/dist/index.js"
    )
    Start-Sleep -Seconds 2
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
