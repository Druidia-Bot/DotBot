# ============================================================
# DEPRECATED — Use run.ps1 instead
# This file is kept for backwards compatibility with existing
# scheduled tasks and shortcuts that reference launch.ps1.
# It simply delegates to run.ps1.
# ============================================================

param([switch]$Service)

# Find run.ps1 in the same directory
$runScript = Join-Path $PSScriptRoot "run.ps1"
if (-not (Test-Path $runScript)) {
    # Fallback: check known install locations
    foreach ($c in @($env:DOTBOT_INSTALL_DIR, "C:\.bot")) {
        $candidate = Join-Path $c "run.ps1"
        if ($c -and (Test-Path $candidate)) { $runScript = $candidate; break }
    }
}

if (-not (Test-Path $runScript)) {
    Write-Host "  [X] run.ps1 not found. Please reinstall DotBot." -ForegroundColor Red
    exit 1
}

if ($Service) {
    & powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File $runScript -Service
} else {
    & powershell -ExecutionPolicy Bypass -NoExit -File $runScript
}
