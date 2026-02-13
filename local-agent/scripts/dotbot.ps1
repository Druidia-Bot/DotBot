# ============================================================
# DotBot CLI -- Quick commands from the terminal
# ============================================================
#
# Usage:
#   dotbot open       -- Open the browser UI
#   dotbot status     -- Show agent and service status
#   dotbot update     -- Pull latest and rebuild
#   dotbot start      -- Start the DotBot service
#   dotbot stop       -- Stop the DotBot service
#   dotbot restart    -- Restart the DotBot service
#   dotbot logs       -- Tail the launcher log
#   dotbot help       -- Show this help
#
# Install:
#   Copy this to a directory in your PATH, or run:
#   Copy-Item dotbot.ps1 "$env:USERPROFILE\.bot\dotbot.ps1"
#   Then add ~/.bot to your PATH.
# ============================================================

param(
    [Parameter(Position = 0)]
    [string]$Command = "help"
)

$BotDir = Join-Path $env:USERPROFILE ".bot"
$LauncherLog = Join-Path $BotDir "launcher.log"
$InstallDir = if ($env:DOTBOT_INSTALL_DIR) { $env:DOTBOT_INSTALL_DIR } else { "C:\Program Files\.bot" }
$TaskName = "DotBot"

# Refresh PATH from registry -- elevated/new sessions may not have tools installed by winget
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

switch ($Command.ToLower()) {
    "open" {
        $serverUrl = $env:DOTBOT_SERVER
        if (-not $serverUrl) {
            $envFile = Join-Path $BotDir ".env"
            if (Test-Path $envFile) {
                $match = Select-String -Path $envFile -Pattern "DOTBOT_SERVER=(.+)" | Select-Object -First 1
                if ($match) { $serverUrl = $match.Matches[0].Groups[1].Value.Trim() }
            }
        }
        if (-not $serverUrl) { $serverUrl = "http://localhost:3001" }
        # Convert ws/wss to http/https for the browser
        $browserUrl = $serverUrl -replace "^wss://", "https://" -replace "^ws://", "http://" -replace "/ws$", ""
        Write-Host "Opening DotBot UI at $browserUrl ..."
        Start-Process $browserUrl
    }
    "status" {
        Write-Host "=== DotBot Status ===" -ForegroundColor Cyan

        # Check scheduled task
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            Write-Host "Service:  $($task.State)" -ForegroundColor $(if ($task.State -eq "Running") { "Green" } else { "Yellow" })
        } else {
            Write-Host "Service:  Not registered" -ForegroundColor Red
        }

        # Check if agent process is running
        $agent = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -match "index\.js" -and $_.CommandLine -match "local-agent"
        }
        if ($agent) {
            Write-Host "Agent:    Running (PID $($agent.Id))" -ForegroundColor Green
        } else {
            Write-Host "Agent:    Not running" -ForegroundColor Yellow
        }

        # Check install directory
        if (Test-Path $InstallDir) {
            Write-Host "Install:  $InstallDir" -ForegroundColor Gray
        }
        Write-Host "Data:     $BotDir" -ForegroundColor Gray

        # Show last log entry
        if (Test-Path $LauncherLog) {
            $lastLine = Get-Content $LauncherLog -Tail 1
            Write-Host "Last log: $lastLine" -ForegroundColor DarkGray
        }
    }
    "update" {
        Write-Host "Updating DotBot..." -ForegroundColor Yellow
        Push-Location $InstallDir
        try {
            Write-Host "  Pulling latest..." -ForegroundColor Gray
            $out = & cmd /c "git pull 2>&1"
            if ($LASTEXITCODE -ne 0) { throw "git pull failed: $out" }
            Write-Host "  $out"

            Write-Host "  Installing dependencies..." -ForegroundColor Gray
            $out = & cmd /c "npm install 2>&1"
            if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }

            Write-Host "  Building..." -ForegroundColor Gray
            $out = & cmd /c "npm run build -w shared -w local-agent 2>&1"
            if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }

            # Update the CLI copy in ~/.bot/
            $cliSource = Join-Path $InstallDir "local-agent\scripts\dotbot.ps1"
            $cliDest = Join-Path $BotDir "dotbot.ps1"
            if (Test-Path $cliSource) { Copy-Item -Force $cliSource $cliDest }

            Write-Host "  [OK] Update complete. Restart with: dotbot restart" -ForegroundColor Green
        } catch {
            Write-Host "  [X] Update failed: $_" -ForegroundColor Red
        }
        Pop-Location
    }
    "start" {
        Write-Host "Starting DotBot..." -ForegroundColor Yellow
        Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($?) { Write-Host "Started." -ForegroundColor Green }
        else { Write-Host "Failed to start. Is the task registered?" -ForegroundColor Red }
    }
    "stop" {
        Write-Host "Stopping DotBot..." -ForegroundColor Yellow
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($?) { Write-Host "Stopped." -ForegroundColor Green }
        else { Write-Host "Failed to stop." -ForegroundColor Red }
    }
    "restart" {
        Write-Host "Restarting DotBot..." -ForegroundColor Yellow
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Write-Host "Restarted." -ForegroundColor Green
    }
    "logs" {
        if (Test-Path $LauncherLog) {
            Write-Host "=== DotBot Logs (last 50 lines, Ctrl+C to stop) ===" -ForegroundColor Cyan
            Get-Content $LauncherLog -Tail 50 -Wait
        } else {
            Write-Host "No log file found at $LauncherLog" -ForegroundColor Yellow
        }
    }
    default {
        Write-Host @"
DotBot CLI

Usage: dotbot <command>

Commands:
  open        Open the browser UI
  status      Show agent and service status
  update      Pull latest code and rebuild
  start       Start the DotBot background service
  stop        Stop the DotBot background service
  restart     Restart the DotBot background service
  logs        Tail the launcher log (Ctrl+C to stop)
  help        Show this help

Data directory: $BotDir
Install directory: $InstallDir
"@
    }
}
