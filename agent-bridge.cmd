@echo off
setlocal
rem Agent Bridge launcher. Usage:
rem   agent-bridge.cmd                        (asks for the project folder)
rem   agent-bridge.cmd --cwd C:\path\to\repo [--main codex] [--port 4517] [--no-open]
rem   agent-bridge.cmd --resume               (reopen the last conversation)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required: https://nodejs.org
  pause
  exit /b 1
)

if not "%~1"=="" goto withargs

set "WORKDIR="
set /p "WORKDIR=Project folder (Enter = %CD%): "
if not defined WORKDIR set "WORKDIR=%CD%"
node "%~dp0src\server.mjs" --cwd "%WORKDIR%"
goto done

:withargs
node "%~dp0src\server.mjs" %*

:done
if errorlevel 1 pause
endlocal
