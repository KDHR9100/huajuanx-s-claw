@echo off
setlocal
set OPENCLAW_STATE_DIR=K:\OpenClaw\.openclaw\.openclaw
cd /d "%~dp0"
node index.mjs
