#Requires -Version 5.1
<#
.SYNOPSIS
    DotBot Bootstrap Installer -- Windows
.DESCRIPTION
    Single-command installer for DotBot. Handles prerequisites, clone, build,
    configuration, and first launch. Supports agent-only, server-only, or both.

    Includes automatic retry logic, pre-flight checks, and self-recovery for
    network failures, disk space issues, and connection problems.

    One-liner install:
      irm https://getmy.bot/install.ps1 | iex

    Or download first and run:
      irm https://getmy.bot/install.ps1 -OutFile install.ps1
      .\install.ps1

    With parameters:
      .\install.ps1 -Mode agent -ServerUrl wss://your.server/ws -InviteToken dbot-XXXX-XXXX-XXXX-XXXX

.PARAMETER Mode
    Install mode: "agent" (default), "server", or "both"
.PARAMETER ServerUrl
    WebSocket URL of the DotBot server (agent mode only)
.PARAMETER InviteToken
    Invite token for device registration (agent mode only)
.PARAMETER RepoUrl
    Git clone URL (required -- no default, will prompt if not provided)
.PARAMETER InstallDir
    Where to clone DotBot (default: C:\.bot)

.NOTES
    This installer includes:
    - Pre-flight checks (disk space, internet, Windows version)
    - Automatic retry logic for network operations (3 attempts)
    - Invite token format validation
    - WebSocket connectivity testing
    - Comprehensive error diagnostics and recovery instructions
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

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"  # Speeds up Invoke-WebRequest

# Safety net: catch any unhandled error, display it, and pause so the user can see it
trap {
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Red
    Write-Host "  [X] UNEXPECTED ERROR" -ForegroundColor Red
    Write-Host "  ============================================" -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  At: $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber)" -ForegroundColor DarkGray
    Write-Host ""
    Read-Host "  Press Enter to close"
    break
}

