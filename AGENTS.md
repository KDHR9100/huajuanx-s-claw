# AGENTS.md — Code Agent 入场须知

任何 code agent（ZCode / Claude Code / Codex / trae 等）在本仓库干活前先读这份。
全貌与「从哪入手」看 **[PROJECT-MAP.md](PROJECT-MAP.md)**（结构地图 + 任务路由 + 演进时间线）；人看的长文是 [README.md](README.md)。

## 这个项目是什么（30 秒）

Rana · OpenClaw：开源 AI 助手框架 OpenClaw（npm 包 `openclaw`）+ 自研 Web 前端 rana-web，跑在一台 Windows 主机上的多智能体 AI 伙伴（main 干活 / rana-rp 微信陪伴 / rana-qq-public 群公共号，开箱默认单 agent）。前端**没有独立后端**——22 组 Vite 中间件（`rana-web/server/plugins/`，`/__rana/*`，仅本机回环）就是后端；自动化全是**边车脚本 + cron + 文件契约**（`rana-web/*.mjs`）。

## 铁律（违反=事故）

1. **排障先查 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)**（顶部有索引）：症状/根因/解法/状态俱全，命中直接照方抓药；新问题解决后**必须回写台账**——只留在会话记忆里等于没修。
2. **本仓库镜像到公开仓库**：`push-public.cmd` 做的是 `git add -A` 全量提交推送。你创建的任何文件默认视为将公开——**禁止**写入密钥、token、个人账号 ID、私有仓库地址；不确定就先看 `.gitignore`（根 + rana-web 两份）。
3. **OpenClaw 运行时状态不进 git**：live 配置、agent DB、人格与记忆都在 `.openclaw/.openclaw/`（已 ignore）。改运行时配置需带环境变量 `OPENCLAW_STATE_DIR=K:/OpenClaw/.openclaw/.openclaw`。
4. **隔离会话（cron/isolated）禁 exec**——审批送不到人就是 900 秒死循环；exec 白名单只放 git.exe，**解释器（node/python）永不放行**。
5. **不确定就问主人，不许猜**；没提过的功能不做；改前先确认（全局红线在本仓库同样生效且只加严）。
6. **别动的资产**：`gateway.ts` 乐观更新与去重、记忆桥隐私分层、KNOWN-ISSUES 台账制度——重构风险 > 收益。

## 速查

- **结构速览**：`rana-web/` 自建 Web 前端（vite + WebSocket 网关协议 v4）+ 边车脚本；`server/plugins/` 22 组中间件即"后端"；`tools/` 两个常驻守护（embedding 看门狗、sse-fix-proxy :18801）+ rp-soul-test 人格回归；`skills/` 可公开技能母本；`rana-web/tests/` 109 个 vitest 用例；`.github/workflows/ci.yml` push/PR 自动 build+test。完整代码地图见 PROJECT-MAP §1。
- **网关重启** = taskkill node PID + 重跑 `rana-web/start-gateway.cmd`（无服务注册）；重启后 3-5 分钟插件装载期连不上属正常。排障日志：`rana-web/.gateway.log`、`%TEMP%\openclaw\`。
- **测试**：`cd rana-web && npm test`（提交前端改动前必跑）；对齐项目现状以 [PROJECT-STATE-2026-10-17.md](PROJECT-STATE-2026-10-17.md) 为准（含实查配方，别信旧文档）。
- **改页面四步链**：`src/components/` 建组件 → `App.tsx` 挂视图 → `src/lib/types.ts` 的 `NAV_TABS`（页签单一来源）→ 需要数据就去 `server/plugins/` 加中间件。
- **升级 openclaw**：先备份全部 agent 库，升级后必须重打全套 dist 补丁（脚本在状态目录 `tmp/apply-*.cjs`）——清单与流程见 PROJECT-MAP §4。
- **私有脚本**：`backup-private.cmd` 私有备份（robocopy + git push）、`push-public.cmd` 公开仓一键推送，均 gitignore、由主人手动执行，agent 不要代跑。
- **并行会话常发生**：README/台账可能正被另一个窗口编辑，Edit 前重读。

## 文档索引

| 文档 | 用途 |
| --- | --- |
| [PROJECT-MAP.md](PROJECT-MAP.md) | ★ AI 进场全貌：代码地图 / 按任务入手 / 红线 / 时间线 |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | ★ 排障台账（先查索引，解决后回写） |
| [PROJECT-STATE-2026-10-17.md](PROJECT-STATE-2026-10-17.md) | ★ 权威现状快照（对齐状态以此为准） |
| [README.md](README.md) | 人看的长文档（架构/功能/协议/运维） |
| [OPEN-SOURCE-ROADMAP.md](OPEN-SOURCE-ROADMAP.md) / 其余根目录 *.md | 开源任务书 / 历史留档（均带状态横幅） |
