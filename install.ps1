<#
.SYNOPSIS
    DotBot Installation Script
.DESCRIPTION
    Installs dependencies and builds all packages in the correct order.
#>

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║           DotBot Installation Script                  ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Step 1: Install root dependencies (workspaces)
Write-Host "[1/7] Installing workspace dependencies..." -ForegroundColor Yellow
Set-Location $Root
npm install
if ($LASTEXITCODE -ne 0) { throw "Failed to install root dependencies" }
Write-Host "  ✓ Root dependencies installed" -ForegroundColor Green

# Step 2: Install Playwright Chromium browser (for GUI automation)
Write-Host ""
Write-Host "[2/7] Installing Playwright Chromium browser..." -ForegroundColor Yellow
Set-Location "$Root\local-agent"
npx playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Host "  ⚠ Playwright browser install failed (GUI automation will be unavailable)" -ForegroundColor DarkYellow } else { Write-Host "  ✓ Playwright Chromium installed" -ForegroundColor Green }

# Step 3: Install Python desktop automation dependencies
Write-Host ""
Write-Host "[3/7] Installing Python desktop automation packages..." -ForegroundColor Yellow
try {
    $pythonVer = python --version 2>&1
    Write-Host "  Found: $pythonVer" -ForegroundColor Gray
    python -m pip install pyautogui pywinauto Pillow comtypes pytesseract --user --quiet 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ⚠ Python packages install failed (desktop GUI automation will be limited)" -ForegroundColor DarkYellow
    } else {
        Write-Host "  ✓ Python packages installed (pyautogui, pywinauto, pytesseract)" -ForegroundColor Green
    }
} catch {
    Write-Host "  ⚠ Python not found — desktop GUI automation will be unavailable" -ForegroundColor DarkYellow
    Write-Host "    Install Python 3.9+ from https://python.org" -ForegroundColor Gray
}

# Step 4: Build shared package first (others depend on it)
Write-Host ""
Write-Host "[4/7] Building @dotbot/shared..." -ForegroundColor Yellow
Set-Location "$Root\shared"
npm run build
if ($LASTEXITCODE -ne 0) { throw "Failed to build shared package" }
Write-Host "  ✓ Shared package built" -ForegroundColor Green

# Step 5: Build local-agent
Write-Host ""
Write-Host "[5/7] Building dotbot-local..." -ForegroundColor Yellow
Set-Location "$Root\local-agent"
npm run build
if ($LASTEXITCODE -ne 0) { throw "Failed to build local-agent" }
Write-Host "  ✓ Local agent built" -ForegroundColor Green

# Step 6: Build server
Write-Host ""
Write-Host "[6/7] Building dotbot-server..." -ForegroundColor Yellow
Set-Location "$Root\server"
npm run build
if ($LASTEXITCODE -ne 0) { throw "Failed to build server" }
Write-Host "  ✓ Server built" -ForegroundColor Green

# Step 7: Auto-install Tesseract OCR (for desktop GUI vision)
Write-Host ""
Write-Host "[7/7] Checking Tesseract OCR engine..." -ForegroundColor Yellow
$tesseractPath = Join-Path $env:USERPROFILE ".bot\tesseract\tesseract.exe"
if (Test-Path $tesseractPath) {
    Write-Host "  ✓ Tesseract OCR already installed" -ForegroundColor Green
} else {
    Write-Host "  Tesseract will be auto-downloaded on first GUI use (or run the agent to trigger install)" -ForegroundColor Gray
}

# Done
Set-Location $Root
Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║           Installation Complete!                      ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Set your ANTHROPIC_API_KEY environment variable" -ForegroundColor Gray
Write-Host "  2. Run: .\run.ps1" -ForegroundColor Gray
Write-Host ""