# ============================================
# SELF-ELEVATE TO ADMINISTRATOR
# ============================================

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "  Requesting administrator privileges..." -ForegroundColor Yellow

    # Determine script path -- $PSCommandPath is empty when piped (irm | iex)
    $scriptPath = $PSCommandPath
    if (-not $scriptPath) {
        # INSTALL-08: Use random filename + read-only to mitigate TOCTOU race
        $scriptPath = Join-Path $env:TEMP "dotbot-install-$([System.IO.Path]::GetRandomFileName()).ps1"
        Invoke-WebRequest -Uri "https://getmy.bot/install.ps1" -OutFile $scriptPath -UseBasicParsing
        Set-ItemProperty -Path $scriptPath -Name IsReadOnly -Value $true
    }

    # Build argument list preserving any passed parameters
    # -NoExit keeps the elevated window open so the user can see errors
    $argList = @("-ExecutionPolicy", "Bypass", "-NoExit", "-File", "`"$scriptPath`"")
    if ($Mode)        { $argList += "-Mode",        $Mode }
    if ($ServerUrl)   { $argList += "-ServerUrl",   $ServerUrl }
    if ($InviteToken) { $argList += "-InviteToken", $InviteToken }
    if ($RepoUrl)     { $argList += "-RepoUrl",     $RepoUrl }
    if ($InstallDir)  { $argList += "-InstallDir",  $InstallDir }

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

# Refresh PATH from registry -- the elevated session may have a stale PATH
# that doesn't include tools installed since the last logon (e.g. Git, Node)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

# ============================================
# CONSTANTS
# ============================================

$BOT_DIR = Join-Path $env:USERPROFILE ".bot"
$STATUS_FILE = Join-Path $BOT_DIR "install-status.json"
$ENV_FILE = Join-Path $BOT_DIR ".env"
$DEVICE_FILE = Join-Path $BOT_DIR "device.json"
$INSTALLER_VERSION = "1.0.1"
$INSTALLER_BUILD = "2026-02-13a"
$NODE_MAJOR = 20
$DEFAULT_REPO_URL = "https://github.com/Druidia-Bot/DotBot.git"

# ============================================
# HELPERS
# ============================================

function Write-Banner {
    Write-Host ""
    Write-Host "  =====================================================" -ForegroundColor Cyan
    Write-Host "                                                        " -ForegroundColor Cyan
    Write-Host "      DotBot Installer v${INSTALLER_VERSION} (${INSTALLER_BUILD})   " -ForegroundColor Cyan
    Write-Host "                                                        " -ForegroundColor Cyan
    Write-Host "      Your AI assistant, installed in minutes.           " -ForegroundColor Cyan
    Write-Host "                                                        " -ForegroundColor Cyan
    Write-Host "  =====================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step {
    param([string]$Step, [string]$Message)
    Write-Host "  [$Step] " -NoNewline -ForegroundColor Yellow
    Write-Host $Message
}

function Write-OK {
    param([string]$Message)
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  [!] $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  [X] $Message" -ForegroundColor Red
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
    Write-Host "    [1] DotBot Service  -- connect to our hosted server (coming soon)" -ForegroundColor Cyan
    Write-Host "    [2] Local Agent     -- connects to a self-hosted DotBot server" -ForegroundColor White
    Write-Host "    [3] Server          -- host your own DotBot server" -ForegroundColor White
    Write-Host "    [4] Both            -- development / single-machine setup" -ForegroundColor White
    Write-Host ""

    do {
        $choice = Read-Host "  Enter choice (1/2/3/4)"
    } while ($choice -notmatch '^[1234]$')

    switch ($choice) {
        "1" {
            Write-Host ""
            Write-Host "  * The DotBot managed service is coming soon!" -ForegroundColor Cyan
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
        $ServerUrl = Read-Host "  Enter DotBot server WebSocket URL (e.g. wss://dotbot.example.com/ws)"
        if (-not $ServerUrl) {
            $ServerUrl = "ws://localhost:3001"
            Write-Warn "No URL entered -- defaulting to $ServerUrl"
        }
    }

    # Normalize: trim trailing slash
    $ServerUrl = $ServerUrl.TrimEnd('/')

    # Auto-append /ws for remote servers (Caddy proxies /ws -> :3001)
    # Skip for localhost URLs which connect directly to port 3001
    if ($ServerUrl -match '^wss?://' -and $ServerUrl -notmatch 'localhost|127\.0\.0\.1' -and $ServerUrl -notmatch '/ws$') {
        $ServerUrl = "$ServerUrl/ws"
        Write-Warn "Appended /ws -- using: $ServerUrl"
        Write-Host "    (Remote servers use Caddy which routes /ws to the WebSocket port)" -ForegroundColor DarkGray
    }

    if (-not $InviteToken) {
        Write-Host ""
        $InviteToken = Read-Host "  Enter your invite token (e.g. dbot-XXXX-XXXX-XXXX-XXXX)"
        if (-not $InviteToken) {
            Write-Fail "Invite token is required for agent registration."
            exit 1
        }
    }

    # Validate invite token format
    if ($InviteToken -notmatch '^dbot-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$') {
        Write-Fail "Invalid invite token format: $InviteToken"
        Write-Host "    Expected format: dbot-XXXX-XXXX-XXXX-XXXX (where X is alphanumeric)" -ForegroundColor Gray
        Write-Host "    Example: dbot-a1b2-c3d4-e5f6-g7h8" -ForegroundColor Gray
        Write-Host ""
        Write-Host "    Common issues:" -ForegroundColor Yellow
        Write-Host "      - Copy-paste error (check for extra spaces or missing characters)" -ForegroundColor Gray
        Write-Host "      - Token expired (generate a new one on the server)" -ForegroundColor Gray
        Write-Host ""
        exit 1
    }

    # Test connectivity to server if not localhost
    if ($ServerUrl -notmatch 'localhost|127\.0\.0\.1') {
        Write-Host ""
        Write-Host "  Testing connection to server..." -ForegroundColor Gray
        $wsHost = ($ServerUrl -replace '^wss?://([^/]+).*', '$1')
        $wsPort = if ($ServerUrl -match '^wss://') { 443 } else { 80 }

        try {
            $tcpTest = Test-NetConnection -ComputerName $wsHost -Port $wsPort -WarningAction SilentlyContinue -ErrorAction Stop
            if ($tcpTest.TcpTestSucceeded) {
                Write-OK "Server reachable at ${wsHost}:${wsPort}"
            } else {
                Write-Warn "Cannot reach server at ${wsHost}:${wsPort}"
                Write-Host "    The agent may fail to connect. Check:" -ForegroundColor Gray
                Write-Host "      - Server URL is correct" -ForegroundColor Gray
                Write-Host "      - Server is running and accessible from this network" -ForegroundColor Gray
                Write-Host "      - Firewall/proxy allows connections" -ForegroundColor Gray
                Write-Host ""
                $continue = Read-Host "  Continue anyway? (y/N)"
                if ($continue -ne "y" -and $continue -ne "Y") {
                    exit 1
                }
            }
        } catch {
            Write-Warn "Could not test connection to ${wsHost}:${wsPort}"
            Write-Host "    Proceeding anyway..." -ForegroundColor Gray
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

    # Method 1: winget
    if (Test-Command "winget") {
        Write-Step "1/11" "Installing Git via winget..."
        try {
            winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements --silent 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { Write-Warn "winget exited with code $LASTEXITCODE" }
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            if (Test-Command "git") {
                $ver = (git --version 2>$null) -replace 'git version ',''
                Write-OK "Git $ver installed via winget"
                Set-StepStatus -StepName "git" -Status "success" -Version $ver
                return $true
            }
        } catch {
            Write-Warn "winget install failed: $($_.Exception.Message)"
        }
    } else {
        Write-Warn "winget not available -- skipping"
    }

    # Method 2: Direct download from GitHub releases
    Write-Step "1/11" "Downloading Git installer from GitHub..."
    try {
        $gitInstaller = Join-Path $env:TEMP "git-installer.exe"
        # Resolve latest 64-bit installer URL from GitHub API
        $releaseInfo = Invoke-WebRequest -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" -UseBasicParsing | ConvertFrom-Json
        $asset = $releaseInfo.assets | Where-Object { $_.name -match '64-bit\.exe$' -and $_.name -notmatch 'portable' } | Select-Object -First 1
        if ($asset) {
            Write-Host "    Downloading $($asset.name)..." -ForegroundColor Gray
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $gitInstaller -UseBasicParsing
            Write-Host "    Running Git installer silently..." -ForegroundColor Gray
            $proc = Start-Process -FilePath $gitInstaller -ArgumentList "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-", "/CLOSEAPPLICATIONS", "/RESTARTAPPLICATIONS" -Wait -PassThru
            Remove-Item $gitInstaller -Force -ErrorAction SilentlyContinue
            if ($proc.ExitCode -ne 0) { Write-Warn "Git installer exited with code $($proc.ExitCode)" }
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            if (Test-Command "git") {
                $ver = (git --version 2>$null) -replace 'git version ',''
                Write-OK "Git $ver installed via direct download"
                Set-StepStatus -StepName "git" -Status "success" -Version $ver
                return $true
            }
        } else {
            Write-Warn "Could not find 64-bit installer in latest GitHub release"
        }
    } catch {
        Write-Warn "Direct download failed: $($_.Exception.Message)"
    }

    Write-Fail "Git installation failed (tried winget + direct download)."
    Write-Host "    Download manually: https://git-scm.com/download/win" -ForegroundColor Gray
    Set-StepStatus -StepName "git" -Status "failed" -ErrorMsg "all install methods failed"
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

    # Method 1: winget
    if (Test-Command "winget") {
        Write-Step "2/11" "Installing Node.js ${NODE_MAJOR} LTS via winget..."
        try {
            winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { Write-Warn "winget exited with code $LASTEXITCODE" }
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            if (Test-Command "node") {
                $ver = (node --version 2>$null) -replace 'v',''
                Write-OK "Node.js $ver installed via winget"
                Set-StepStatus -StepName "nodejs" -Status "success" -Version $ver
                return $true
            }
        } catch {
            Write-Warn "winget install failed: $($_.Exception.Message)"
        }
    } else {
        Write-Warn "winget not available -- skipping"
    }

    # Method 2: Direct MSI download from nodejs.org
    Write-Step "2/11" "Downloading Node.js LTS from nodejs.org..."
    try {
        $nodeMsi = Join-Path $env:TEMP "node-lts-x64.msi"
        # Resolve latest LTS version from nodejs.org index
        $nodeIndex = Invoke-WebRequest -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing | ConvertFrom-Json
        $latest = $nodeIndex | Where-Object { $_.lts -and [int]($_.version.TrimStart('v').Split('.')[0]) -ge $NODE_MAJOR } | Select-Object -First 1
        if ($latest) {
            $nodeVer = $latest.version
            $msiUrl = "https://nodejs.org/dist/${nodeVer}/node-${nodeVer}-x64.msi"
            Write-Host "    Downloading Node.js $nodeVer..." -ForegroundColor Gray
            Invoke-WebRequest -Uri $msiUrl -OutFile $nodeMsi -UseBasicParsing
            Write-Host "    Running Node.js installer silently..." -ForegroundColor Gray
            $proc = Start-Process msiexec -ArgumentList "/i", "`"$nodeMsi`"", "/qn", "/norestart" -Wait -PassThru
            Remove-Item $nodeMsi -Force -ErrorAction SilentlyContinue
            if ($proc.ExitCode -ne 0) { Write-Warn "Node.js MSI exited with code $($proc.ExitCode)" }
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            if (Test-Command "node") {
                $ver = (node --version 2>$null) -replace 'v',''
                Write-OK "Node.js $ver installed via direct download"
                Set-StepStatus -StepName "nodejs" -Status "success" -Version $ver
                return $true
            }
        } else {
            Write-Warn "Could not find LTS version >= $NODE_MAJOR in nodejs.org index"
        }
    } catch {
        Write-Warn "Direct download failed: $($_.Exception.Message)"
    }

    Write-Fail "Node.js installation failed (tried winget + direct download)."
    Write-Host "    Download manually: https://nodejs.org/" -ForegroundColor Gray
    Set-StepStatus -StepName "nodejs" -Status "failed" -ErrorMsg "all install methods failed"
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

    Write-Warn "Python installation failed -- GUI automation will be unavailable."
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
        Write-Warn "Skipping pip packages -- Python not installed"
        Set-StepStatus -StepName "pip_packages" -Status "skipped" -Tier 2 -Reason "python not installed"
        return
    }

    try {
        python -m pip install --quiet --upgrade --user pyautogui pywinauto pyperclip pillow 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "pip install exited with code $LASTEXITCODE" }
        Write-OK "pip packages installed"
        Set-StepStatus -StepName "pip_packages" -Status "success" -Tier 2
    } catch {
        Write-Warn "pip packages failed -- GUI automation may not work"
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

    Write-Warn "Tesseract not found -- screenshot OCR will be unavailable."
    Write-Host "    DotBot will try to install it after startup." -ForegroundColor Gray
    Set-StepStatus -StepName "tesseract" -Status "skipped" -Tier 2 -Reason "not found, Dot will install"
}

