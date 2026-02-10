@echo off
echo.
echo ========================================
echo    DotBot Shutdown
echo ========================================
echo.

echo Killing processes on ports 3000 and 3001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 :3001" ^| findstr "LISTENING"') do (
    echo   Killing PID %%a
    taskkill /PID %%a /F >nul 2>&1
)

echo.
echo Killing node processes in dotbot folder...
for /f "tokens=2" %%a in ('wmic process where "name='node.exe'" get processid^,commandline 2^>nul ^| findstr /i "dotbot"') do (
    echo   Killing node PID %%a
    taskkill /PID %%a /F >nul 2>&1
)

echo.
echo ========================================
echo    DotBot stopped (Chrome untouched)
echo ========================================
echo.
pause
