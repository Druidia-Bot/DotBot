<#
.SYNOPSIS
    Syncs the DotBot source into the DotBot-OpenSource sibling directory for public release.
    
.DESCRIPTION
    Copies all source files while excluding:
    - .git/              (target has its own repo)
    - node_modules/      (users run npm install)
    - dist/ / build/     (build artifacts)
    - .env               (secrets)
    - *.key, *.pem       (crypto keys)
    - *.db, *.sqlite*    (databases)
    - *.log, logs/       (runtime logs)
    - docs/internal-notes/  (private dev notes)
    - test-output.txt    (test artifacts)
    - .dotbot/           (runtime data)
    - .vscode/           (IDE config)
    - coverage/          (test coverage)
    - tmp/, temp/        (temp files)
    
    The target directory must already exist (and should already have its own git repo).
    Files that no longer exist in source are removed from the target (mirror sync).

.EXAMPLE
    .\release-opensource.ps1
    .\release-opensource.ps1 -DryRun
    .\release-opensource.ps1 -Target "C:\other\path\DotBot-OpenSource"
#>

param(
    [string]$Target = (Join-Path (Split-Path $PSScriptRoot -Parent) "DotBot-OpenSource"),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Source = $PSScriptRoot

# ── Validate ──────────────────────────────────────────────
if (-not (Test-Path $Target)) {
    Write-Error "Target directory does not exist: $Target`nCreate it first (with its own git repo)."
    exit 1
}

if (-not (Test-Path (Join-Path $Target ".git"))) {
    Write-Warning "Target has no .git/ directory. Are you sure this is the right target?"
    $confirm = Read-Host "Continue anyway? (y/N)"
    if ($confirm -ne "y") { exit 0 }
}

# ── Exclusions ────────────────────────────────────────────
# Robocopy /XD = exclude directories, /XF = exclude files
$excludeDirs = @(
    ".git"
    "node_modules"
    "dist"
    "build"
    "logs"
    "coverage"
    ".nyc_output"
    "tmp"
    "temp"
    "internal-notes"
    "upcoming-features"
    ".dotbot"
    ".vscode"
)

$excludeFiles = @(
    ".env"
    ".env.local"
    ".env.*.local"
    "*.key"
    "*.pem"
    "*.db"
    "*.sqlite"
    "*.sqlite3"
    "*.log"
    "*.pid"
    "*.seed"
    "*.pid.lock"
    "*.tsbuildinfo"
    "*.tmp"
    "*.swp"
    "*.swo"
    "*~"
    "test-output.txt"
    "agent.log"
    "server.log"
    ".DS_Store"
    "Thumbs.db"
    "Desktop.ini"
)

# ── Sync ──────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  DotBot Open Source Release Sync" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Source:  $Source"
Write-Host "  Target:  $Target"
Write-Host ""

if ($DryRun) {
    Write-Host "  MODE: DRY RUN (no changes)" -ForegroundColor Yellow
    Write-Host ""
}

# Build robocopy args
# /MIR    = mirror (copy new/changed, delete removed)
# /XD     = exclude directories
# /XF     = exclude files
# /NFL    = no file list (less noise)
# /NDL    = no directory list
# /NJH    = no job header
# /NJS    = no job summary  
# /NC     = no file class
# /NS     = no file size
$roboArgs = @(
    $Source
    $Target
    "/MIR"
    "/XD"
) + $excludeDirs + @(
    "/XF"
) + $excludeFiles

if ($DryRun) {
    $roboArgs += "/L"  # List only, don't copy
}

# Robocopy uses non-standard exit codes: 0-7 = success, 8+ = error
Write-Host "Syncing files..." -ForegroundColor Green
$result = robocopy @roboArgs

# Show what happened
if ($DryRun) {
    Write-Host ""
    Write-Host "Files that WOULD be synced:" -ForegroundColor Yellow
    $result | Where-Object { $_ -match "\S" } | ForEach-Object { Write-Host "  $_" }
}

# Robocopy exit codes: 0=no change, 1=copied, 2=extras deleted, 4=mismatches, 8+=errors
if ($LASTEXITCODE -ge 8) {
    Write-Error "Robocopy failed with exit code $LASTEXITCODE"
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
if ($DryRun) {
    Write-Host "  Dry run complete. No files changed." -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
} else {
    Write-Host "  Sync complete!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""

    # ── Commit & Push ─────────────────────────────────────
    Push-Location $Target
    try {
        git add -A 2>$null
        $status = git status --porcelain 2>$null
        if ($status) {
            $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
            $commitMsg = "release: sync from source ($timestamp)"
            Write-Host "Committing changes..." -ForegroundColor Green
            git commit -m $commitMsg
            Write-Host ""
            Write-Host "Pushing to remote..." -ForegroundColor Green
            git push
            Write-Host ""
            Write-Host "========================================" -ForegroundColor Green
            Write-Host "  Committed and pushed!" -ForegroundColor Green
            Write-Host "  $commitMsg" -ForegroundColor Cyan
            Write-Host "========================================" -ForegroundColor Green
        } else {
            Write-Host "  No changes to commit." -ForegroundColor Yellow
        }
    } finally {
        Pop-Location
    }
    Write-Host ""
}
