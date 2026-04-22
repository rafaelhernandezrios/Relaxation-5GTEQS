@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0.."

where node >nul 2>&1
if errorlevel 1 (
  echo demo: Install Node.js LTS from https://nodejs.org/
  exit /b 1
)
where bash >nul 2>&1
if errorlevel 1 (
  echo demo: Git Bash is required ^(install "Git for Windows"^) so bash scripts can run.
  echo Or run this repo from WSL:  bash scripts/demo.sh
  exit /b 1
)

bash "%~dp0demo.sh"
exit /b %ERRORLEVEL%
