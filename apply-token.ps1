# DotBot -- Apply New Invite Token
# Stops the agent, writes the token to .env, clears stale state, and relaunches hidden.

$ErrorActionPreference = "Stop"
$BotDir = Join-Path $env:USERPROFILE ".bot"
$EnvFile = Join-Path $BotDir ".env"
$InstallDir = "C:\.bot"

Write-Host ""
Write-Host "  DotBot -- Apply New Invite Token" -ForegroundColor Cyan
Write-Host "  ---------------------------------" -ForegroundColor DarkGray
Write-Host ""

# Prompt for token
$token = Read-Host "  Enter new invite token (e.g. dbot-XXXX-XXXX-XXXX-XXXX)"
if (-not $token) {
    Write-Host "  [X] No token entered. Exiting." -ForegroundColor Red
    exit 1
}

# Stop running DotBot agent (only DotBot processes, not all node)
Write-Host ""
Write-Host "  Stopping DotBot agent..." -ForegroundColor Gray
Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
        if (($_.Path -and $_.Path -match '[Dd]ot[Bb]ot|\.bot') -or ($cmdLine -and $cmdLine -match '[Dd]ot[Bb]ot|\.bot')) {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            Write-Host "  Killed PID $($_.Id)" -ForegroundColor Gray
        }
    } catch {}
}
Start-Sleep -Seconds 1

# Clear stale credentials so agent re-registers
Remove-Item (Join-Path $BotDir "device.json") -ErrorAction SilentlyContinue
Remove-Item (Join-Path $BotDir "web-auth-token") -ErrorAction SilentlyContinue

# Read existing server URL from .env (keep it)
$serverUrl = "ws://localhost:3001"
if (Test-Path $EnvFile) {
    $raw = Get-Content $EnvFile -Raw
    if ($raw -match 'DOTBOT_SERVER=(.+)') {
        $serverUrl = $Matches[1].Trim()
    }
}

# Write clean .env
$envContent = "DOTBOT_SERVER=$serverUrl`nDOTBOT_INVITE_TOKEN=$token`n"
[System.IO.File]::WriteAllText($EnvFile, $envContent, [System.Text.UTF8Encoding]::new($false))

Write-Host "  [OK] .env updated:" -ForegroundColor Green
Write-Host "    DOTBOT_SERVER=$serverUrl" -ForegroundColor White
Write-Host "    DOTBOT_INVITE_TOKEN=$token" -ForegroundColor White
Write-Host ""

# Launch agent hidden via run.ps1 -Service
$runPath = Join-Path $InstallDir "run.ps1"
if (-not (Test-Path $runPath)) {
    Write-Host "  [X] run.ps1 not found at $runPath" -ForegroundColor Red
    exit 1
}

Start-Process powershell -ArgumentList @(
    "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $runPath, "-Service"
)

# Wait for registration
$tokenFile = Join-Path $BotDir "web-auth-token"
Write-Host "  Waiting for agent to register..." -ForegroundColor Gray
Start-Sleep -Seconds 3  # Grace period for node to start via launch.ps1
$deadline = (Get-Date).AddSeconds(60)  # INSTALL-13: 60s timeout (was 20s)
$registered = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    if (Test-Path $tokenFile) {
        $registered = $true
        break
    }
    $procs = Get-Process -Name "node" -ErrorAction SilentlyContinue
    if (-not $procs) {
        Write-Host "  [X] Agent exited unexpectedly. Check log:" -ForegroundColor Red
        $logFile = Join-Path $BotDir "agent.log"
        if (Test-Path $logFile) {
            Get-Content $logFile -Tail 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        }
        Write-Host ""
        Read-Host "  Press Enter to exit"
        exit 1
    }
}

if ($registered) {
    Write-Host "  [OK] Agent registered successfully!" -ForegroundColor Green

    # Open browser with server URL + auth token
    $clientPath = Join-Path $InstallDir "client\index.html"
    if (Test-Path $clientPath) {
        $webAuthToken = (Get-Content $tokenFile -Raw).Trim()
        $queryParts = @()
        if ($serverUrl -and $serverUrl -ne "ws://localhost:3001") {
            $queryParts += "ws=$([Uri]::EscapeDataString($serverUrl))"
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
        Write-Host "  [OK] Browser opened" -ForegroundColor Green
    }
} else {
    Write-Host "  [!] Registration timed out. Agent may still be connecting." -ForegroundColor Yellow
    Write-Host "      Check: Get-Content ~\.bot\agent.log -Tail 20" -ForegroundColor Gray
}

Write-Host ""
Write-Host "  Done." -ForegroundColor Cyan
Write-Host ""