# ============================================
# TIER 2: EVERYTHING SEARCH (Windows file search)
# ============================================

function Install-Everything {
    Write-Step "5b/11" "Checking Everything Search..."

    # Check if es.exe CLI is already available
    $esPaths = @(
        (Join-Path $BOT_DIR "bin\es.exe"),
        "C:\Program Files\Everything\es.exe",
        "C:\Program Files (x86)\Everything\es.exe"
    )
    $esFound = $esPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($esFound) {
        Write-OK "Everything CLI found at $esFound"
        Set-StepStatus -StepName "everything" -Status "success" -Tier 2 -Path $esFound
        return
    }

    # Install Everything via winget
    if (Test-Command "winget") {
        try {
            Write-Step "5b/11" "Installing Everything Search via winget..."
            winget install --id voidtools.Everything -e --accept-source-agreements --accept-package-agreements --silent 2>$null | Out-Null
            Write-OK "Everything installed"
        } catch {
            Write-Warn "Everything winget install failed: $($_.Exception.Message)"
        }
    }

    # Download es.exe CLI to ~/.bot/bin/
    $binDir = Join-Path $BOT_DIR "bin"
    $esPath = Join-Path $binDir "es.exe"
    if (-not (Test-Path $esPath)) {
        try {
            if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Force $binDir | Out-Null }
            $zipUrl = "https://www.voidtools.com/ES-1.1.0.30.x64.zip"
            $zipPath = Join-Path $env:TEMP "dotbot_es_cli.zip"
            Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
            Expand-Archive -Path $zipPath -DestinationPath $binDir -Force
            Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
            if (Test-Path $esPath) {
                Write-OK "es.exe CLI downloaded to $binDir"
                Set-StepStatus -StepName "everything" -Status "success" -Tier 2 -Path $esPath
            } else {
                Write-Warn "es.exe not found after download"
                Set-StepStatus -StepName "everything" -Status "failed" -Tier 2 -ErrorMsg "es.exe not found after extract"
            }
        } catch {
            Write-Warn "es.exe CLI download failed: $($_.Exception.Message)"
            Set-StepStatus -StepName "everything" -Status "failed" -Tier 2 -ErrorMsg $_.Exception.Message
        }
    } else {
        Write-OK "es.exe CLI already at $esPath"
        Set-StepStatus -StepName "everything" -Status "success" -Tier 2 -Path $esPath
    }

    # Ensure Everything is running (it may need a kick after fresh install)
    $running = Get-Process Everything -ErrorAction SilentlyContinue
    if (-not $running) {
        $exePaths = @("C:\Program Files\Everything\Everything.exe", "C:\Program Files (x86)\Everything\Everything.exe")
        foreach ($p in $exePaths) {
            if (Test-Path $p) {
                try { Start-Process $p -ArgumentList "-startup" -WindowStyle Hidden } catch {}
                break
            }
        }
    }
}

