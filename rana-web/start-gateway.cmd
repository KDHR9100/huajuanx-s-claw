@echo off
rem Rana/OpenClaw gateway launcher wrapper.
rem Uses --tls-max-v1.2 flag (not NODE_OPTIONS) so respawned children inherit it.
rem Kept after the provider switch to dashscope; harmless there, still avoids
rem any TLS 1.3 post-quantum ClientHello issues on other endpoints.
rem ============================================================
rem Portable: all paths resolve relative to this script (%~dp0).
rem Optional machine-specific overrides: local-overrides.cmd in the same
rem directory (gitignored) runs first - it may set RANA_NODE (full path to
rem node.exe), OPENCLAW_STATE_DIR or OPENCLAW_MJS.
rem NOTE: keep this file ASCII-only. cmd.exe parses batch files in the system
rem codepage (GBK on zh-CN); UTF-8 Chinese comments break line parsing.
if exist "%~dp0local-overrides.cmd" call "%~dp0local-overrides.cmd"

rem State dir: env var wins, otherwise default to <repo>\.openclaw\.openclaw
if not defined OPENCLAW_STATE_DIR set "OPENCLAW_STATE_DIR=%~dp0..\..\.openclaw\.openclaw"

rem Node executable: PATH by default, override via RANA_NODE
if not defined RANA_NODE set "RANA_NODE=node"

rem openclaw.mjs entry: OPENCLAW_MJS override > auto-detect via npm root -g
if not defined OPENCLAW_MJS (
  for /f "usebackq delims=" %%i in (`npm root -g 2^>nul`) do set "OPENCLAW_MJS=%%i\openclaw\openclaw.mjs"
)
if not exist "%OPENCLAW_MJS%" (
  echo [start-gateway] openclaw.mjs not found: %OPENCLAW_MJS%
  echo [start-gateway] run setup.cmd in the repo root first.
  exit /b 1
)

rem Embedding watchdog: only when the config has a local LM Studio provider
rem (localhost:1234). Keeps exactly one qwen3-embedding instance, CPU-only.
rem Port-locked against multi-start. Log: %TEMP%\openclaw\embedding-watchdog.log
findstr /C:"localhost:1234" "%OPENCLAW_STATE_DIR%\openclaw.json" >nul 2>nul
if not errorlevel 1 start "" /B "%RANA_NODE%" "%~dp0..\tools\embedding-watchdog.mjs"

"%RANA_NODE%" --tls-max-v1.2 "%OPENCLAW_MJS%" gateway
