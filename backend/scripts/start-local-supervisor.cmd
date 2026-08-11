@echo off
setlocal
cd /d "%~dp0.."
if not exist "%~dp0..\logs" mkdir "%~dp0..\logs"
"%ProgramFiles%\nodejs\node.exe" scripts\supervisor.js > logs\local-supervisor.stdout.log 2> logs\local-supervisor.stderr.log
