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

# -- Stop mode ------------------------------------------

if ($Stop) {
    Write-Host ""
    Write-Host "  Stopping DotBot..." -ForegroundColor Yellow
    # Find DotBot node processes by command line or working directory
    $pids = @()
    Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
        $proc = $_
        try {
            # Match by executable path or command line containing dotbot/.bot
            $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
            if (($proc.Path -and $proc.Path -match '[Dd]ot[Bb]ot|\.bot') -or ($cmdLine -and $cmdLine -match '[Dd]ot[Bb]ot|\.bot')) {
                $pids += $proc.Id
            }
        } catch {}
    }

    $pids = $pids | Sort-Object -Unique
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

# -- Banner ---------------------------------------------

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "               DotBot                                   " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

# -- Update mode ----------------------------------------

if ($Update) {
    Write-Host "  Updating DotBot..." -ForegroundColor Yellow
    Write-Host ""

    Push-Location $Root
    try {
        git pull
        if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
        Write-Host "  [OK] Code updated" -ForegroundColor Green

        # Scope npm install to only workspaces we need (server may not be present on client-only machines)
        $wsFlags = @("-w", "shared")
        if (-not $Server) { $wsFlags += @("-w", "local-agent") }
        if (-not $Agent -and (Test-Path "$Root\server\package.json")) { $wsFlags += @("-w", "server") }
        $installArgs = @("install") + $wsFlags
        & npm @installArgs 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        Write-Host "  [OK] Dependencies updated" -ForegroundColor Green

        Push-Location "$Root\shared"
        $out = npm run build 2>&1
        if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }; throw "shared/ build failed" }
        Pop-Location
        Write-Host "  [OK] shared/ built" -ForegroundColor Green

        if (-not $Server) {
            Push-Location "$Root\local-agent"
            $out = npm run build 2>&1
            if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }; throw "local-agent/ build failed" }
            Pop-Location
            Write-Host "  [OK] local-agent/ built" -ForegroundColor Green
        }

        if (-not $Agent -and (Test-Path "$Root\server\package.json")) {
            Push-Location "$Root\server"
            $out = npm run build 2>&1
            if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }; throw "server/ build failed" }
            Pop-Location
            Write-Host "  [OK] server/ built" -ForegroundColor Green
        }

        Write-Host ""
        Write-Host "  Update complete!" -ForegroundColor Green
        Write-Host ""
    } catch {
        Write-Host "  [X] Update failed: $($_.Exception.Message)" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Pop-Location
}

# -- Check for API key ---------------------------------

if (-not $env:ANTHROPIC_API_KEY -and -not $env:DEEPSEEK_API_KEY) {
    $envFile = Join-Path $Root ".env"
    if (-not (Test-Path $envFile)) {
        Write-Host "  [!] No .env file found and no API keys in environment" -ForegroundColor Yellow
        Write-Host "     Copy .env.example to .env and add your keys" -ForegroundColor Gray
        Write-Host ""
    }
}

# -- Clean up existing instances ------------------------

foreach ($port in @(3000, 3001)) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.Name -eq "node") {
            $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
            if ($cmdLine -and $cmdLine -match '[Dd]ot[Bb]ot|\.bot') {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
Start-Sleep -Milliseconds 500

# -- Detect dev vs production --------------------------
# Dev mode: tsx available -> npm run dev (hot-reload from source)
# Production: no tsx -> node dist/index.js (built output)

$hasTsx = Test-Path (Join-Path $Root "node_modules\.bin\tsx.cmd")
$hasAgentDist = Test-Path (Join-Path $Root "local-agent\dist\index.js")
$hasServerDist = Test-Path (Join-Path $Root "server\dist\index.js")

function Start-Agent {
    if ($hasTsx) {
        Set-Location "$Root\local-agent"
        npm run dev
    } elseif ($hasAgentDist) {
        Set-Location $Root
        node local-agent/dist/index.js
    } else {
        Write-Host "  [X] Local agent not built. Run: npm run build -w shared -w local-agent" -ForegroundColor Red
        exit 1
    }
}

function Start-ServerInWindow {
    if ($hasTsx) {
        Start-Process powershell -ArgumentList @(
            "-NoExit", "-Command",
            "Set-Location '$Root\server'; Write-Host '  DotBot Server' -ForegroundColor Cyan; npm run dev"
        )
    } elseif ($hasServerDist) {
        Start-Process powershell -ArgumentList @(
            "-NoExit", "-Command",
            "Set-Location '$Root'; Write-Host '  DotBot Server' -ForegroundColor Cyan; node server/dist/index.js"
        )
    }
}

if (-not $hasTsx -and -not $hasAgentDist -and -not $hasServerDist) {
    Write-Host "  [X] DotBot is not built. Run the installer or build manually." -ForegroundColor Red
    exit 1
}

if (-not $hasTsx) {
    Write-Host "  Running in production mode (use launch.ps1 for background service)" -ForegroundColor DarkGray
    Write-Host ""
}

# -- Run ------------------------------------------------

if ($Agent) {
    Write-Host "  Starting Local Agent..." -ForegroundColor Green
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""
    Start-Agent
}
elseif ($Server) {
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
        Write-Host "  [X] Server not built. Run: npm run build -w shared -w server" -ForegroundColor Red
        exit 1
    }
}
else {
    # Run both -- server in new window, agent in current, open client
    if ($hasServerDist -or ($hasTsx -and (Test-Path "$Root\server"))) {
        Write-Host "  Starting Server in new window..." -ForegroundColor Green
        Start-ServerInWindow
        Start-Sleep -Seconds 2
    }

    # Open browser client with server URL pre-configured
    $clientPath = Join-Path $Root "client\index.html"
    if (Test-Path $clientPath) {
        Write-Host "  Opening client in browser..." -ForegroundColor Green
        $serverWsUrl = ""
        $envFile = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".bot\.env"
        if (Test-Path $envFile) {
            $envRaw = Get-Content $envFile -Raw
            if ($envRaw -match 'DOTBOT_SERVER=(.+)') {
                $serverWsUrl = $Matches[1].Trim()
            }
        }
        $webAuthToken = ""
        $tokenFile = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".bot\web-auth-token"
        if (Test-Path $tokenFile) {
            $webAuthToken = (Get-Content $tokenFile -Raw).Trim()
        }
        $queryParts = @()
        if ($serverWsUrl -and $serverWsUrl -ne "ws://localhost:3001") {
            $queryParts += "ws=$([Uri]::EscapeDataString($serverWsUrl))"
        }
        if ($webAuthToken) {
            $queryParts += "token=$([Uri]::EscapeDataString($webAuthToken))"
        }
        $fileUri = "file:///" + (($clientPath -replace '\\', '/') -replace ' ', '%20')
        if ($queryParts.Count -gt 0) {
            $qs = $queryParts -join "&"
            Start-Process "$fileUri#$qs"
        } else {
            Start-Process $fileUri
        }
    }

    Write-Host "  Starting Local Agent in this window..." -ForegroundColor Green
    Write-Host ""
    Write-Host "  ----------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "    Press Ctrl+C to stop the agent" -ForegroundColor Gray
    Write-Host "    Run: .\run.ps1 -Stop  to kill everything" -ForegroundColor Gray
    Write-Host "  ----------------------------------------------------" -ForegroundColor DarkGray
    Write-Host ""

    Start-Agent
}
