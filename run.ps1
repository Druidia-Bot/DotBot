<#
.SYNOPSIS
    DotBot Run Script
.DESCRIPTION
    Starts the DotBot server and local agent with visible debug output.
.PARAMETER ServerOnly
    Only start the server
.PARAMETER AgentOnly
    Only start the local agent
#>

param(
    [switch]$ServerOnly,
    [switch]$AgentOnly
)

$Root = $PSScriptRoot

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║              DotBot Debug Runner                      ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Check for API key
if (-not $env:ANTHROPIC_API_KEY -and -not $env:DEEPSEEK_API_KEY) {
    Write-Host "⚠️  Warning: No ANTHROPIC_API_KEY or DEEPSEEK_API_KEY set" -ForegroundColor Yellow
    Write-Host "   Set one of these environment variables for LLM functionality" -ForegroundColor Gray
    Write-Host ""
}

if ($AgentOnly) {
    # Run just the local agent in current window
    Write-Host "Starting Local Agent (debug mode)..." -ForegroundColor Green
    Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""
    Set-Location "$Root\local-agent"
    npm run dev
}
elseif ($ServerOnly) {
    # Run just the server in current window
    Write-Host "Starting Server (debug mode)..." -ForegroundColor Green
    Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""
    Set-Location "$Root\server"
    npm run dev
}
else {
    # Run both - server in new window, agent in current
    Write-Host "Starting Server in new window..." -ForegroundColor Green
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-Command",
        "Set-Location '$Root\server'; Write-Host '🌐 DotBot Server' -ForegroundColor Cyan; npm run dev"
    )
    
    Write-Host "Starting Local Agent in this window..." -ForegroundColor Green
    Write-Host ""
    Write-Host "════════════════════════════════════════════════════════" -ForegroundColor DarkGray
    Write-Host "  Press Ctrl+C to stop the agent" -ForegroundColor Gray
    Write-Host "  Close the server window separately" -ForegroundColor Gray
    Write-Host "════════════════════════════════════════════════════════" -ForegroundColor DarkGray
    Write-Host ""
    
    # Small delay to let server start first
    Start-Sleep -Seconds 2
    
    Set-Location "$Root\local-agent"
    npm run dev
}
