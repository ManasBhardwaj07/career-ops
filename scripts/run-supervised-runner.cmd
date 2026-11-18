@echo off
rem Career-Ops Supervised Scheduled Pipeline Runner
rem Enforces supervised staging mode with auto-submission disabled
set "REPO_ROOT=%~dp0.."
cd /d "%REPO_ROOT%"
node "%~dp0recurring-runner.mjs" --once >> "%REPO_ROOT%\data\runs\scheduled-runner.log" 2>&1