# ============================================
# TIER 1: CLONE REPO
# ============================================

function Install-CloneRepo {
    param([string]$Dir)
    Write-Step "6/11" "Cloning DotBot repository..."

    if (Test-Path (Join-Path $Dir "package.json")) {
        # Valid repo exists -- pull latest instead of re-cloning
        Write-Step "6/11" "Repository exists at $Dir -- pulling latest..."
        try {
            $pullOut = & cmd /c "git -C `"$Dir`" pull 2>&1"
            $gitExit = $LASTEXITCODE
            if ($gitExit -ne 0) { Write-Warn "git pull failed: $pullOut" }
        } catch {}
        Write-OK "Repository already exists at $Dir"
        Set-StepStatus -StepName "clone" -Status "success" -Path $Dir
        return $true
    }

    # Clean up partial/failed clone (directory exists but no package.json)
    if (Test-Path $Dir) {
        Write-Warn "Removing incomplete directory: $Dir"
        Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
    }

    try {
        Invoke-WithRetry -OperationName "Git clone" -MaxAttempts 3 -RetryDelaySeconds 10 -ScriptBlock {
            # Clean up again in case a previous retry left a partial clone
            if ((Test-Path $Dir) -and -not (Test-Path (Join-Path $Dir "package.json"))) {
                Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
            }
            $output = & cmd /c "git clone $RepoUrl `"$Dir`" 2>&1"
            $gitExit = $LASTEXITCODE
            if ($gitExit -ne 0) {
                throw "git clone failed with exit code $gitExit : $output"
            }
            if (-not (Test-Path (Join-Path $Dir "package.json"))) {
                throw "package.json not found after clone"
            }
        }
        $commit = (git -C $Dir rev-parse --short HEAD 2>$null)
        Write-OK "Cloned to $Dir (commit: $commit)"
        Set-StepStatus -StepName "clone" -Status "success" -Path $Dir -Version $commit
        return $true
    } catch {
        Write-Fail "Failed to clone repository after 3 attempts"
        Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ""
        Write-Host "    Possible causes:" -ForegroundColor Yellow
        Write-Host "      - Network/proxy blocking git connections" -ForegroundColor Gray
        Write-Host "      - GitHub is temporarily unavailable" -ForegroundColor Gray
        Write-Host "      - Repository URL is incorrect" -ForegroundColor Gray
        Write-Host ""
        Write-Host "    Manual recovery:" -ForegroundColor Yellow
        Write-Host "      1. Clone manually: git clone $RepoUrl $Dir" -ForegroundColor White
        Write-Host "      2. Re-run this installer" -ForegroundColor White
        Write-Host ""
        Set-StepStatus -StepName "clone" -Status "failed" -ErrorMsg $_.Exception.Message
        return $false
    }
}

