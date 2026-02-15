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

# -- Self-elevate to administrator (DotBot needs full PC control) --

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $argList = @("-ExecutionPolicy", "Bypass", "-NoExit", "-File", "`"$PSCommandPath`"")
    if ($Server) { $argList += "-Server" }
    if ($Agent)  { $argList += "-Agent" }
    if ($Update) { $argList += "-Update" }
    if ($Stop)   { $argList += "-Stop" }
    try {
        Start-Process powershell -Verb RunAs -ArgumentList $argList
    } catch {
        Write-Host "  [X] Administrator privileges required." -ForegroundColor Red
        Write-Host "      Right-click PowerShell -> 'Run as administrator', then try again." -ForegroundColor Gray
        exit 1
    }
    exit 0
}

# Resolve install root — $PSScriptRoot can be empty when launched via shortcut + UAC elevation
$Root = $PSScriptRoot
if (-not $Root -or -not (Test-Path (Join-Path $Root "package.json"))) {
    $candidates = @(
        $env:DOTBOT_INSTALL_DIR,
        "C:\Program Files\.bot",
        (Get-Location).Path
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path (Join-Path $c "package.json"))) {
            $Root = $c
            break
        }
    }
}

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
        if ($Server -or (-not $Agent -and (Test-Path "$Root\server\package.json"))) { $wsFlags += @("-w", "server") }
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
            if (Test-Path "$Root\local-agent\dist") { Remove-Item "$Root\local-agent\dist" -Recurse -Force -ErrorAction SilentlyContinue }
            Push-Location "$Root\local-agent"
            $out = npm run build 2>&1
            if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }; throw "local-agent/ build failed" }
            Pop-Location
            Write-Host "  [OK] local-agent/ built" -ForegroundColor Green
        }

        if ($Server) {
            if (Test-Path "$Root\server\dist") { Remove-Item "$Root\server\dist" -Recurse -Force -ErrorAction SilentlyContinue }
            Push-Location "$Root\server"
            $out = npm run build 2>&1
            if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }; throw "server/ build failed" }
            Pop-Location
            Write-Host "  [OK] server/ built" -ForegroundColor Green
        } elseif (-not $Agent -and (Test-Path "$Root\server\package.json")) {
            if (Test-Path "$Root\server\dist") { Remove-Item "$Root\server\dist" -Recurse -Force -ErrorAction SilentlyContinue }
            Push-Location "$Root\server"
            $out = npm run build 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  [!] server/ build failed (non-fatal on client machines)" -ForegroundColor Yellow
            } else {
                Write-Host "  [OK] server/ built" -ForegroundColor Green
            }
            Pop-Location
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
    if (-not $hasTsx -and -not $hasAgentDist) {
        Write-Host "  [X] Local agent not built. Run: npm run build -w shared -w local-agent" -ForegroundColor Red
        exit 1
    }

    # Restart loop: exit code 42 = intentional restart (system.update / system.restart)
    $restartCount = 0
    $maxRestarts = 10
    while ($true) {
        $startTime = Get-Date
        if ($hasTsx) {
            Set-Location "$Root\local-agent"
            npm run dev
        } else {
            Set-Location $Root
            node local-agent/dist/index.js
        }
        $exitCode = $LASTEXITCODE
        $runSeconds = ((Get-Date) - $startTime).TotalSeconds

        if ($exitCode -eq 42) {
            Write-Host "" -ForegroundColor Yellow
            Write-Host "  Restarting agent (update/restart signal)..." -ForegroundColor Yellow
            Write-Host "" -ForegroundColor Yellow
            $restartCount = 0
            Start-Sleep -Seconds 1
            continue
        }

        # If it ran for 5+ minutes, reset crash counter
        if ($runSeconds -gt 300) { $restartCount = 0 }

        $restartCount++
        if ($restartCount -ge $maxRestarts) {
            Write-Host "  [X] Agent crashed $maxRestarts times -- giving up" -ForegroundColor Red
            break
        }

        $backoff = [math]::Min(2 * $restartCount, 30)
        Write-Host "  Agent exited (code $exitCode). Restarting in ${backoff}s..." -ForegroundColor Yellow
        Start-Sleep -Seconds $backoff
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
        $deviceId = ""
        $deviceSecret = ""
        $deviceFile = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".bot\device.json"
        if (Test-Path $deviceFile) {
            try {
                $deviceData = Get-Content $deviceFile -Raw | ConvertFrom-Json
                $deviceId = $deviceData.deviceId
                $deviceSecret = $deviceData.secret
            } catch {
                Write-Host "  [!] Failed to read device.json" -ForegroundColor Yellow
            }
        }
        $queryParts = @()
        if ($serverWsUrl -and $serverWsUrl -ne "ws://localhost:3001") {
            $queryParts += "ws=$([Uri]::EscapeDataString($serverWsUrl))"
        }
        if ($deviceId -and $deviceSecret) {
            $queryParts += "deviceId=$([Uri]::EscapeDataString($deviceId))"
            $queryParts += "secret=$([Uri]::EscapeDataString($deviceSecret))"
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
