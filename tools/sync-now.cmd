@echo off
chcp 65001 >nul
title 云端记忆拉取（迁移同步桥）
echo.
echo  从云端拉一份快照回家（会话库+记忆+人格，存 rana-web\.migration-sync\，留最近 14 份）。
echo  恢复/顶班用法见 tools\cloud-sync.mjs 头部注释与 MIGRATION-PLAN-2026-10.md §6。
echo.
node "%~dp0cloud-sync.mjs"
echo.
pause
