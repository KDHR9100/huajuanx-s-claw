@echo off
chcp 65001 >nul
rem 本机个性化覆盖模板：复制为 local-overrides.cmd（放同目录）后按需取消注释。
rem local-overrides.cmd 已 gitignore，不会进仓库；start-gateway.cmd / start-rana.cmd 启动时会自动执行。
rem 什么时候需要：node 不在 PATH、状态目录想放仓库外、npm 全局前缀特殊导致 openclaw.mjs 探测失败。

rem 例：node 装在自定义目录、不在 PATH 里
rem set "RANA_NODE=G:\node\node.exe"

rem 例：状态目录放到仓库外（默认在仓库内 .openclaw\.openclaw）
rem set "OPENCLAW_STATE_DIR=D:\my-rana-state"

rem 例：openclaw.mjs 手工指定（默认从 npm root -g 自动探测）
rem set "OPENCLAW_MJS=C:\Users\你\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs"
