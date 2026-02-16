#Requires -Version 5.1
<#
.SYNOPSIS
    DotBot Uninstaller -- Windows
.DESCRIPTION
    Fully removes DotBot from this machine. Reverses everything install.ps1 created.

    Removes:
      - Running DotBot processes (agent + server)
      - Scheduled Task ("DotBot", "DotBot-Cleanup")
      - Start Menu shortcut
      - CLI wrapper (~/.bot/dotbot.ps1, dotbot.cmd)
      - User PATH entry for ~/.bot
      - Install directory (default: C:\.bot)
      - User data directory (~/.bot/)
      - Playwright browsers (%LOCALAPPDATA%\ms-playwright)

    Does NOT remove:
      - Git, Node.js, Python (shared system tools you may need)
      - Everything Search (you may use it independently)
      - Tesseract OCR (you may use it independently)

    Usage:
      .\uninstall.ps1                  Interactive (confirms each step)
      .\uninstall.ps1 -Force           Remove everything without prompting
      .\uninstall.ps1 -KeepData        Remove app but keep ~/.bot/ user data
      .\uninstall.ps1 -WhatIf          Show what would be removed without doing it

.PARAMETER Force
    Skip all confirmation prompts
.PARAMETER KeepData
    Preserve ~/.bot/ (memory, vault, device credentials, .env)
.PARAMETER WhatIf
    Dry run -- show what would be removed without actually removing anything
.PARAMETER InstallDir
    Override install directory detection (default: auto-detect)
#>

param(
    [switch]$Force,
    [switch]$KeepData,
    [switch]$WhatIf,
    [string]$InstallDir
)

$ErrorActionPreference = "Continue"

