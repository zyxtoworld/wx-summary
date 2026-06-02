@echo off
chcp 65001 > nul
cd /d "%~dp0"

if /i "%~1"=="--console" (
  node src\main.js
  exit /b %errorlevel%
)

if not exist "node_modules\" (
  title wx-summary setup
  echo First start: installing dependencies...
  where npm > nul 2> nul
  if not errorlevel 1 (
    call npm ci
  ) else (
    where corepack > nul 2> nul
    if errorlevel 1 (
      echo npm/corepack not found. Please install Node.js 20+.
      pause > nul
      exit /b 1
    )
    call corepack npm ci
  )
  if errorlevel 1 (
    echo Dependency install failed. Check network and retry.
    pause > nul
    exit /b 1
  )
)

start "" "%SystemRoot%\System32\wscript.exe" //B "%~dp0scripts\start-tray-hidden.vbs"
exit /b 0
