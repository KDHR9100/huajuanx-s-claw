@echo off
rem One-click boot for the whole Rana stack:
rem   1) SnowLuma (QQ protocol side; auto-injects every discovered QQ process,
rem      thanks to hookAutoLoad=true in SnowLuma runtime.json - no manual step)
rem   2) gateway + vite + browser (via start-rana.cmd; skips already-running parts)
rem QQ itself follows its own autostart. Safe to re-run.
rem NOTE: keep ASCII-only + CRLF (cmd.exe parses batch in system codepage).
setlocal
if exist "%~dp0local-overrides.cmd" call "%~dp0local-overrides.cmd"

rem 1) SnowLuma first. Its WebUI port 5099 doubles as the already-running probe
rem    (SnowLuma has NO single-instance lock - starting twice runs two copies).
netstat -ano | findstr ":5099" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 start "SnowLuma" /min "K:\SnowLuma\start-snowluma.cmd"

rem 2) gateway + vite + browser (start-rana.cmd skips what is already up).
call "%~dp0start-rana.cmd"
endlocal
