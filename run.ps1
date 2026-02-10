<#
.SYNOPSIS
    DotBot Run Script
.DESCRIPTION
    Starts DotBot components. The single entry point for running DotBot locally.
.PARAMETER Server
    Only start the server
.PARAMETER Agent
    Only start the local agent
.PARAMETER Update
    Pull latest code and rebuild before running
.PARAMETER Stop
    Kill all running DotBot processes
#>

param(
    [switch]$Server,
    [switch]$Agent,
    [switch]$Update,
    [switch]$Stop
)

$Root = $PSScriptRoot

# ── Stop mode ──────────────────────────────────────────

if ($Stop) {
    Write-Host ""
    Write-Host "  Stopping DotBot..." -ForegroundColor Yellow
    # Kill by port
    $pids = @()
    foreach ($port in @(3000, 3001)) {
        $lines = netstat -aon 2>$null | Select-String ":$port\s.*LISTENING"
        foreach ($line in $lines) {
            if ($line -match '\s(\d+)\s*$') { $pids += $Matches[1] }
        }
    }
    # Kill by process name
    Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -match "dotbot" } |
        ForEach-Object { $pids += $_.Id }

    $pids = $pids | Sort-Object -Unique
    if ($pids.Count -gt 0) {
        foreach ($p in $pids) {
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
            Write-Host "  Killed PID $p" -ForegroundColor Gray
        }
        Write-Host "  ✅ DotBot stopped" -ForegroundColor Green
    } else {
        Write-Host "  No running DotBot processes found" -ForegroundColor Gray
    }
    Write-Host ""
    exit 0
}

# ── Banner ─────────────────────────────────────────────

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║              DotBot                                    ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Update mode ────────────────────────────────────────

if ($Update) {
    Write-Host "  Updating DotBot..." -ForegroundColor Yellow
    Write-Host ""

    Push-Location $Root
    try {
        git pull
        if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
        Write-Host "  ✅ Code updated" -ForegroundColor Green

        npm install --silent 2>$null
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        Write-Host "  ✅ Dependencies updated" -ForegroundColor Green

        Push-Location "$Root\shared"
        npm run build --silent 2>$null
        Pop-Location
        Write-Host "  ✅ shared/ built" -ForegroundColor Green

        if (-not $Server) {
            Push-Location "$Root\local-agent"
            npm run build --silent 2>$null
            Pop-Location
            Write-Host "  ✅ local-agent/ built" -ForegroundColor Green
        }

        if (-not $Agent) {
            Push-Location "$Root\server"
            npm run build --silent 2>$null
            Pop-Location
            Write-Host "  ✅ server/ built" -ForegroundColor Green
        }

        Write-Host ""
        Write-Host "  Update complete!" -ForegroundColor Green
        Write-Host ""
    } catch {
        Write-Host "  ❌ Update failed: $($_.Exception.Message)" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Pop-Location
}

# ── Check for API key ─────────────────────────────────

if (-not $env:ANTHROPIC_API_KEY -and -not $env:DEEPSEEK_API_KEY) {
    $envFile = Join-Path $Root ".env"
    if (-not (Test-Path $envFile)) {
        Write-Host "  ⚠️  No .env file found and no API keys in environment" -ForegroundColor Yellow
        Write-Host "     Copy .env.example to .env and add your keys" -ForegroundColor Gray
        Write-Host ""
    }
}

# ── Clean up existing instances ────────────────────────

foreach ($port in @(3000, 3001)) {
    $lines = netstat -aon 2>$null | Select-String ":$port\s.*LISTENING"
    foreach ($line in $lines) {
        if ($line -match '\s(\d+)\s*$') {
            Stop-Process -Id $Matches[1] -Force -ErrorAction SilentlyContinue
        }
    }
}
Start-Sleep -Milliseconds 500

# ── Run ────────────────────────────────────────────────

if ($Agent) {
    Write-Host "  Starting Local Agent..." -ForegroundColor Green
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""
    Set-Location "$Root\local-agent"
    npm run dev
}
elseif ($Server) {
    Write-Host "  Starting Server..." -ForegroundColor Green
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""
    Set-Location "$Root\server"
    npm run dev
}
else {
    # Run both — server in new window, agent in current, open client
    Write-Host "  Starting Server in new window..." -ForegroundColor Green
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-Command",
        "Set-Location '$Root\server'; Write-Host '  DotBot Server' -ForegroundColor Cyan; npm run dev"
    )

    Start-Sleep -Seconds 2

    # Open browser client
    $clientPath = Join-Path $Root "client\index.html"
    if (Test-Path $clientPath) {
        Write-Host "  Opening client in browser..." -ForegroundColor Green
        Start-Process $clientPath
    }

    Write-Host "  Starting Local Agent in this window..." -ForegroundColor Green
    Write-Host ""
    Write-Host "  ════════════════════════════════════════════════════" -ForegroundColor DarkGray
    Write-Host "    Press Ctrl+C to stop the agent" -ForegroundColor Gray
    Write-Host "    Run: .\run.ps1 -Stop  to kill everything" -ForegroundColor Gray
    Write-Host "  ════════════════════════════════════════════════════" -ForegroundColor DarkGray
    Write-Host ""

    Set-Location "$Root\local-agent"
    npm run dev
}
