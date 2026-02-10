# DotBot Launcher
# Auto-detects installed components and starts them.
# Created by the DotBot installer — also usable from Start Menu shortcut.

$Root = $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "DotBot"

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -Force

Write-Host ""
Write-Host "  ╔═══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║             DotBot                     ║" -ForegroundColor Cyan
Write-Host "  ╚═══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Detect what's installed
$hasAgent = Test-Path (Join-Path $Root "local-agent\dist\index.js")
$hasServer = Test-Path (Join-Path $Root "server\dist\index.js")

if (-not $hasAgent -and -not $hasServer) {
    Write-Host "  ❌ No DotBot components found. Run the installer first." -ForegroundColor Red
    Write-Host ""
    Read-Host "  Press Enter to exit"
    exit 1
}

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
