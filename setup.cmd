@echo off
chcp 65001 >nul
rem Rana/OpenClaw 开箱初始化：检查环境 → 初始化配置与人格 → 装依赖
rem 可重复执行：已初始化的部分会自动跳过
where node >nul 2>nul
if errorlevel 1 (
  echo [setup] 没有检测到 Node.js。请先到 https://nodejs.org 下载安装 Node 22 或更高版本，装完重跑本脚本。
  pause
  exit /b 1
)
node "%~dp0setup.mjs"
pause