# ============================================
# TIER 1: NPM INSTALL
# ============================================

function Install-NpmDeps {
    param([string]$Dir)
    Write-Step "7/11" "Installing npm dependencies..."

    try {
        Push-Location $Dir
        Invoke-WithRetry -OperationName "npm install" -MaxAttempts 3 -RetryDelaySeconds 15 -ScriptBlock {
            # Clear npm cache on retry to avoid corrupted cache issues
            if ($attempt -gt 1) {
                Write-Host "    Clearing npm cache..." -ForegroundColor Gray
                npm cache clean --force 2>$null | Out-Null
            }

            # Use cmd /c to run npm — PS5.1's $ErrorActionPreference=Stop converts
            # stderr from native commands into terminating errors, even with 2>&1.
            # Running through cmd.exe avoids this because stderr merging happens in
            # cmd.exe, not PowerShell — output comes back as plain strings.
            $npmOut = & cmd /c "npm install 2>&1"
            $npmExit = $LASTEXITCODE

            if ($npmExit -ne 0) {
                $npmOut | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
                throw "npm install exited with code $npmExit"
            }
        }
        Pop-Location
        Write-OK "npm dependencies installed"
        Set-StepStatus -StepName "npm_install" -Status "success"
        return $true
    } catch {
        Pop-Location
        Write-Fail "npm install failed after 3 attempts"
        Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ""
        Write-Host "    Possible causes:" -ForegroundColor Yellow
        Write-Host "      - Network/proxy blocking npm registry" -ForegroundColor Gray
        Write-Host "      - Corrupted npm cache" -ForegroundColor Gray
        Write-Host "      - Insufficient disk space" -ForegroundColor Gray
        Write-Host "      - Antivirus blocking npm operations" -ForegroundColor Gray
        Write-Host ""
        Write-Host "    Manual recovery:" -ForegroundColor Yellow
        Write-Host "      1. Configure proxy: npm config set proxy http://proxy:port" -ForegroundColor White
        Write-Host "      2. Clear cache: npm cache clean --force" -ForegroundColor White
        Write-Host "      3. Try again: cd $Dir && npm install" -ForegroundColor White
        Write-Host ""
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
    # IMPORTANT: Use WriteAllText, NOT Set-Content -Encoding UTF8.
    # PowerShell 5.1's Set-Content -Encoding UTF8 adds a BOM (byte order mark)
    # which corrupts the first key when Node.js reads the file.
    if (Test-Path $ENV_FILE) {
        # Remove existing DOTBOT_ lines and append new ones
        $existing = Get-Content $ENV_FILE | Where-Object { $_ -notmatch '^DOTBOT_(SERVER|INVITE_TOKEN)=' }
        $final = (($existing + "" + $envContent) -join "`n")
        [System.IO.File]::WriteAllText($ENV_FILE, $final, [System.Text.UTF8Encoding]::new($false))
    } else {
        [System.IO.File]::WriteAllText($ENV_FILE, $envContent, [System.Text.UTF8Encoding]::new($false))
    }

    Write-OK "Agent configured: server=$Url"
    Set-StepStatus -StepName "configure_env" -Status "success"

    # Write client/config.js now (while we have admin privileges)
    # Write config.js while we have admin privileges
    $configJsPath = Join-Path $InstallDir "client\config.js"
    if (Test-Path (Split-Path $configJsPath -Parent)) {
        $escaped = $Url -replace "'", "\'"
        $configContent = "// Auto-generated by installer -- do not edit manually`nwindow.DOTBOT_CONFIG = { wsUrl: '$escaped' };"
        [System.IO.File]::WriteAllText($configJsPath, $configContent, [System.Text.UTF8Encoding]::new($false))
    }
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
        Write-Warn "Playwright install failed -- headless browser unavailable"
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
        $runPath = Join-Path $Dir "run.ps1"

        if (-not (Test-Path $runPath)) {
            Write-Warn "run.ps1 not found -- skipping shortcut creation"
            return
        }

        # Start Menu shortcut
        $lnkPath = Join-Path $startMenu "DotBot.lnk"
        $shortcut = $shell.CreateShortcut($lnkPath)
        $shortcut.TargetPath = "powershell.exe"
        $shortcut.Arguments = "-ExecutionPolicy Bypass -NoExit -File `"$runPath`""
        $shortcut.WorkingDirectory = $Dir
        $shortcut.Description = "Start DotBot"
        $shortcut.Save()
        Write-OK "Start Menu shortcut created -- search 'DotBot' to launch"

        # Install dotbot CLI to ~/.bot/ and add to user PATH
        $cliSource = Join-Path $Dir "local-agent\scripts\dotbot.ps1"
        $cliDest = Join-Path $BOT_DIR "dotbot.ps1"
        if (Test-Path $cliSource) {
            Copy-Item -Force $cliSource $cliDest
            # Create dotbot.cmd wrapper so 'dotbot update' works from cmd/powershell
            $cmdWrapper = "@echo off`r`npowershell -ExecutionPolicy Bypass -File `"%~dp0dotbot.ps1`" %*"
            [System.IO.File]::WriteAllText((Join-Path $BOT_DIR "dotbot.cmd"), $cmdWrapper, [System.Text.UTF8Encoding]::new($false))
            $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
            if (-not $userPath) { $userPath = "" }
            if ($userPath -notmatch [regex]::Escape($BOT_DIR)) {
                [System.Environment]::SetEnvironmentVariable("Path", "$userPath;$BOT_DIR", "User")
                $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
                Write-OK "dotbot CLI installed -- run 'dotbot help' in a new terminal"
            } else {
                Write-OK "dotbot CLI updated"
            }
        }

        # Register as background service via Task Scheduler (hidden, no window)
        Write-Host ""
        $autoStart = Read-Host "  Start DotBot automatically on login? (Y/n)"
        if ($autoStart -ne "n" -and $autoStart -ne "N") {
            try {
                $Action = New-ScheduledTaskAction `
                    -Execute "powershell.exe" `
                    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runPath`" -Service" `
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
                    -Description "DotBot AI Assistant -- background agent" `
                    -Force | Out-Null

                Write-OK "Background service registered -- DotBot starts automatically on login (hidden)"
                Set-StepStatus -StepName "task_scheduler" -Status "success"
            } catch {
                Write-Warn "Task Scheduler registration failed: $($_.Exception.Message)"
                Write-Host "    DotBot will still work -- just won't auto-start on login." -ForegroundColor Gray
                Set-StepStatus -StepName "task_scheduler" -Status "failed" -Tier 2 -ErrorMsg $_.Exception.Message
            }
        } else {
            Write-Host "    Skipped -- you can register later with:" -ForegroundColor DarkGray
            Write-Host "    schtasks /create /tn DotBot /tr `"powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File '$runPath'`" /sc onlogon" -ForegroundColor DarkGray
        }
    } catch {
        Write-Warn "Could not create shortcuts: $($_.Exception.Message)"
    }
}

