@echo off
setlocal
if not defined OPENCLAW_STATE_DIR set "OPENCLAW_STATE_DIR=%~dp0..\..\.openclaw\.openclaw"
cd /d "%~dp0"
node index.mjs
