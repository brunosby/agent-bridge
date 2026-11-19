@echo off
setlocal
rem Agent Bridge launcher with a console window. Usage:
rem   agent-bridge.cmd                         (asks for the project folder)
rem   agent-bridge.cmd --cwd <folder> [--port <n>] [--no-open]
rem   agent-bridge.cmd --resume                (reopen the last conversation)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.18+ is required.
  pause
  exit /b 1
)

if not "%~1"=="" goto withargs

set "WORKDIR="
set /p "WORKDIR=Project folder (Enter = %CD%): "
if not defined WORKDIR set "WORKDIR=%CD%"
node "%~dp0bin\agent-bridge.mjs" --cwd "%WORKDIR%"
goto done

:withargs
node "%~dp0bin\agent-bridge.mjs" %*

:done
if errorlevel 1 pause
endlocal
