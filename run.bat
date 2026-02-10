@echo off
echo.
echo ========================================
echo    DotBot Debug Runner
echo ========================================
echo.

cd /d "%~dp0"

echo Cleaning up any existing instances...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 :3001" ^| findstr "LISTENING"') do (
    echo Killing process %%a
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak > nul

echo Starting server in new window...
start "DotBot Server" cmd /k "cd /d %~dp0server && npm run dev"

echo Waiting for server to start...
timeout /t 3 /nobreak > nul

echo Opening client interface...
start "" "%~dp0client\index.html"

echo Starting local agent...
echo.
echo ========================================
echo   Press Ctrl+C to stop the agent
echo   Close the server window separately
echo   Or run stop.bat to kill everything
echo ========================================
echo.
cd local-agent
npm run dev