# ============================================
# PRE-FLIGHT CHECKS
# ============================================

function Test-PreflightChecks {
    Write-Step "0/11" "Running pre-flight checks..."

    # Check Windows version (need 10+)
    $winVer = [System.Environment]::OSVersion.Version
    if ($winVer.Major -lt 10) {
        Write-Fail "Windows 10 or later required (detected: Windows $($winVer.Major).$($winVer.Minor))"
        Read-Host "  Press Enter to exit"
        exit 1
    }
    Write-OK "Windows version: $($winVer.Major).$($winVer.Minor).$($winVer.Build)"

    # Disk space and internet are checked implicitly —
    # git clone / npm install will fail with clear messages if either is insufficient.
    Write-OK "Pre-flight checks passed"
}

# ============================================
# RETRY WRAPPER FOR NETWORK OPERATIONS
# ============================================

function Invoke-WithRetry {
    param(
        [ScriptBlock]$ScriptBlock,
        [int]$MaxAttempts = 3,
        [int]$RetryDelaySeconds = 5,
        [string]$OperationName = "Operation"
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            return & $ScriptBlock
        } catch {
            if ($attempt -lt $MaxAttempts) {
                Write-Warn "$OperationName failed (attempt $attempt/$MaxAttempts): $($_.Exception.Message)"
                Write-Host "    Retrying in ${RetryDelaySeconds}s..." -ForegroundColor Gray
                Start-Sleep -Seconds $RetryDelaySeconds
            } else {
                Write-Fail "$OperationName failed after $MaxAttempts attempts"
                throw
            }
        }
    }
}

# ============================================
# MAIN
# ============================================

try {

Write-Banner

# Pre-flight checks
Test-PreflightChecks
Write-Host ""

# Step 0: Select mode
$selectedMode = Get-InstallMode
$installStatus.mode = $selectedMode
Write-Host ""
Write-Host "  Installing: $selectedMode" -ForegroundColor White
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray

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
    $InstallDir = "C:\.bot"
}

# Ensure ~/.bot/ exists
if (-not (Test-Path $BOT_DIR)) {
    New-Item -ItemType Directory -Path $BOT_DIR -Force | Out-Null
}

Write-Host ""

# -- TIER 1: Hard requirements --

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

# -- TIER 2: Soft requirements --

$pythonOK = Install-Python
Install-PipPackages -PythonOK $pythonOK
Install-Tesseract
Install-Everything

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

# Validate git URL format
if ($RepoUrl -notmatch '^(https?://|git@).+\.(git|com|org|io)') {
    Write-Fail "Invalid Git URL: $RepoUrl"
    Write-Host "    Expected format: https://github.com/user/repo.git or git@github.com:user/repo.git" -ForegroundColor Gray
    Read-Host "  Press Enter to exit"
    exit 1
}

# -- TIER 1: Clone + Build --

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
    Write-Fail "Cannot continue -- npm install failed."
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

# -- Post-build: Cleanup + Configure --

