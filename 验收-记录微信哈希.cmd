@echo off
chcp 65001 > nul
cd /d "%~dp0"
title wx-summary A3 baseline
echo wx-summary A3 external baseline
echo.
echo Run this file before starting wx-summary.
echo It records the current Weixin.exe SHA256 into:
echo data\external-weixin-binary-baseline.json
echo.

where node > nul 2> nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js 20+ first.
  pause
  exit /b 1
)

node scripts\capture-weixin-binary-evidence.mjs --source external_user_prelaunch --out data\external-weixin-binary-baseline.json
if errorlevel 1 (
  echo Failed to record the baseline. Please make sure Weixin is running.
  pause
  exit /b 1
)

echo Baseline written to data\external-weixin-binary-baseline.json
echo Now start wx-summary with the normal launcher in the project root.
pause
