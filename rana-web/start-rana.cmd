@echo off
rem Rana Web one-click start: gateway(18789) + vite(5173) + open browser.
rem Already-running services are skipped; safe to re-run.
rem All paths resolve relative to this script - no edits needed when the
rem repo moves. Optional machine overrides: local-overrides.cmd (gitignored).
rem NOTE: keep this file ASCII-only (cmd.exe parses batch in system codepage).
setlocal
if exist "%~dp0local-overrides.cmd" call "%~dp0local-overrides.cmd"
rem State dir: env var wins, otherwise <repo>\.openclaw\.openclaw (same as start-gateway.cmd)
if not defined OPENCLAW_STATE_DIR set "OPENCLAW_STATE_DIR=%~dp0..\..\.openclaw\.openclaw"
rem 1) start gateway if not running (reuses start-gateway.cmd, TLS compat flag included)
netstat -ano | findstr ":18789" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 start "Rana gateway" /min /d "%~dp0" cmd /c start-gateway.cmd
rem 2) start vite dev server if not running
netstat -ano | findstr ":5173" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 start "Rana vite" /min /d "%~dp0" cmd /c "npm run dev"
rem 3) wait for the page (max 60s) then open default browser
powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){try{Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 2 | Out-Null; break}catch{Start-Sleep -Seconds 1}}; Start-Process 'http://localhost:5173'"
endlocal