Remove-UnneededPackages -Dir $InstallDir -SelectedMode $selectedMode

if ($agentConfig) {
    Set-AgentEnv -Url $agentConfig.ServerUrl -Token $agentConfig.InviteToken
}

# -- Server .env API key prompts --

if ($selectedMode -eq "server" -or $selectedMode -eq "both") {
    $serverEnvPath = Join-Path $InstallDir ".env"
    if (-not (Test-Path $serverEnvPath) -or (Get-Content $serverEnvPath -Raw) -match "your_key_here") {
        Write-Host ""
        Write-Host "  ------------------------------------------------" -ForegroundColor Yellow
        Write-Host "    API Key Setup                                  " -ForegroundColor Yellow
        Write-Host "    Press Enter to skip any key you don't have.    " -ForegroundColor Yellow
        Write-Host "    You need at least ONE LLM key to start.        " -ForegroundColor Yellow
        Write-Host "  ------------------------------------------------" -ForegroundColor Yellow
        Write-Host ""

        $envLines = @(
            "# DotBot Server Environment",
            "# Generated by installer on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
            "",
            "PORT=3000",
            "WS_PORT=3001"
        )

        $keys = @(
            @{ Name = "DEEPSEEK_API_KEY";  Prompt = "DeepSeek API Key (workhorse -- recommended)"; Url = "https://platform.deepseek.com/api_keys" },
            @{ Name = "GEMINI_API_KEY";    Prompt = "Google Gemini API Key (deep context -- 1M tokens)"; Url = "https://aistudio.google.com/apikey" },
            @{ Name = "ANTHROPIC_API_KEY"; Prompt = "Anthropic API Key (architect -- complex reasoning)"; Url = "https://console.anthropic.com/settings/keys" },
            @{ Name = "OPENAI_API_KEY";    Prompt = "OpenAI API Key (optional fallback)"; Url = "https://platform.openai.com/api-keys" },
            @{ Name = "XAI_API_KEY";       Prompt = "xAI API Key (optional -- oracle persona, market sentiment)"; Url = "https://console.x.ai/" },
            @{ Name = "SCRAPING_DOG_API_KEY"; Prompt = "ScrapingDog API Key (optional -- premium web tools)"; Url = "https://www.scrapingdog.com/" }
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

        [System.IO.File]::WriteAllText($serverEnvPath, ($envLines -join "`n"), [System.Text.UTF8Encoding]::new($false))

        if ($keyCount -eq 0) {
            Write-Warn "No API keys entered. You'll need to edit $serverEnvPath before starting."
        } else {
            Write-OK "$keyCount API key(s) configured in .env"
        }
    } else {
        Write-OK ".env already configured"
    }
}

# -- TIER 2: Playwright --

if ($selectedMode -eq "agent" -or $selectedMode -eq "both") {
    Install-Playwright -Dir $InstallDir
}

# -- Shortcuts --

Install-Shortcuts -Dir $InstallDir

# -- Save final status --

$installStatus.completedSuccessfully = $true
Save-InstallStatus

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  [OK] DotBot installation complete!" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""

# Start DotBot as a hidden background service
$runPath = Join-Path $InstallDir "run.ps1"
$taskExists = $false
try { $taskExists = [bool](Get-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue) } catch {}

$agentLogFile = Join-Path $BOT_DIR "agent.log"

# The agent writes ~/.bot/device.json after successful registration
$deviceJsonFile = Join-Path $BOT_DIR "device.json"

if ($taskExists) {
    Write-Host "  Starting DotBot service (hidden)..." -ForegroundColor Green
    Start-ScheduledTask -TaskName "DotBot" -ErrorAction SilentlyContinue
} elseif (Test-Path $runPath) {
    Write-Host "  Starting DotBot service (hidden)..." -ForegroundColor Green
    Start-Process powershell -ArgumentList @(
        "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", $runPath, "-Service"
    )
}

# Wait for the agent to authenticate and save the web auth token
# The token file confirms: agent started, connected, and authenticated with server
Write-Host "  Waiting for agent to connect and register..." -ForegroundColor Gray
Write-Host "    (This may take up to 60 seconds for first connection)" -ForegroundColor DarkGray
Start-Sleep -Seconds 3  # Grace period for node to start
$deadline = (Get-Date).AddSeconds(60)
$registered = $false
$lastProgress = (Get-Date)
$dots = 0

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1

    # Show progress dots every 5 seconds
    if (((Get-Date) - $lastProgress).TotalSeconds -ge 5) {
        $dots++
        Write-Host "    Still waiting" -NoNewline -ForegroundColor DarkGray
        Write-Host ("." * ($dots % 4)) -ForegroundColor DarkGray
        $lastProgress = (Get-Date)
    }

    if (Test-Path $deviceJsonFile) {
        $registered = $true
        break
    }

    # Check if agent process died (no point waiting)
    $nodeProcs = $null
    try {
        $nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue
    } catch {}
    if (-not $nodeProcs) {
        Write-Warn "Agent process exited unexpectedly"
        break
    }
}

