#Requires -Version 5.1
<#
.SYNOPSIS
    DotBot Bootstrap Installer — Windows
.DESCRIPTION
    Single-command installer for DotBot. Handles prerequisites, clone, build,
    configuration, and first launch. Supports agent-only, server-only, or both.

    Usage:
      irm https://getmy.bot/install.ps1 | iex
      # or
      .\install.ps1 -RepoUrl <url> [-Mode agent|server|both] [-ServerUrl wss://your.server:3001] [-InviteToken dbot-XXXX-...]
.PARAMETER Mode
    Install mode: "agent" (default), "server", or "both"
.PARAMETER ServerUrl
    WebSocket URL of the DotBot server (agent mode only)
.PARAMETER InviteToken
    Invite token for device registration (agent mode only)
.PARAMETER RepoUrl
    Git clone URL (required — no default, will prompt if not provided)
.PARAMETER InstallDir
    Where to clone DotBot (default: C:\Program Files\.bot)
#>

param(
    [ValidateSet("agent", "server", "both", "")]
    [AllowEmptyString()]
    [string]$Mode,
    [string]$ServerUrl,
    [string]$InviteToken,
    [string]$RepoUrl,
    [string]$InstallDir
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # Speeds up Invoke-WebRequest
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -Force

# ============================================
# CONSTANTS
# ============================================

$BOT_DIR = Join-Path $env:USERPROFILE ".bot"
$STATUS_FILE = Join-Path $BOT_DIR "install-status.json"
$ENV_FILE = Join-Path $BOT_DIR ".env"
$DEVICE_FILE = Join-Path $BOT_DIR "device.json"
$INSTALLER_VERSION = "1.0.0"
$NODE_MAJOR = 20
$DEFAULT_REPO_URL = "https://github.com/Druidia-Bot/DotBot.git"

# ============================================
# HELPERS
# ============================================

function Write-Banner {
    Write-Host ""
    Write-Host "  ╔═══════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "  ║                                                   ║" -ForegroundColor Cyan
    Write-Host "  ║   🤖  DotBot Installer v${INSTALLER_VERSION}                    ║" -ForegroundColor Cyan
    Write-Host "  ║                                                   ║" -ForegroundColor Cyan
    Write-Host "  ║   Your AI assistant, installed in minutes.        ║" -ForegroundColor Cyan
    Write-Host "  ║                                                   ║" -ForegroundColor Cyan
    Write-Host "  ╚═══════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step {
    param([string]$Step, [string]$Message)
    Write-Host "  [$Step] " -NoNewline -ForegroundColor Yellow
    Write-Host $Message
}

function Write-OK {
    param([string]$Message)
    Write-Host "  ✅ $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  ⚠️  $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  ❌ $Message" -ForegroundColor Red
}

# Status tracking
$installStatus = @{
    installedAt      = (Get-Date -Format "o")
    installerVersion = $INSTALLER_VERSION
    completedSuccessfully = $false
    mode             = ""
    steps            = @{}
}

function Set-StepStatus {
    param(
        [string]$StepName,
        [string]$Status,       # success, failed, skipped
        [int]$Tier = 1,
        [string]$Version = "",
        [string]$ErrorMsg = "",
        [string]$Reason = "",
        [string]$Path = ""
    )
    $entry = @{ status = $Status; tier = $Tier }
    if ($Version)  { $entry.version = $Version }
    if ($ErrorMsg) { $entry.error = $ErrorMsg }
    if ($Reason)   { $entry.reason = $Reason }
    if ($Path)     { $entry.path = $Path }
    $installStatus.steps[$StepName] = $entry
}

function Save-InstallStatus {
    if (-not (Test-Path $BOT_DIR)) {
        New-Item -ItemType Directory -Path $BOT_DIR -Force | Out-Null
    }
    $installStatus | ConvertTo-Json -Depth 4 | Set-Content -Path $STATUS_FILE -Encoding UTF8
}

function Test-Command {
    param([string]$Cmd)
    try { Get-Command $Cmd -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

# ============================================
# STEP: INTERACTIVE MODE SELECTION
# ============================================

function Get-InstallMode {
    if ($Mode) { return $Mode }

    Write-Host ""
    Write-Host "  What would you like to install?" -ForegroundColor White
    Write-Host ""
    Write-Host "    [1] DotBot Service  — connect to our hosted server (coming soon)" -ForegroundColor Cyan
    Write-Host "    [2] Local Agent     — connects to a self-hosted DotBot server" -ForegroundColor White
    Write-Host "    [3] Server          — host your own DotBot server" -ForegroundColor White
    Write-Host "    [4] Both            — development / single-machine setup" -ForegroundColor White
    Write-Host ""

    do {
        $choice = Read-Host "  Enter choice (1/2/3/4)"
    } while ($choice -notmatch '^[1234]$')

    switch ($choice) {
        "1" {
            Write-Host ""
            Write-Host "  ⭐ The DotBot managed service is coming soon!" -ForegroundColor Cyan
            Write-Host "  We're building a hosted server so you don't have to run your own." -ForegroundColor White
            Write-Host "  For now, please choose option [2] to connect to a self-hosted server," -ForegroundColor White
            Write-Host "  or option [3] to set up your own server." -ForegroundColor White
            Write-Host ""
            Write-Host "  Sign up for updates: https://getmy.bot" -ForegroundColor Gray
            Write-Host ""
            Read-Host "  Press Enter to go back"
            return Get-InstallMode
        }
        "2" { return "agent" }
        "3" { return "server" }
        "4" { return "both" }
    }
}

# ============================================
# STEP: COLLECT AGENT CONFIG
# ============================================

function Get-AgentConfig {
    if (-not $ServerUrl) {
        Write-Host ""
        $ServerUrl = Read-Host "  Enter DotBot server WebSocket URL (e.g. wss://dotbot.example.com:3001)"
        if (-not $ServerUrl) {
            $ServerUrl = "ws://localhost:3001"
            Write-Warn "No URL entered — defaulting to $ServerUrl"
        }
    }
    if (-not $InviteToken) {
        Write-Host ""
        $InviteToken = Read-Host "  Enter your invite token (e.g. dbot-XXXX-XXXX-XXXX-XXXX)"
        if (-not $InviteToken) {
            Write-Fail "Invite token is required for agent registration."
            exit 1
        }
    }
    return @{ ServerUrl = $ServerUrl; InviteToken = $InviteToken }
}

# ============================================
# TIER 1: GIT
# ============================================

function Install-Git {
    Write-Step "1/11" "Checking Git..."
    if (Test-Command "git") {
        $ver = (git --version 2>$null) -replace 'git version ',''
        Write-OK "Git $ver already installed"
        Set-StepStatus -StepName "git" -Status "success" -Version $ver
        return $true
    }

    Write-Step "1/11" "Installing Git via winget..."
    try {
        winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements --silent 2>$null | Out-Null
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        if (Test-Command "git") {
            $ver = (git --version 2>$null) -replace 'git version ',''
            Write-OK "Git $ver installed"
            Set-StepStatus -StepName "git" -Status "success" -Version $ver
            return $true
        }
    } catch {}

    Write-Fail "Git installation failed."
    Write-Host "    Download manually: https://git-scm.com/download/win" -ForegroundColor Gray
    Set-StepStatus -StepName "git" -Status "failed" -ErrorMsg "winget install failed"
    return $false
}

# ============================================
# TIER 1: NODE.JS
# ============================================

function Install-NodeJS {
    Write-Step "2/11" "Checking Node.js..."
    if (Test-Command "node") {
        $ver = (node --version 2>$null) -replace 'v',''
        $major = [int]($ver.Split('.')[0])
        if ($major -ge $NODE_MAJOR) {
            Write-OK "Node.js $ver already installed"
            Set-StepStatus -StepName "nodejs" -Status "success" -Version $ver
            return $true
        }
        Write-Warn "Node.js $ver found but need v${NODE_MAJOR}+. Upgrading..."
    }

    Write-Step "2/11" "Installing Node.js ${NODE_MAJOR} LTS via winget..."
    try {
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent 2>$null | Out-Null
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        if (Test-Command "node") {
            $ver = (node --version 2>$null) -replace 'v',''
            Write-OK "Node.js $ver installed"
            Set-StepStatus -StepName "nodejs" -Status "success" -Version $ver
            return $true
        }
    } catch {}

    Write-Fail "Node.js installation failed."
    Write-Host "    Download manually: https://nodejs.org/" -ForegroundColor Gray
    Set-StepStatus -StepName "nodejs" -Status "failed" -ErrorMsg "winget install failed"
    return $false
}

# ============================================
# TIER 2: PYTHON
# ============================================

function Test-RealPython {
    param([string]$Cmd)
    try {
        $resolved = Get-Command $Cmd -ErrorAction SilentlyContinue
        if (-not $resolved) { return $null }
        # Skip Windows App Execution Alias stubs (they live in WindowsApps)
        if ($resolved.Source -match 'WindowsApps') { return $null }
        $out = & $Cmd --version 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        $verStr = "$out"
        if ($verStr -match '3\.(1[1-9]|[2-9]\d)') { return $verStr -replace 'Python ','' }
    } catch { return $null }
    return $null
}

function Install-Python {
    Write-Step "3/11" "Checking Python..."
    $pythonCmd = $null
    foreach ($cmd in @("python", "python3")) {
        $ver = Test-RealPython $cmd
        if ($ver) {
            $pythonCmd = $cmd
            break
        }
    }
    if ($pythonCmd) {
        Write-OK "Python $ver already installed"
        Set-StepStatus -StepName "python" -Status "success" -Tier 2 -Version $ver
        return $true
    }

    Write-Step "3/11" "Installing Python 3.11 via winget..."
    try {
        winget install --id Python.Python.3.11 -e --accept-source-agreements --accept-package-agreements --silent 2>$null | Out-Null
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        $ver = Test-RealPython "python"
        if ($ver) {
            Write-OK "Python $ver installed"
            Set-StepStatus -StepName "python" -Status "success" -Tier 2 -Version $ver
            return $true
        }
    } catch {}

    Write-Warn "Python installation failed — GUI automation will be unavailable."
    Write-Host "    DotBot will try to fix this after startup." -ForegroundColor Gray
    Set-StepStatus -StepName "python" -Status "failed" -Tier 2 -ErrorMsg "winget install failed"
    return $false
}

# ============================================
# TIER 2: PIP PACKAGES
# ============================================

function Install-PipPackages {
    param($PythonOK)
    Write-Step "4/11" "Checking pip packages..."

    if (-not $PythonOK) {
        Write-Warn "Skipping pip packages — Python not installed"
        Set-StepStatus -StepName "pip_packages" -Status "skipped" -Tier 2 -Reason "python not installed"
        return
    }

    try {
        python -m pip install --quiet --upgrade --user pyautogui pywinauto pyperclip pillow 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "pip install exited with code $LASTEXITCODE" }
        Write-OK "pip packages installed"
        Set-StepStatus -StepName "pip_packages" -Status "success" -Tier 2
    } catch {
        Write-Warn "pip packages failed — GUI automation may not work"
        Set-StepStatus -StepName "pip_packages" -Status "failed" -Tier 2 -ErrorMsg $_.Exception.Message
    }
}

# ============================================
# TIER 2: TESSERACT
# ============================================

function Install-Tesseract {
    Write-Step "5/11" "Checking Tesseract OCR..."
    if (Test-Command "tesseract") {
        Write-OK "Tesseract already installed"
        Set-StepStatus -StepName "tesseract" -Status "success" -Tier 2
        return
    }

    # Check common install locations
    $tessPath = @(
        "C:\Program Files\Tesseract-OCR\tesseract.exe",
        "C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($tessPath) {
        Write-OK "Tesseract found at $tessPath"
        Set-StepStatus -StepName "tesseract" -Status "success" -Tier 2 -Path $tessPath
        return
    }

    Write-Warn "Tesseract not found — screenshot OCR will be unavailable."
    Write-Host "    DotBot will try to install it after startup." -ForegroundColor Gray
    Set-StepStatus -StepName "tesseract" -Status "skipped" -Tier 2 -Reason "not found, Dot will install"
}

# ============================================
# TIER 1: CLONE REPO
# ============================================

function Install-CloneRepo {
    param([string]$Dir)
    Write-Step "6/11" "Cloning DotBot repository..."

    if (Test-Path (Join-Path $Dir "package.json")) {
        Write-OK "Repository already exists at $Dir"
        Set-StepStatus -StepName "clone" -Status "success" -Path $Dir
        return $true
    }

    try {
        git clone $RepoUrl $Dir 2>$null | Out-Null
        if (Test-Path (Join-Path $Dir "package.json")) {
            $commit = (git -C $Dir rev-parse --short HEAD 2>$null)
            Write-OK "Cloned to $Dir (commit: $commit)"
            Set-StepStatus -StepName "clone" -Status "success" -Path $Dir -Version $commit
            return $true
        }
    } catch {}

    Write-Fail "Failed to clone repository."
    Set-StepStatus -StepName "clone" -Status "failed" -ErrorMsg "git clone failed"
    return $false
}

# ============================================
# TIER 1: NPM INSTALL
# ============================================

function Install-NpmDeps {
    param([string]$Dir)
    Write-Step "7/11" "Installing npm dependencies..."

    try {
        Push-Location $Dir
        $npmOut = npm install 2>$null
        if ($LASTEXITCODE -ne 0) {
            $npmOut | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            throw "npm install exited with code $LASTEXITCODE"
        }
        Pop-Location
        Write-OK "npm dependencies installed"
        Set-StepStatus -StepName "npm_install" -Status "success"
        return $true
    } catch {
        Pop-Location
        Write-Fail "npm install failed: $($_.Exception.Message)"
        Set-StepStatus -StepName "npm_install" -Status "failed" -ErrorMsg $_.Exception.Message
        return $false
    }
}

# ============================================
# TIER 1: BUILD
# ============================================

function Install-Build {
    param([string]$Dir, [string]$SelectedMode)
    Write-Step "8/11" "Building packages..."

    try {
        # Always build shared first
        Push-Location (Join-Path $Dir "shared")
        $buildOut = npm run build 2>$null
        if ($LASTEXITCODE -ne 0) {
            $buildOut | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            throw "shared/ build exited with code $LASTEXITCODE"
        }
        Pop-Location
        Write-OK "shared/ built"
        Set-StepStatus -StepName "build_shared" -Status "success"
    } catch {
        Pop-Location
        Write-Fail "shared/ build failed"
        Set-StepStatus -StepName "build_shared" -Status "failed" -ErrorMsg $_.Exception.Message
        return $false
    }

    if ($SelectedMode -eq "agent" -or $SelectedMode -eq "both") {
        try {
            Push-Location (Join-Path $Dir "local-agent")
            $buildOut = npm run build 2>$null
            if ($LASTEXITCODE -ne 0) {
                $buildOut | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
                throw "local-agent/ build exited with code $LASTEXITCODE"
            }
            Pop-Location
            Write-OK "local-agent/ built"
            Set-StepStatus -StepName "build_agent" -Status "success"
        } catch {
            Pop-Location
            Write-Fail "local-agent/ build failed"
            Set-StepStatus -StepName "build_agent" -Status "failed" -ErrorMsg $_.Exception.Message
            return $false
        }
    }

    if ($SelectedMode -eq "server" -or $SelectedMode -eq "both") {
        try {
            Push-Location (Join-Path $Dir "server")
            $buildOut = npm run build 2>$null
            if ($LASTEXITCODE -ne 0) {
                $buildOut | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
                throw "server/ build exited with code $LASTEXITCODE"
            }
            Pop-Location
            Write-OK "server/ built"
            Set-StepStatus -StepName "build_server" -Status "success"
        } catch {
            Pop-Location
            Write-Fail "server/ build failed"
            Set-StepStatus -StepName "build_server" -Status "failed" -ErrorMsg $_.Exception.Message
            return $false
        }
    }

    return $true
}

# ============================================
# POST-CLONE CLEANUP
# ============================================

function Remove-UnneededPackages {
    param([string]$Dir, [string]$SelectedMode)
    Write-Step "9/11" "Cleaning up unneeded packages..."

    $deleted = @()
    if ($SelectedMode -eq "agent") {
        foreach ($d in @("server", "deploy", ".vscode")) {
            $p = Join-Path $Dir $d
            if (Test-Path $p) { Remove-Item -Recurse -Force $p; $deleted += $d }
        }
    }
    elseif ($SelectedMode -eq "server") {
        foreach ($d in @("local-agent", ".vscode")) {
            $p = Join-Path $Dir $d
            if (Test-Path $p) { Remove-Item -Recurse -Force $p; $deleted += $d }
        }
        foreach ($f in @("run.ps1", "stop.bat")) {
            $p = Join-Path $Dir $f
            if (Test-Path $p) { Remove-Item -Force $p; $deleted += $f }
        }
    }

    if ($deleted.Count -gt 0) {
        Write-OK "Removed: $($deleted -join ', ')"
    } else {
        Write-OK "No cleanup needed (both mode)"
    }

    # Record install mode
    $modeInfo = @{
        mode = $SelectedMode
        installedAt = (Get-Date -Format "o")
        repoPath = $Dir
        version = "0.1.0"
        gitCommit = (git -C $Dir rev-parse --short HEAD 2>$null)
        deletedPackages = $deleted
    }
    $modeInfo | ConvertTo-Json -Depth 2 | Set-Content -Path (Join-Path $BOT_DIR "install-mode.json") -Encoding UTF8

    # Update root package.json to remove deleted workspaces
    # (npm fails if a workspace directory in package.json doesn't exist)
    if ($deleted.Count -gt 0) {
        $pkgPath = Join-Path $Dir "package.json"
        if (Test-Path $pkgPath) {
            $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
            $pkg.workspaces = @($pkg.workspaces | Where-Object { $_ -notin $deleted })
            $pkg | ConvertTo-Json -Depth 4 | Set-Content -Path $pkgPath -Encoding UTF8
            Write-OK "Updated package.json workspaces"
        }
    }
}

# ============================================
# CONFIGURE .ENV
# ============================================

function Set-AgentEnv {
    param([string]$Url, [string]$Token)
    Write-Step "10/11" "Configuring agent environment..."

    if (-not (Test-Path $BOT_DIR)) {
        New-Item -ItemType Directory -Path $BOT_DIR -Force | Out-Null
    }

    $envContent = @"
# DotBot Agent Configuration
# Generated by installer on $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

DOTBOT_SERVER=$Url
DOTBOT_INVITE_TOKEN=$Token
"@

    # Append to existing .env or create new
    if (Test-Path $ENV_FILE) {
        # Remove existing DOTBOT_ lines and append new ones
        $existing = Get-Content $ENV_FILE | Where-Object { $_ -notmatch '^DOTBOT_(SERVER|INVITE_TOKEN)=' }
        ($existing + "" + $envContent) | Set-Content -Path $ENV_FILE -Encoding UTF8
    } else {
        $envContent | Set-Content -Path $ENV_FILE -Encoding UTF8
    }

    Write-OK "Agent configured: server=$Url"
    Set-StepStatus -StepName "configure_env" -Status "success"
}

# ============================================
# TIER 2: PLAYWRIGHT
# ============================================

function Install-Playwright {
    param([string]$Dir)
    Write-Step "11/11" "Installing Playwright Chromium..."

    try {
        Push-Location $Dir
        npx playwright install chromium --with-deps 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Playwright install exited with code $LASTEXITCODE" }
        Pop-Location
        Write-OK "Playwright Chromium installed"
        Set-StepStatus -StepName "playwright" -Status "success" -Tier 2
    } catch {
        Pop-Location
        Write-Warn "Playwright install failed — headless browser unavailable"
        Set-StepStatus -StepName "playwright" -Status "failed" -Tier 2 -ErrorMsg $_.Exception.Message
    }
}

# ============================================
# SHORTCUTS
# ============================================

function Install-Shortcuts {
    param([string]$Dir)

    try {
        $shell = New-Object -ComObject WScript.Shell
        $startMenu = [Environment]::GetFolderPath("Programs")
        $launcherPath = Join-Path $Dir "launch.ps1"

        if (-not (Test-Path $launcherPath)) {
            Write-Warn "launch.ps1 not found — skipping shortcut creation"
            return
        }

        # Start Menu shortcut
        $lnkPath = Join-Path $startMenu "DotBot.lnk"
        $shortcut = $shell.CreateShortcut($lnkPath)
        $shortcut.TargetPath = "powershell.exe"
        $shortcut.Arguments = "-ExecutionPolicy Bypass -NoExit -File `"$launcherPath`""
        $shortcut.WorkingDirectory = $Dir
        $shortcut.Description = "Start DotBot"
        $shortcut.Save()
        Write-OK "Start Menu shortcut created — search 'DotBot' to launch"

        # Register as background service via Task Scheduler (hidden, no window)
        Write-Host ""
        $autoStart = Read-Host "  Start DotBot automatically on login? (Y/n)"
        if ($autoStart -ne "n" -and $autoStart -ne "N") {
            try {
                $Action = New-ScheduledTaskAction `
                    -Execute "powershell.exe" `
                    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherPath`" -Service" `
                    -WorkingDirectory $Dir

                $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

                $Settings = New-ScheduledTaskSettingsSet `
                    -AllowStartIfOnBatteries `
                    -DontStopIfGoingOnBatteries `
                    -StartWhenAvailable `
                    -ExecutionTimeLimit ([TimeSpan]::Zero)

                Register-ScheduledTask `
                    -TaskName "DotBot" `
                    -Action $Action `
                    -Trigger $Trigger `
                    -Settings $Settings `
                    -Description "DotBot AI Assistant — background agent" `
                    -Force | Out-Null

                Write-OK "Background service registered — DotBot starts automatically on login (hidden)"
                Set-StepStatus -StepName "task_scheduler" -Status "success"
            } catch {
                Write-Warn "Task Scheduler registration failed: $($_.Exception.Message)"
                Write-Host "    DotBot will still work — just won't auto-start on login." -ForegroundColor Gray
                Set-StepStatus -StepName "task_scheduler" -Status "failed" -Tier 2 -ErrorMsg $_.Exception.Message
            }
        } else {
            Write-Host "    Skipped — you can register later with:" -ForegroundColor DarkGray
            Write-Host "    schtasks /create /tn DotBot /tr `"powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File '$launcherPath'`" /sc onlogon" -ForegroundColor DarkGray
        }
    } catch {
        Write-Warn "Could not create shortcuts: $($_.Exception.Message)"
    }
}

# ============================================
# MAIN
# ============================================

Write-Banner

# Step 0: Select mode
$selectedMode = Get-InstallMode
$installStatus.mode = $selectedMode
Write-Host ""
Write-Host "  Installing: $selectedMode" -ForegroundColor White
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkGray

# Step 0b: Collect agent config if needed
$agentConfig = $null
if ($selectedMode -eq "agent" -or $selectedMode -eq "both") {
    if (-not (Test-Path $DEVICE_FILE)) {
        $agentConfig = Get-AgentConfig
    } else {
        Write-OK "Device already registered (device.json exists)"
    }
}

# Determine install directory
if (-not $InstallDir) {
    $InstallDir = Join-Path $env:ProgramFiles ".bot"
}

# Ensure ~/.bot/ exists
if (-not (Test-Path $BOT_DIR)) {
    New-Item -ItemType Directory -Path $BOT_DIR -Force | Out-Null
}

Write-Host ""

# ── TIER 1: Hard requirements ──

$gitOK = Install-Git
if (-not $gitOK) {
    Save-InstallStatus
    Write-Fail "Cannot continue without Git. Please install it manually and re-run."
    Read-Host "  Press Enter to exit"
    exit 1
}

$nodeOK = Install-NodeJS
if (-not $nodeOK) {
    Save-InstallStatus
    Write-Fail "Cannot continue without Node.js. Please install it manually and re-run."
    Read-Host "  Press Enter to exit"
    exit 1
}

# ── TIER 2: Soft requirements ──

$pythonOK = Install-Python
Install-PipPackages -PythonOK $pythonOK
Install-Tesseract

# Prompt for repo URL if not provided
if (-not $RepoUrl) {
    if ($DEFAULT_REPO_URL -and $DEFAULT_REPO_URL -match '^https?://') {
        $RepoUrl = $DEFAULT_REPO_URL
        Write-OK "Using default repo: $RepoUrl"
    } else {
        Write-Host ""
        $RepoUrl = Read-Host "  Enter DotBot Git clone URL"
        if (-not $RepoUrl) {
            Write-Fail "Repository URL is required."
            Read-Host "  Press Enter to exit"
            exit 1
        }
    }
}

# ── TIER 1: Clone + Build ──

$cloneOK = Install-CloneRepo -Dir $InstallDir
if (-not $cloneOK) {
    Save-InstallStatus
    Write-Fail "Cannot continue without the DotBot repository."
    Read-Host "  Press Enter to exit"
    exit 1
}

$npmOK = Install-NpmDeps -Dir $InstallDir
if (-not $npmOK) {
    Save-InstallStatus
    Write-Fail "Cannot continue — npm install failed."
    Read-Host "  Press Enter to exit"
    exit 1
}

$buildOK = Install-Build -Dir $InstallDir -SelectedMode $selectedMode
if (-not $buildOK) {
    Save-InstallStatus
    Write-Fail "Build failed. Check the error above."
    Read-Host "  Press Enter to exit"
    exit 1
}

# ── Post-build: Cleanup + Configure ──

Remove-UnneededPackages -Dir $InstallDir -SelectedMode $selectedMode

if ($agentConfig) {
    Set-AgentEnv -Url $agentConfig.ServerUrl -Token $agentConfig.InviteToken
}

# ── Server .env API key prompts ──

if ($selectedMode -eq "server" -or $selectedMode -eq "both") {
    $serverEnvPath = Join-Path $InstallDir ".env"
    if (-not (Test-Path $serverEnvPath) -or (Get-Content $serverEnvPath -Raw) -match "your_key_here") {
        Write-Host ""
        Write-Host "  ┌────────────────────────────────────────────────┐" -ForegroundColor Yellow
        Write-Host "  │  API Key Setup                                │" -ForegroundColor Yellow
        Write-Host "  │  Press Enter to skip any key you don't have.  │" -ForegroundColor Yellow
        Write-Host "  │  You need at least ONE LLM key to start.      │" -ForegroundColor Yellow
        Write-Host "  └────────────────────────────────────────────────┘" -ForegroundColor Yellow
        Write-Host ""

        $envLines = @(
            "# DotBot Server Environment",
            "# Generated by installer on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
            "",
            "PORT=3000",
            "WS_PORT=3001"
        )

        $keys = @(
            @{ Name = "DEEPSEEK_API_KEY";  Prompt = "DeepSeek API Key (workhorse — recommended)"; Url = "https://platform.deepseek.com/api_keys" },
            @{ Name = "GEMINI_API_KEY";    Prompt = "Google Gemini API Key (deep context — 1M tokens)"; Url = "https://aistudio.google.com/apikey" },
            @{ Name = "ANTHROPIC_API_KEY"; Prompt = "Anthropic API Key (architect — complex reasoning)"; Url = "https://console.anthropic.com/settings/keys" },
            @{ Name = "OPENAI_API_KEY";    Prompt = "OpenAI API Key (optional fallback)"; Url = "https://platform.openai.com/api-keys" },
            @{ Name = "SCRAPING_DOG_API_KEY"; Prompt = "ScrapingDog API Key (optional — premium web tools)"; Url = "https://www.scrapingdog.com/" }
        )

        $keyCount = 0
        foreach ($key in $keys) {
            Write-Host "  $($key.Prompt)" -ForegroundColor White
            Write-Host "    Get one: $($key.Url)" -ForegroundColor Gray
            $value = Read-Host "    $($key.Name)"
            if ($value) {
                $envLines += "$($key.Name)=$value"
                $keyCount++
                Write-OK "$($key.Name) set"
            } else {
                $envLines += "# $($key.Name)="
                Write-Host "    Skipped" -ForegroundColor DarkGray
            }
            Write-Host ""
        }

        $envLines -join "`n" | Set-Content -Path $serverEnvPath -Encoding UTF8 -NoNewline

        if ($keyCount -eq 0) {
            Write-Warn "No API keys entered. You'll need to edit $serverEnvPath before starting."
        } else {
            Write-OK "$keyCount API key(s) configured in .env"
        }
    } else {
        Write-OK ".env already configured"
    }
}

# ── TIER 2: Playwright ──

if ($selectedMode -eq "agent" -or $selectedMode -eq "both") {
    Install-Playwright -Dir $InstallDir
}

# ── Shortcuts ──

Install-Shortcuts -Dir $InstallDir

# ── Save final status ──

$installStatus.completedSuccessfully = $true
Save-InstallStatus

Write-Host ""
Write-Host "  ════════════════════════════════════════" -ForegroundColor Green
Write-Host "  ✅ DotBot installation complete!" -ForegroundColor Green
Write-Host "  ════════════════════════════════════════" -ForegroundColor Green
Write-Host ""

if ($selectedMode -eq "server" -or $selectedMode -eq "both") {
    Write-Host "  Starting DotBot server..." -ForegroundColor Green
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-Command",
        "Set-Location '$InstallDir'; Write-Host '  DotBot Server' -ForegroundColor Cyan; Write-Host '  Press Ctrl+C to stop' -ForegroundColor Gray; Write-Host ''; node server/dist/index.js"
    )
    Start-Sleep -Seconds 2
}

if ($selectedMode -eq "agent" -or $selectedMode -eq "both") {
    Write-Host "  Starting DotBot agent..." -ForegroundColor Green
    Start-Process powershell -ArgumentList @(
        "-NoExit", "-Command",
        "Set-Location '$InstallDir'; Write-Host '  DotBot Local Agent' -ForegroundColor Cyan; Write-Host '  Press Ctrl+C to stop' -ForegroundColor Gray; Write-Host ''; node local-agent/dist/index.js"
    )
    Start-Sleep -Seconds 2
}

$clientPath = Join-Path $InstallDir "client\index.html"
if (Test-Path $clientPath) {
    Write-Host "  Opening DotBot in your browser..." -ForegroundColor Green
    Start-Process $clientPath

    # Hint: if the server is remote, the browser needs the URL configured
    $agentEnvFile = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".bot\.env"
    $serverWsUrl = ""
    if (Test-Path $agentEnvFile) {
        $envRaw = Get-Content $agentEnvFile -Raw
        if ($envRaw -match 'DOTBOT_SERVER=(.+)') {
            $serverWsUrl = $Matches[1].Trim()
        }
    }
    if ($serverWsUrl -and $serverWsUrl -ne "ws://localhost:3001") {
        Write-Host ""
        Write-Host "  ℹ️  In the browser, click ⚙️ and set your server URL to:" -ForegroundColor Yellow
        Write-Host "     $serverWsUrl" -ForegroundColor Cyan
    }
}

Write-Host ""
Write-Host "  To stop DotBot later, close the PowerShell windows or run:" -ForegroundColor Gray
Write-Host "    powershell -File '$InstallDir\run.ps1' -Stop" -ForegroundColor Gray
Write-Host ""

$failedSteps = $installStatus.steps.GetEnumerator() | Where-Object { $_.Value.status -eq "failed" }
if ($failedSteps) {
    Write-Host "  ⚠️  Some optional components failed to install:" -ForegroundColor Yellow
    foreach ($step in $failedSteps) {
        Write-Host "    - $($step.Key): $($step.Value.error)" -ForegroundColor Yellow
    }
    Write-Host "  DotBot will try to fix these after startup." -ForegroundColor Yellow
    Write-Host ""
}
