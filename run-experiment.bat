@echo off
cd /d "%~dp0"
if not exist cert.pem (
  echo Run: npm run cert
  exit /b 1
)
if not exist key.pem (
  echo Run: npm run cert
  exit /b 1
)
call npm run experiment
