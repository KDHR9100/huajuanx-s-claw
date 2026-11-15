# 交接书：11-14/15 架构体检 · 四卡落地 · 分支待合并

更新：2026-11-15 17:59 · 分支：arch-cli-bridge-20261114 · 最新提交：99c22c4

## 当前目标

11-14 全项目架构体检（结论=不换基底，见 docs/adr/0002）后，把体检卡 1-4 与复盘守卫全部落地到工作分支 arch-cli-bridge-20261114（8 笔提交已推远端、CI 全绿），等主检出并行 WIP 落地后合并 main 收尾。

## 已完成（全部已推远端、CI 绿灯）

- 卡 1 CLI 桥收拢：lib/cli-bridge.mjs（441 行单一真相源）+ .d.mts 类型；agent-session-bridge.ts 与 agent-bridge.mjs 退薄封装；11 处调用点迁移（b3050d5）
- 卡 2 契约守卫：lib/contract-guard.mjs 单源 + server/lib/contract-guard.ts 门面，8 个读侧契约关键字段校验，坏数据留痕+降级+违规台账（42eab1b）
- 卡 3 HTTP 冒烟：tests/smoke/http-smoke.test.ts 14 用例，Vite createServer 真装配 25 插件，密闭 CI 兼容（42eab1b）
- 卡 4 gateway 安全网（本体零改动）：src/lib/finalRunDedup.ts / deleteChain.ts / pendingCreateKeys.ts + 67 差分用例；adoption 五步法在各模块头注释（f4fbe03）
- 复盘守卫：tests/unit/repo-hygiene.test.mjs 两道机械检查——import 藏注释块扫描 + 测试时区混框检查（99c22c4）
- 修复：git-activity-cron import 误插注释块（3ae0403）；owner-status 测试时区混框三处（f761bce + 99c22c4）
- 台账/ADR：KNOWN-ISSUES.md 顶部三条 2026-11-14 条目全部销账（draining 病/时区案/cron 案）；docs/adr/0002-base-retention.md 基底保留决策（d2c7b56、274fcbe）
- 病卡根治（运行时操作，不入 git）：网页聊天 draining 坏死病 = 登记手术（agent 库 1 行 failed→done，库备份 .bak-surgery-20261114）+ dist 第 5 刀补丁（apply-drain-rollover-patch-20261114.cjs，state tmp/，升级随全套重打）；11-14 08:10 主人真实流量验收通过，之后零复发

## 进行中

- 无半成品：工作树干净，所有完工事项都已提交推送（356 用例 + tsc + build 三绿）。

## 下一步

1. **合并**（等主检出的并行 WIP（17 文件，含 gateway.ts/owner-status.mjs）落地）：主检出 main 上 `git merge arch-cli-bridge-20261114`；预计冲突点 KNOWN-ISSUES.md 顶部与 PROJECT-MAP.md（两边都加行）；逐项过本地件 HANDOFF-cli-bridge-20261114.md 的 §8.3 合并清单（PROJECT-MAP 建议行/dev server 重启提醒都在里面）。
2. **卡 4 adoption patch**（合并后）：gateway.ts 换用三个新模块，五步法写在 src/lib/finalRunDedup.ts 等三个模块的头注释里，每步 npm test + 全量回归。
3. **卡 5 中间件装配器**（随时可发车）：defineRanaPlugin 吃掉 25 插件双注册样板（保守核心=只消样板；鉴权时序统一是行为变化，留拍板）；卡 3 冒烟兜底。
4. 拍板项：状态页亮灯接线（contract-guards.json 已有数据）/ 互斥下沉 / K 盘硬编码改 env / openclaw.json 单写口。

## 关键决策

- **不换基底**：OpenClaw 保留 + 补丁刀管理（现 5 刀），重评触发线四条，详见 docs/adr/0002-base-retention.md。
- **零行为变化纪律**：收拢迁移函数体逐字搬移，行为统一另立步骤单独拍板。
- **并行 WIP 勿抢活**：主检出 17 文件未提交前不合并 main；gateway.ts/owner-status.mjs 等排除清单文件不碰。
- **宁缺勿歪**：语义不等价的迁移不迁（三处 OPENCLAW_MJS 兜底、StudyGoalsPage fmtTs、runner 的 resolveOpenclawMjs 均主动保留）。
- 推送网络：直连与 Clash 全挂时，SSH 443 + 系统 OpenSSH 是唯一正路（URL 式 push 不更新 tracking ref，推后补 fetch）。

## 坑与注意

- vite dev 只听 [::1]:5173，curl 127.0.0.1 会 HTTP=000——探活用 [::1]。
- node --check 查不出 import 藏注释块（语法合法、运行时才炸）——已有 repo-hygiene 守卫测试拦截。
- 测试日期同框纪律：本地构造 Date 与写死 Z 串混用，UTC 的 CI 必挂——repo-hygiene 守卫拦截。
- dist 第 5 刀在 openclaw 升级后随 state tmp/apply-*.cjs 全套重打。
- C 盘约 5 天烧穿一次（主人已拍板「别管」），ENOSPC 撞上按 11-09 安全清单应急（只删着色器缓存）。
- 详细版交接书 HANDOFF-cli-bridge-20261114.md 是本地件（被 .gitignore 的 HANDOFF-* 规则挡住），决策记录全表、施工回执 §8、合并清单 §8.3 都在里面。

## 相关工件

- 决策记录+施工回执+合并清单：HANDOFF-cli-bridge-20261114.md（本地件，仓库根）
- ADR：docs/adr/0002-base-retention.md
- 台账：KNOWN-ISSUES.md 顶部三条 2026-11-14 条目（全销账）
- 体检报告：C:\Users\Administrator\AppData\Local\Temp\arch-review-20261114\architecture-review-20261114.html（临时件会过期）

## 建议

- 验证命令：cd rana-web && npm test（356 用例）+ npx tsc -b + npm run build
- 建议技能：/project-handoff resume 接续；动工前重读 AGENTS.md 铁律节