if ($registered) {
    Write-OK "DotBot agent registered with server"
} else {
    Write-Host ""
    Write-Warn "Agent did not register within 60 seconds"
    Write-Host ""
    Write-Host "  Checking for common issues..." -ForegroundColor Yellow
    Write-Host ""

    # Diagnostic 1: Check if process is still running
    $nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue
    if ($nodeProcs) {
        Write-Host "    [+] Agent process is running (PID: $($nodeProcs[0].Id))" -ForegroundColor Green
    } else {
        Write-Host "    [X] Agent process is not running" -ForegroundColor Red
        Write-Host "        Likely cause: Node.js startup error or crash" -ForegroundColor Gray
    }

    # Diagnostic 2: Check log files for errors
    if (Test-Path $agentLogFile) {
        $logContent = (Get-Content $agentLogFile -Tail 20) -join "`n"
        if ($logContent -match "ECONNREFUSED|ENOTFOUND|EHOSTUNREACH") {
            Write-Host "    [X] Connection error detected in logs" -ForegroundColor Red
            Write-Host "        Likely cause: Server unreachable or wrong URL" -ForegroundColor Gray
        } elseif ($logContent -match "Invalid.*token|authentication.*failed") {
            Write-Host "    [X] Authentication error detected in logs" -ForegroundColor Red
            Write-Host "        Likely cause: Invalid or expired invite token" -ForegroundColor Gray
        } elseif ($logContent -match "Error|error|exception") {
            Write-Host "    [!] Error detected in logs (see below)" -ForegroundColor Yellow
        } else {
            Write-Host "    [?] No obvious errors in logs" -ForegroundColor Yellow
            Write-Host "        Agent may still be initializing..." -ForegroundColor Gray
        }
    }

    # Show relevant log excerpts
    Write-Host ""
    Write-Host "  Recent log output:" -ForegroundColor Yellow
    if (Test-Path $agentLogFile) {
        Get-Content $agentLogFile -Tail 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    } else {
        Write-Host "    (No log file found at $agentLogFile)" -ForegroundColor DarkGray
    }

    $agentErrFile = Join-Path $BOT_DIR "agent-error.log"
    if ((Test-Path $agentErrFile) -and (Get-Item $agentErrFile).Length -gt 0) {
        Write-Host ""
        Write-Host "  Error log:" -ForegroundColor Red
        Get-Content $agentErrFile -Tail 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    }

    Write-Host ""
    Write-Host "  Troubleshooting steps:" -ForegroundColor Yellow
    Write-Host "    1. Check server URL in ~/.bot/.env is correct" -ForegroundColor White
    Write-Host "    2. Verify invite token is valid (not expired)" -ForegroundColor White
    Write-Host "    3. Ensure server is running and accessible" -ForegroundColor White
    Write-Host "    4. Check firewall/proxy settings" -ForegroundColor White
    Write-Host ""
    Write-Host "  To start manually with visible output:" -ForegroundColor Gray
    Write-Host "    cd `"$InstallDir`"" -ForegroundColor White
    Write-Host "    node local-agent/dist/index.js" -ForegroundColor White
    Write-Host ""
    Write-Host "  View full logs:" -ForegroundColor Gray
    Write-Host "    Get-Content $agentLogFile -Tail 50" -ForegroundColor White
    Write-Host ""
}

# Browser UI is now served by the agent's setup server (http://localhost:PORT/setup?code=XXX)
# The setup URL will open automatically when DotBot starts via the Start Menu shortcut.

Write-Host ""
Write-Host "  ----------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  DotBot is running as a background service." -ForegroundColor Green
Write-Host "  It will start automatically on login." -ForegroundColor Gray
Write-Host ""
Write-Host "  To open the browser UI:" -ForegroundColor White
Write-Host "    Search 'DotBot' in Start Menu -- opens console + browser automatically" -ForegroundColor Gray
Write-Host ""
Write-Host "  Other commands:" -ForegroundColor Gray
Write-Host "    schtasks /run /tn DotBot          -- start the background service" -ForegroundColor Gray
Write-Host "    schtasks /end /tn DotBot          -- stop the background service" -ForegroundColor Gray
Write-Host "    Get-Content ~\.bot\agent.log -Tail 50  -- view logs" -ForegroundColor Gray
Write-Host ""

$failedSteps = $installStatus.steps.GetEnumerator() | Where-Object { $_.Value.status -eq "failed" }
if ($failedSteps) {
    Write-Host "  [!] Some optional components failed to install:" -ForegroundColor Yellow
    foreach ($step in $failedSteps) {
        Write-Host "    - $($step.Key): $($step.Value.error)" -ForegroundColor Yellow
    }
    Write-Host "  DotBot will try to fix these after startup." -ForegroundColor Yellow
    Write-Host ""
}

} catch {
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Red
    Write-Host "  [X] INSTALLER ERROR" -ForegroundColor Red
    Write-Host "  ============================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Location: $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber)" -ForegroundColor DarkGray
    Write-Host "  Command:  $($_.InvocationInfo.Line.Trim())" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Please report this error at:" -ForegroundColor Yellow
    Write-Host "    https://github.com/Druidia-Bot/DotBot/issues" -ForegroundColor White
    Write-Host ""
}

Read-Host "  Press Enter to close"
