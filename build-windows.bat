@echo off
rem Builds the Windows installer + portable .exe into the "dist" folder.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org , install it, then run this again.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 goto :fail
call npm run dist
if errorlevel 1 goto :fail
echo.
echo Done. Your files are in the "dist" folder:
echo   TaZ-IPTV-Setup-*.exe     (installer)
echo   TaZ-IPTV-Portable-*.exe  (single file, no install - good for USB / sharing)
start "" dist
pause
exit /b 0
:fail
echo Build failed - see the messages above.
pause
exit /b 1
