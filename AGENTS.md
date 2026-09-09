# AGENTS.md — Code Agent 须知

任何 code agent（ZCode / Claude Code / Codex 等）在本仓库干活前先读这份。

- **排障先查 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)**：本项目踩过的坑全登记在那里（症状/根因/解决方案/状态）。命中直接复用；新问题解决后**回写到该文件**，不要只留在你的会话记忆里——下个 agent 未必有你的记忆。
- **本仓库镜像到公开仓库**：`push-public.cmd` 做的是 `git add -A` 全量提交推送。你创建的任何文件默认视为将公开——**禁止**写入密钥、token、个人账号 ID、私有仓库地址；不确定就先看 `.gitignore`。
- **OpenClaw 运行时状态不进 git**：live 配置、agent DB、两个 workspace 都在 `.openclaw/.openclaw/`（已 ignore）。改运行时配置需带环境变量 `OPENCLAW_STATE_DIR=K:/openclaw/.openclaw/.openclaw`。
- 结构速览：`rana-web/` 自建 Web 前端（vite + WebSocket 网关协议）；`backup-private.cmd` 私有备份（robocopy + git push）；`push-public.cmd` 公开仓库一键推送。
- 网关重启 = taskkill node PID + 重跑 `rana-web/start-gateway.cmd`（无服务注册）。排障日志：`rana-web/.gateway.log`、`%TEMP%\openclaw\`。
