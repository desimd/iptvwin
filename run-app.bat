@echo off
rem Runs the app straight from source (no .exe needed). Needs Node.js.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules call npm install
call npm start
