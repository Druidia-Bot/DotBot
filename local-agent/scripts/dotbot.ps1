# ============================================================
# DotBot CLI -- Thin wrapper around run.ps1
# ============================================================
#
# Usage:
#   dotbot open       -- Open the browser UI
#   dotbot status     -- Show agent and service status
#   dotbot update     -- Pull latest and rebuild
#   dotbot start      -- Start DotBot interactively
#   dotbot stop       -- Stop all DotBot processes
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

# Find run.ps1
$InstallDir = if ($env:DOTBOT_INSTALL_DIR) { $env:DOTBOT_INSTALL_DIR } else { "C:\.bot" }
$RunScript = Join-Path $InstallDir "run.ps1"

if (-not (Test-Path $RunScript)) {
    Write-Host "  [X] run.ps1 not found at $RunScript" -ForegroundColor Red
    Write-Host "      Set DOTBOT_INSTALL_DIR or reinstall DotBot." -ForegroundColor Gray
    exit 1
}

# Map CLI commands to run.ps1 flags
switch ($Command.ToLower()) {
    "open"    { & powershell -ExecutionPolicy Bypass -File $RunScript -Open }
    "status"  { & powershell -ExecutionPolicy Bypass -File $RunScript -Status }
    "update"  { & powershell -ExecutionPolicy Bypass -File $RunScript -Update }
    "start"   { & powershell -ExecutionPolicy Bypass -File $RunScript }
    "stop"    { & powershell -ExecutionPolicy Bypass -File $RunScript -Stop }
    "logs"    { & powershell -ExecutionPolicy Bypass -File $RunScript -Logs }
    default {
        Write-Host @"
DotBot CLI

Usage: dotbot <command>

Commands:
  open        Open the browser UI
  status      Show agent and service status
  update      Pull latest code and rebuild
  start       Start DotBot interactively
  stop        Stop all DotBot processes
  logs        Tail the launcher log (Ctrl+C to stop)
  help        Show this help

Install directory: $InstallDir
"@
    }
}
