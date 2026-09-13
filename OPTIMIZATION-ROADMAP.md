# OPTIMIZATION-ROADMAP — 优化路线与实现细节（2026-09-14）

> 性质：施工图。融合两份诊断（PROJECT-ANALYSIS.md 代码体检 + 运行时 token/延迟诊断）与已确认取舍。
> 用法：按批次执行，每批完工跑第 4 部分对应的验证项；回滚点见第 6 部分。

---

## 0. 目标与度量尺

三个目标：

| 目标 | 度量方法 |
| --- | --- |
| 响应快：QQ 正常轮 13-50s → 5-15s；群聊 ~27s → 10-15s | 网关日志「收消息时间戳 → 回复发出时间戳」配对（同诊断口径） |
| 省 token：心跳 ~500 万/天 → ~10 万/天；每轮上下文 15 万 → <2 万 | cron receipts 次数 × 心跳 turn 的 usage；session usage 的 input+cacheRead |
| 效果只升不降：功能缺陷修复、记忆连续性由记忆体系承载 | 第 4 部分验证清单全绿 |

## 1. 现状基线（2026-09-14 实测）

- **心跳**：每 30 分钟整会话唤醒，9-13 实跑 33 次、94% NO_REPLY 空转，每次携带主会话 ~15 万 token 上下文（cacheRead），折 ~500 万 token/天；心跳 turn 实测 11-72s，与用户消息在主会话互斥排队。
- **主会话**：`agent:main:main` 上下文 151,762 / 262,144（58%），9-8 以来仅 1 次压缩，两天内零压缩；每条消息都重发全部历史。
- **QQ 延迟实测**（收→回配对）：35.8s / 13.1s / 26.4s / 34.2s / 50.3s；最坏一次云端网络超时重试 473.9s（上游网络问题，重试机制已在兜底，配置无法消除）。
- **群聊延迟**：27.2s / 17.7s（rana-qq-public，GLM-5.3-flash，思考默认 max 档）。
- **记忆桥**：memory-bridge `*/30`（48 次/天，云端 glm 提炼）+ private-memory-bridge `7,37`（48 次/天，本地 14B 提炼）。
- **功能缺陷**：`ALL_VIEWS` 缺 `groups`/`dsh` 两项 → 群画像、派活两个页签 UI 不可达（303 行已写好的功能）；`news-report.mjs` 未适配 SecretRef → 早报「乐奈的总结」发出 `Bearer [object Object]` 静默失效；`memory-bridge.mjs` 真名/化名映射硬编码在公开仓库跟踪文件中（6 处以上），云端 prompt 还解释了映射关系。
- **无测试/无 lint/无 ErrorBoundary**（PROJECT-ANALYSIS §4.1/4.2）。
- 已修复存档：materialAbs fail-closed 路径校验（cc06903）；QQ secret 已修（token obtained）；README 架构图已同步（cc06903）。

## 2. 批次一：止血（代码改动，tsc 验证）

### 2.1 ALL_VIEWS 修复（让群画像/派活页签可见）

- `src/store/useAppStore.ts:77`：`ALL_VIEWS` 补 `"groups"`、`"dsh"`。
- 单一来源改造：`TopNav.tsx` 的 `TABS` 常量上移到 `lib/types.ts`（或 store）导出，`ALL_VIEWS = TABS.map(t => t.id)`；TopNav 与 store 都从这一份引用，杜绝三处各写一遍再漏。
- 验证：页签渲染 8 个；`groups`/`dsh` 点击可进。

### 2.2 早报总结复活（SecretRef 第三处受害者）

- 新建 `src/../lib` 侧共享模块 `rana-web/lib/rana-config.mjs`（Node 侧用）：首个住户是从 `memory-bridge.mjs` 的 `resolveApiKey()` 移植的密钥解析（SecretRef → 读 `state/openclaw.sqlite` 的 `secret_store_entries` 表）。
- `news-report.mjs:131,139`：`p.apiKey` 改走 `resolveApiKey(p)`；失败不再静默——`report.json` 写 `summaryError` 字段。
- `NewsPage.tsx`：总结卡读到 `summaryError` 时显式显示错误原因。
- 验证：手动触发一次早报生成，总结卡出字（或显式报错而非空白）。

### 2.3 隐私外置（化名行为一行不改）

- 新增 `rana-web/memory-bridge.identity.json`（**加入 .gitignore**）：`{ "realName": "…", "groupAlias": "青散" }`，真实值只存本机。
- `memory-bridge.mjs` 6 处硬编码（136/147/151/174/175/187/191 行）改为从 identity 文件读取；缺文件回退中性占位并告警。
- 175 行云端 prompt：删掉「青散=<真名已移除>在群里的称呼」的映射解释，只保留「群主在群里叫青散，纪要一律写青散」——云端模型不需要知道它是谁的化名。
- `.gitignore` 加一行 `rana-web/memory-bridge.identity.json`。
- 注记：git 历史已推公开的部分无法收回（历史重写影响备份链，需单独拍板）；本批保证今后不再暴露。
- 验证：`git ls-files | grep memory-bridge` 后 grep 真名零命中；桥跑一次纪要仍写化名。

### 2.4 React ErrorBoundary（页面级）

- 新建 `src/components/ErrorBoundary.tsx`：类组件，捕获渲染错误显示「哪个页面崩了 + 🔄 重载该页按钮」，不再整站白屏。
- `App.tsx`：每个 `view === "…"` 分支的内容用 ErrorBoundary 包裹（或包 `<div className="pages">` 内层每页一个）。
- 验证：tsc 通过；手动渲染异常场景不炸导航。

### 2.5 README 校正

