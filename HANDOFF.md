# 交接书：11-16/17 观察日——哨兵红灯手术消红 + 证据包结案 + 卡4卡5行为统一落地

更新：2026-11-17 凌晨 · 分支：main · 最新提交：edbeb73（卡4/卡5 行为统一，496 用例三绿）

## 当前目标

11-16/17 接续 11-15 收拢日：四拍板全落地——①RP 哨兵红灯手术消红（禁用任务半途改判留观）②上游证据包结案（两案均不发）③卡4 send/delete 取 key 语义统一（向 delete 看齐）④卡5 工厂统一鉴权守卫。预算哨兵搁置。工作树干净、已推远端。

## 已完成

- **观察**：RP 侧 2 个真坏死窗口根因查明——不是 draining 病残留，是 RP 技能审查周任务连败（白名单病已清 + rp-nsfw 403 skipped）；作息卡攒数正常（11-15 首日 259min，11-16 继续记，nags=0）。
- **手术消红**：rana-rp 库 rid=4/5 两行 failed→done（库备份 `.bak-surgery-20261116` 23MB，node:sqlite backup API；复查 0 真坏死=灯绿）。台账已登记。
- **禁用任务改判留观**：上游把 `skill-collection-review:*` 与 heartbeat 同列系统属主保护，CLI 编辑/删除/auto-disable 全拒，无单独禁用开关（关全局工坊自主模式会殃及 main/qq公号同款任务）；delivery=none 失败静默 + skipped 不产生窗口 → 留观零副作用，灯不会复红。
- **证据包结案**：搜重发现 B 案 \?\路径上游 #164762 已修（closed as completed 10-04，修法同本机 __pubNorm 思路）——**升级 9.8+ 后可撤本地补丁**；A 案空转烧核 = #170013 同案但根因未钉（CDP 诊断链是我们独有增量），评论因 PAT 无公共仓权限 403，主人拍板「算了不发」，证据包留 `state docs/upstream-issues-draft-20261007.md`。draining 台账条目已加结案注记。
- **卡4 落地**（edbeb73）：send 侧 resolve 空串改失败放弃，与 delete 侧统一（原透传空串属死分支收拢，观察等价）；头注释+用例+参照实现同步。
- **卡5 落地**（edbeb73）：defineRanaPlugin 分发前统一 isLoopback 守卫（403「仅本机可操作」），22 个插件历史自查保留双保险，4 个无自查只读端点（agents/agent-info/provider-config/qq-profile）自动补防线；假 server 直调 6 用例。
- 全程 **496 用例 + tsc + build 三绿**；台账新条目+索引、HANDOFF 更新。

## 进行中

- 无半成品。

## 下一步

1. 状态页哨兵灯应已绿（TTL 自然刷新）；若复红先按台账新条目的抓手查 cron_run_receipts。
2. 预算哨兵图纸搁置中（01-budget-sentinel.png），主人想看再说。
3. RP 通道 rp-nsfw 403（VIP1 门槛）仍是 11-01 以来待拍板老决策，红灯手术只消了表现没动通道本身。
4. 升级 9.8+ 时按台账 draining 条目结案注记撤 `__pubNorm` 补丁（B 案上游已修）。

## 关键决策

- 11-16/17 拍板四件：手术+禁用（禁用半途改判留观）/ 预算哨兵搁置 / 卡4 向 delete 看齐 / 卡5 工厂统一守卫；证据包先「发」后改「不发」（搜重后 B 案已修、A 案评论 403）。
- 沿用：不换基底（ADR-0002）；零行为变化纪律（收拢逐字等价，行为统一需单独拍板——本次两卡是主人明确批准的例外）；宁缺勿歪。
- 会话「真坏死」口径不变：最新窗口 failed = 病；孤儿窗口（任务已删）是口径盲区，留观不修。

## 坑与注意

- node:sqlite：`backup` 是**模块级**函数 `backup(实例, 目标路径)`，DatabaseSync 实例上没有 backup 方法；`cron_jobs` 表主键列名是 `job_id` 不是 `id`。
- 上游系统属主 cron 任务（heartbeat/skill-collection-review）CLI 天生禁改禁删，别再试 CLI disable。
- gh CLI 未登录；git credential fill 取的 fine-grained PAT 只有自有仓库权限，公共仓（openclaw/openclaw）读写 403。
- 测试 import 生产模块禁止模块顶层 I/O（CI 裸机 ENOENT，台账有案）。
- vite dev 只听 `[::1]:5173`；推送撞 Connection reset 重试即可；C 盘约 5 天烧穿一次（主人拍板「别管」）。
- 超长会话后期长中文工具参数可能退化掺错字——文件手术委托子代理+grep 验收产出。

## 相关工件

- 台账新条目：「状态页哨兵红灯…手术消红…（2026-11-16）」KNOWN-ISSUES.md 登记区顶部
- 证据包原件：`.openclaw/.openclaw/docs/upstream-issues-draft-20261007.md`（不发留档）
- 设计图纸：rana-web/.health/design-previews/（01 预算哨兵搁置；02-06 已落地）
- 手术脚本与备份：`%TEMP%\surgery-rp-windows-20261116.cjs`；库备份 `agents/rana-rp/agent/openclaw-agent.sqlite.bak-surgery-20261116`

## 建议

- 验证命令：cd rana-web && npm test（496 用例）&& npx tsc -b && npm run build
- 新会话开场说「继续上次工作」或 /project-handoff resume 即可接续
