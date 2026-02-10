@echo off
echo.
echo ========================================
echo    DotBot Installation
echo ========================================
echo.

cd /d "%~dp0"

echo [1/7] Installing dependencies...
call npm install
if errorlevel 1 goto :error

echo [2/7] Installing Playwright Chromium browser...
cd local-agent
call npx playwright install chromium
if errorlevel 1 (
  echo   WARNING: Playwright browser install failed - GUI automation will be unavailable
) else (
  echo   Playwright Chromium installed
)
cd ..

echo [3/7] Installing Python desktop automation packages...
python --version >nul 2>&1
if errorlevel 1 (
  echo   WARNING: Python not found - desktop GUI automation will be unavailable
  echo   Install Python 3.9+ from https://python.org
) else (
  python -m pip install pyautogui pywinauto Pillow comtypes pytesseract --user --quiet >nul 2>&1
  if errorlevel 1 (
    echo   WARNING: Python packages install failed
  ) else (
    echo   Python packages installed (pyautogui, pywinauto, pytesseract)
  )
)

echo [4/7] Building shared...
cd shared
call npm run build
if errorlevel 1 goto :error
cd ..

echo [5/7] Building local-agent...
cd local-agent
call npm run build
if errorlevel 1 goto :error
cd ..

echo [6/7] Building server...
cd server
call npm run build
if errorlevel 1 goto :error
cd ..

echo [7/7] Checking Tesseract OCR engine...
if exist "%USERPROFILE%\.bot\tesseract\tesseract.exe" (
  echo   Tesseract OCR already installed
) else (
  echo   Tesseract will be auto-downloaded on first GUI use
)

echo.
echo ========================================
echo    Installation Complete!
echo ========================================
echo.
echo Next: Run "run.bat" or ".\run.ps1"
echo.
pause
goto :eof

:error
echo.
echo ERROR: Build failed!
pause
exit /b 1
