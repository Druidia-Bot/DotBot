@echo off
echo.
echo ========================================
echo    DotBot Dev Mode
echo ========================================
echo.

cd /d "%~dp0"

echo Cleaning up any existing instances...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 :3001" ^| findstr "LISTENING"') do (
    echo   Killing PID %%a
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 2 /nobreak > nul

echo.
echo Starting server (minimized)...
start /min "DotBot Server" cmd /k "cd /d %~dp0server && npm run dev"

echo Waiting for server to start...
timeout /t 4 /nobreak > nul

echo Opening client...
start "" "%~dp0client\index.html"

echo Starting agent (minimized)...
start /min "DotBot Agent" cmd /k "cd /d %~dp0local-agent && npm run dev"

echo.
echo ========================================
echo   All components started (minimized)
echo   - Server:  minimized window "DotBot Server"
echo   - Agent:   minimized window "DotBot Agent"
echo   - Client:  Browser
echo.
echo   Run stop.bat to kill everything
echo ========================================
echo.
pause
