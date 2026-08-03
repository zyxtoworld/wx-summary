@echo off
chcp 65001 > nul
cd /d "%~dp0"

where node > nul 2> nul
if errorlevel 1 (
  echo node not found. Please install Node.js 20+.
  pause > nul
  exit /b 1
)

for /f "usebackq delims=" %%v in (`node -p "Number(process.versions.node.split('.')[0])" 2^>nul`) do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
  echo Unable to read Node.js version. Please install Node.js 20+.
  pause > nul
  exit /b 1
)
if %NODE_MAJOR% LSS 20 (
  echo Current Node.js version is too old. Please install Node.js 20+.
  pause > nul
  exit /b 1
)

set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" (
  echo Trusted Windows PowerShell was not found.
  pause > nul
  exit /b 1
)
"%POWERSHELL_EXE%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-dependencies.ps1"
if errorlevel 1 (
  echo Dependency setup failed. Check the message above and retry.
  pause > nul
  exit /b 1
)

if /i "%~1"=="--console" (
  node src\main.js
  exit /b %errorlevel%
)

start "" "%SystemRoot%\System32\wscript.exe" "%~dp0scripts\start-tray-hidden.vbs"
exit /b 0
