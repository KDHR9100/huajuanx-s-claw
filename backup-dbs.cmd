@echo off
rem ===== Daily DB snapshot to I:\rana.backup (added 2026-10-03) =====
rem Why: sqlite dbs left the git backup on 2026-10-02 (GitHub 100MB hard limit,
rem files grow daily). This script keeps LOCAL snapshots on another disk.
rem Copies LIVE dbs only (*.sqlite / *.sqlite-wal / *.sqlite-shm).
rem WARNING: robocopy wildcards are loose - never use mid-name patterns like
rem "*.sqlite-*" here, it matched ~3000 junk files when tried.
rem Skips *.bak leftovers and the backups\ + tmp\ folders.
rem Keeps the last 7 date-stamped snapshots, prunes older ones.
rem Called from backup-private.cmd; can also run standalone.

set LOGFILE=K:\openclaw-backup-run.log
set DBSRC=K:\OpenClaw\.openclaw\.openclaw
set DBDST=I:\rana.backup

rem %date% is locale-dependent, ask PowerShell for a stable yyyy-MM-dd
for /f %%i in ('powershell -NoProfile -Command "Get-Date -format yyyy-MM-dd"') do set SNAPDIR=%DBDST%\%%i

echo [%date% %time%] db backup start>> "%LOGFILE%"
robocopy "%DBSRC%" "%SNAPDIR%" *.sqlite *.sqlite-wal *.sqlite-shm /S /XD backups tmp /NFL /NDL /NJH /NP /NS /NC
if errorlevel 8 (
  echo [%date% %time%] ERROR: db robocopy failed, exit %errorlevel%>> "%LOGFILE%"
  echo [db backup failed] robocopy exit code %errorlevel%
  exit /b 1
)

rem robocopy mirrors the whole 100k+ dir tree; drop dirs that carry no db file
powershell -NoProfile -Command "Get-ChildItem -LiteralPath '%SNAPDIR%' -Recurse -Directory | Sort-Object FullName -Descending | Where-Object { -not ($_.GetFileSystemInfos()) } | Remove-Item"

rem prune snapshots older than 7 days (delete dirs only)
forfiles /P "%DBDST%" /M * /D -8 /C "cmd /c if @isdir==TRUE rd /s /q @path" 2>nul

echo [%date% %time%] db backup done>> "%LOGFILE%"
echo [db backup done] snapshot at %SNAPDIR%
exit /b 0