# ============================================
# SELF-ELEVATE TO ADMINISTRATOR
# ============================================

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "  Requesting administrator privileges..." -ForegroundColor Yellow

    $argList = @("-ExecutionPolicy", "Bypass", "-NoExit", "-File", "`"$PSCommandPath`"")
    if ($Force)    { $argList += "-Force" }
    if ($KeepData) { $argList += "-KeepData" }
    if ($WhatIf)   { $argList += "-WhatIf" }
    if ($InstallDir) { $argList += "-InstallDir", $InstallDir }

    try {
        Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait
    } catch {
        Write-Host ""
        Write-Host "  [X] Administrator privileges required." -ForegroundColor Red
        Write-Host "     Right-click PowerShell -> 'Run as administrator', then try again." -ForegroundColor Gray
        exit 1
    }
    exit 0
}

Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -Force

# Refresh PATH from registry
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

# ============================================
# CONSTANTS
# ============================================

$BOT_DIR = Join-Path $env:USERPROFILE ".bot"
$PLAYWRIGHT_DIR = Join-Path $env:LOCALAPPDATA "ms-playwright"

# ============================================
# HELPERS
# ============================================

function Write-Banner {
    Write-Host ""
    Write-Host "  =====================================================" -ForegroundColor Red
    Write-Host "                                                        " -ForegroundColor Red
    Write-Host "      DotBot Uninstaller                                " -ForegroundColor Red
    Write-Host "                                                        " -ForegroundColor Red
    Write-Host "  =====================================================" -ForegroundColor Red
    Write-Host ""
}

function Write-Action {
    param([string]$Message)
    if ($WhatIf) {
        Write-Host "  [DRY RUN] $Message" -ForegroundColor Cyan
    } else {
        Write-Host "  [OK] $Message" -ForegroundColor Green
    }
}

function Write-Skip {
    param([string]$Message)
    Write-Host "  [--] $Message" -ForegroundColor DarkGray
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  [!] $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  [X] $Message" -ForegroundColor Red
}

function Confirm-Step {
    param([string]$Message)
    if ($Force) { return $true }
    $response = Read-Host "  $Message (y/N)"
    return ($response -eq "y" -or $response -eq "Y")
}

function Find-DotBotPids {
    $pids = @()
    Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
            if (($_.Path -and $_.Path -match '[Dd]ot[Bb]ot|\.bot') -or ($cmdLine -and $cmdLine -match '[Dd]ot[Bb]ot|\.bot')) {
                $pids += $_.Id
            }
        } catch {}
    }
    return ($pids | Sort-Object -Unique)
}

# ============================================
# DETECT INSTALL DIRECTORY
# ============================================

function Find-InstallDir {
    if ($InstallDir -and (Test-Path (Join-Path $InstallDir "package.json"))) {
        return $InstallDir
    }

    # Check common locations
    foreach ($candidate in @("C:\.bot", (Join-Path $env:ProgramFiles ".bot"))) {
        if (Test-Path (Join-Path $candidate "package.json")) {
            return $candidate
        }
    }

    # Check scheduled task for working directory
    try {
        $task = Get-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue
        if ($task) {
            $taskDir = $task.Actions[0].WorkingDirectory
            if ($taskDir -and (Test-Path (Join-Path $taskDir "package.json"))) {
                return $taskDir
            }
        }
    } catch {}

    # Check DOTBOT_INSTALL_DIR env var
    if ($env:DOTBOT_INSTALL_DIR -and (Test-Path (Join-Path $env:DOTBOT_INSTALL_DIR "package.json"))) {
        return $env:DOTBOT_INSTALL_DIR
    }

    return $null
}

# ============================================
# MAIN
# ============================================

Write-Banner

$detectedInstallDir = Find-InstallDir

# Show what we found
Write-Host "  Detected installation:" -ForegroundColor White
Write-Host ""

if ($detectedInstallDir) {
    Write-Host "    Install directory:  $detectedInstallDir" -ForegroundColor White
} else {
    Write-Host "    Install directory:  (not found)" -ForegroundColor DarkGray
}

if (Test-Path $BOT_DIR) {
    # Calculate size
    $botDirSize = 0
    try {
        $botDirSize = (Get-ChildItem -Path $BOT_DIR -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    } catch {}
    $sizeMB = [math]::Round($botDirSize / 1MB, 1)
    Write-Host "    User data:         $BOT_DIR ($sizeMB MB)" -ForegroundColor White
} else {
    Write-Host "    User data:         (not found)" -ForegroundColor DarkGray
}

$taskExists = $false
try { $taskExists = [bool](Get-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue) } catch {}
Write-Host "    Scheduled Task:    $(if ($taskExists) { 'DotBot (registered)' } else { '(not found)' })" -ForegroundColor White

$lnkPath = Join-Path ([Environment]::GetFolderPath("Programs")) "DotBot.lnk"
Write-Host "    Start Menu:        $(if (Test-Path $lnkPath) { 'DotBot.lnk' } else { '(not found)' })" -ForegroundColor White

$pids = Find-DotBotPids
Write-Host "    Running processes: $(if ($pids.Count -gt 0) { "$($pids.Count) (PID: $($pids -join ', '))" } else { '(none)' })" -ForegroundColor White

if (Test-Path $PLAYWRIGHT_DIR) {
    $pwSize = 0
    try {
        $pwSize = (Get-ChildItem -Path $PLAYWRIGHT_DIR -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    } catch {}
    $pwSizeMB = [math]::Round($pwSize / 1MB, 1)
    Write-Host "    Playwright:        $PLAYWRIGHT_DIR ($pwSizeMB MB)" -ForegroundColor White
} else {
    Write-Host "    Playwright:        (not found)" -ForegroundColor DarkGray
}

Write-Host ""

if (-not $detectedInstallDir -and -not (Test-Path $BOT_DIR) -and -not $taskExists) {
    Write-Host "  Nothing to uninstall -- DotBot does not appear to be installed." -ForegroundColor Yellow
    Write-Host ""
    exit 0
}

if (-not $Force -and -not $WhatIf) {
    Write-Host "  This will permanently remove DotBot from this machine." -ForegroundColor Red
    if (-not $KeepData) {
        Write-Host "  ALL user data (memory, credentials, settings) will be deleted." -ForegroundColor Red
        Write-Host "  Use -KeepData to preserve ~/.bot/ user data." -ForegroundColor Yellow
    } else {
        Write-Host "  User data (~/.bot/) will be preserved." -ForegroundColor Green
    }
    Write-Host ""
    if (-not (Confirm-Step "Proceed with uninstall?")) {
        Write-Host "  Cancelled." -ForegroundColor Yellow
        exit 0
    }
}

Write-Host ""
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray
Write-Host ""

# ============================================
# STEP 1: Stop running processes
# ============================================

Write-Host "  [1/8] Stopping DotBot processes..." -ForegroundColor Yellow

# Stop the scheduled task first
try {
    Stop-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue
} catch {}

$pids = Find-DotBotPids
if ($pids.Count -gt 0) {
    if (-not $WhatIf) {
        foreach ($p in $pids) {
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    }
    Write-Action "Stopped $($pids.Count) DotBot process(es)"
} else {
    Write-Skip "No running processes"
}

# ============================================
# STEP 2: Remove Scheduled Tasks
# ============================================

Write-Host "  [2/8] Removing scheduled tasks..." -ForegroundColor Yellow

foreach ($taskName in @("DotBot", "DotBot-Cleanup")) {
    try {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            if (-not $WhatIf) {
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
            }
            Write-Action "Removed scheduled task: $taskName"
        } else {
            Write-Skip "Scheduled task '$taskName' not found"
        }
    } catch {
        Write-Fail "Could not remove scheduled task '$taskName': $($_.Exception.Message)"
    }
}

# ============================================
# STEP 3: Remove Start Menu shortcut
# ============================================

Write-Host "  [3/8] Removing Start Menu shortcut..." -ForegroundColor Yellow

$lnkPath = Join-Path ([Environment]::GetFolderPath("Programs")) "DotBot.lnk"
if (Test-Path $lnkPath) {
    if (-not $WhatIf) {
        Remove-Item -Force $lnkPath -ErrorAction SilentlyContinue
    }
    Write-Action "Removed Start Menu shortcut"
} else {
    Write-Skip "Start Menu shortcut not found"
}

# ============================================
# STEP 4: Remove user PATH entry
# ============================================

Write-Host "  [4/8] Cleaning user PATH..." -ForegroundColor Yellow

$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -and $userPath -match [regex]::Escape($BOT_DIR)) {
    if (-not $WhatIf) {
        $parts = $userPath -split ";" | Where-Object { $_ -and $_ -ne $BOT_DIR }
        $newPath = ($parts -join ";")
        [System.Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + $newPath
    }
    Write-Action "Removed $BOT_DIR from user PATH"
} else {
    Write-Skip "User PATH does not contain $BOT_DIR"
}

# ============================================
# STEP 5: Remove install directory
# ============================================

Write-Host "  [5/8] Removing install directory..." -ForegroundColor Yellow

if ($detectedInstallDir -and (Test-Path $detectedInstallDir)) {
    if (-not $WhatIf) {
        try {
            Remove-Item -Path $detectedInstallDir -Recurse -Force -ErrorAction Stop
            Write-Action "Removed install directory: $detectedInstallDir"
        } catch {
            Write-Warn "Could not fully remove $detectedInstallDir (files may be locked)"
            Write-Host "    Try again after reboot, or delete manually." -ForegroundColor Gray
        }
    } else {
        Write-Action "Would remove install directory: $detectedInstallDir"
    }
} else {
    Write-Skip "Install directory not found"
}

# Also check the other common location
$otherDir = if ($detectedInstallDir -eq "C:\.bot") { Join-Path $env:ProgramFiles ".bot" } else { "C:\.bot" }
if ($otherDir -ne $detectedInstallDir -and (Test-Path (Join-Path $otherDir "package.json"))) {
    if (-not $WhatIf) {
        try {
            Remove-Item -Path $otherDir -Recurse -Force -ErrorAction Stop
            Write-Action "Removed old install directory: $otherDir"
        } catch {
            Write-Warn "Could not remove old install directory: $otherDir"
        }
    } else {
        Write-Action "Would remove old install directory: $otherDir"
    }
}

# ============================================
# STEP 6: Remove user data directory
# ============================================

Write-Host "  [6/8] Removing user data..." -ForegroundColor Yellow

if (Test-Path $BOT_DIR) {
    if ($KeepData) {
        Write-Skip "Preserving user data at $BOT_DIR (-KeepData)"
    } else {
        if (-not $WhatIf) {
            try {
                Remove-Item -Path $BOT_DIR -Recurse -Force -ErrorAction Stop
                Write-Action "Removed user data: $BOT_DIR"
            } catch {
                Write-Warn "Could not fully remove $BOT_DIR (files may be locked)"
                Write-Host "    Try again after reboot, or delete manually." -ForegroundColor Gray
            }
        } else {
            Write-Action "Would remove user data: $BOT_DIR"
        }
    }
} else {
    Write-Skip "User data directory not found"
}

# ============================================
# STEP 7: Remove Playwright browsers
# ============================================

Write-Host "  [7/8] Removing Playwright browsers..." -ForegroundColor Yellow

if (Test-Path $PLAYWRIGHT_DIR) {
    if (-not $WhatIf) {
        try {
            Remove-Item -Path $PLAYWRIGHT_DIR -Recurse -Force -ErrorAction Stop
            Write-Action "Removed Playwright browsers: $PLAYWRIGHT_DIR"
        } catch {
            Write-Warn "Could not remove Playwright directory (browsers may be in use)"
            Write-Host "    Delete manually: $PLAYWRIGHT_DIR" -ForegroundColor Gray
        }
    } else {
        Write-Action "Would remove Playwright browsers: $PLAYWRIGHT_DIR"
    }
} else {
    Write-Skip "Playwright browsers not found"
}

# ============================================
# STEP 8: Remove DOTBOT_INSTALL_DIR env var
# ============================================

Write-Host "  [8/8] Cleaning environment variables..." -ForegroundColor Yellow

$envVarRemoved = $false
foreach ($varName in @("DOTBOT_INSTALL_DIR")) {
    $val = [System.Environment]::GetEnvironmentVariable($varName, "User")
    if ($val) {
        if (-not $WhatIf) {
            [System.Environment]::SetEnvironmentVariable($varName, $null, "User")
        }
        Write-Action "Removed environment variable: $varName"
        $envVarRemoved = $true
    }
}
if (-not $envVarRemoved) {
    Write-Skip "No DotBot environment variables found"
}

# ============================================
# SUMMARY
# ============================================

Write-Host ""
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray
Write-Host ""

if ($WhatIf) {
    Write-Host "  [DRY RUN] No changes were made." -ForegroundColor Cyan
    Write-Host "  Run without -WhatIf to perform the uninstall." -ForegroundColor Cyan
} else {
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  [OK] DotBot has been uninstalled." -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green

    if ($KeepData) {
        Write-Host ""
        Write-Host "  User data preserved at: $BOT_DIR" -ForegroundColor Yellow
        Write-Host "  To remove it later: Remove-Item -Recurse -Force `"$BOT_DIR`"" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "  Note: Git, Node.js, Python, Everything Search, and Tesseract" -ForegroundColor DarkGray
Write-Host "  were NOT removed (they are shared system tools)." -ForegroundColor DarkGray
Write-Host "  Uninstall them separately via Settings > Apps if desired." -ForegroundColor DarkGray
Write-Host ""

Read-Host "  Press Enter to close"
