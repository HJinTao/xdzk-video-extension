@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 20.11 or later, then open this launcher again.
  pause
  exit /b 1
)
node "%~dp0scripts\mobile-server.mjs"
if errorlevel 1 pause