- 实测行数（≈14,350）、目录导览补 `GroupsPage.tsx`/`DshPage.tsx`、页签数 8、中间件组数 11；架构图 cc06903 已更新，核一遍口径即可。

## 3. 批次二：运行时提速（配置改动，重启网关生效）

### 3.1 心跳轻量化（省 ~98% 心跳 token + 排队窗口缩到秒级）

`openclaw.json` → `agents.defaults.heartbeat` 改为：

```json5
{
  "agentId": "main",
  "every": "60m",
  "isolatedSession": true,     // 每次心跳全新小会话：~100K → ~2-5K tokens
  "lightContext": true,        // 不注入 workspace 底稿
  "target": "last",
  "activeHours": { "start": "10:00", "end": "01:00", "timezone": "user" },
  "prompt": "【心跳】定期自检。先读 workspace 里最近两天的 memory/YYYY-MM-DD.md 日记判断近况：有该主动提的事（他交代的待办、日程将到、明显该关心的点）就用一两句话主动说；没有任何该说的，必须只回 NO_REPLY，不许闲聊、不许汇报心跳本身。"
}
```

- 取舍（已确认）：心跳不再天然看到主会话聊天记录，靠自己读日记；深夜 1 点-早 10 点静默。
- 注意：heartbeat 对象是 strict 的，字段以运行版 schema 为准，改完看启动日志 `Invalid input` 警告是否消失。

### 3.2 主会话每日翻新（每轮 -14 万 token，延迟主功臣）

- 顶层加：`"session": { "reset": { "mode": "daily", "atHour": 6 } }`（每天 6 点自动开新会话；结束会话的尾部自动存进日记；旧转录仍可搜）。
- 现有 15 万 token 会话**立即归档**：经网关给 `agent:main:main` 发一条 `/new`。
- 跨天连续性由记忆体系承载（MEMORY 索引 + 日记 + 画像 + 语义检索）。

### 3.3 工具瘦身 + 思考降级

- main：先跑 `/context detail`（或 `/__rana` 诊断）量化各工具 schema，把确认没用过的重工具加入 `tools.deny`（候选：`browser`、`canvas`、媒体生成类；以量化数据定名单，deny 即省每轮固定 token）。
- rana-qq-public：加 `"thinkingDefault": "low"`（GLM-5.3 关不掉思考，low 是最低档；预计群聊 27s → 10-15s）。
- 主会话模型钉死：`sessions.patch {key:"agent:main:main", model:"aliyun-maas/qwen3.8-flash"}`（与 entries 一致，消除会话级模型漂移；qwen 的 `enable_thinking:false` 已在 provider 级生效）。

### 3.4 记忆桥减频（96 → 48 次调用/天）

```
openclaw cron update memory-bridge --schedule "0 * * * *"
openclaw cron update private-memory-bridge --schedule "17 * * * *"
```

（命令形态以 `openclaw cron update --help` 为准；目标是 30 分钟班改每小时班。）

## 4. 验证清单（重启网关后逐项）

| # | 验证项 | 方法 | 预期 |
| --- | --- | --- | --- |
| 1 | 页签全显示 | 打开 rana-web | 8 个页签，groups/dsh 可进 |
| 2 | 早报总结 | 手动触发生成 | 总结卡出字或显式报错 |
| 3 | 化名机制 | 跑一次桥 | 纪要仍写化名；仓库 grep 真名零命中 |
| 4 | 心跳变轻 | 等一个整点心跳，看日志 turn 时长与 usage | <10s、个位数 K token |
| 5 | 心跳静默 | 确认 01:00-10:00 无心跳 run | 无 |
| 6 | QQ 延迟 | 发消息，日志配对 | 5-15s |
| 7 | 群聊延迟 | 群里 @她，日志配对 | 10-15s |
| 8 | 桥频率 | cron receipts | 每小时各 1 次 |
| 9 | 主会话 | usage | 上下文 <2 万（归档后） |
| 10 | 类型与构建 | `npx tsc --noEmit` | 通过 |

## 5. 批次三：后置排期（不在本轮，按价值排序）

1. vitest 首批测试：`reasoning.ts`、`fateCore.ts`、`memory-bridge` 的 `parseEntries()`、`git-activity` 口径（4 处纯函数、改动爆炸半径最大）
2. 拆分 `vite.config.ts`（2,339 行）→ `server/` 八模块（sys/study/fate/news/provider/model/avatar/agent-info+qq-profile），vite.config 只剩装配
3. 合并 `study-agent.mjs`+`fate-agent.mjs`（95% 重复）为 `lib/agent-bridge.mjs --session <key> --label <名>`；统一 Node 侧 OpenClaw WS 客户端
4. 派活闭环：任务列表/状态/回执/重试（**先探测 acpx 侧任务状态可查性**，避免空写 UI）
5. 记忆桥观测面板（三腿最近运行状态/产出/失败原因——系统健康度晴雨表）
6. 设置与本地数据备份/恢复；会话搜索导出；重连上限提高+手动重连按钮

## 6. 风险与回滚

| 改动 | 回滚点 |
| --- | --- |
| openclaw.json | 改前 `openclaw.json.bak-speedup`；恢复=拷回+重启网关 |
| cron 减频 | `openclaw cron update <id> --schedule <原值>` |
| 心跳 | 还原 heartbeat 块即回旧模式 |
| 主会话归档 | 不可逆（旧转录仍可搜、日记已存）——已确认 |
| identity 外置 | identity.json 不删即无感；删了回退需还原代码 |
| commit 拦截 | Mimosa 高危若再拦：真实修复已进库（cc06903 先例），按交付时选项处理 |
