# Rana 可观测性档案：网关直播事件面（2026-10-14 定案）

> 方向1查证产出。要回答的问题：**「她生成/干活的过程」能不能像 ZCode 那样实时看到？**
> 结论：**能，协议层零障碍**。网关在聊天进行中就把阶段状态、增量文字、工具调用（含结果内容）、
> 实时 token 全部推送；rana-web 前端现在的连接方式原样就能收到——只是 `gateway.ts` 的
> `handleEvent` 把不认识的事件静默丢弃、界面没渲染。**差的是界面，不是协议。**

## 实证方法

探针 `rana-web/tools/ws-tap.mjs`：复刻前端的订阅面（operator + `webchat-ui` +
`sessions.subscribe` 全量 + 目标会话 `sessions.messages.subscribe`），开临时 main 会话发一条
必触发 read 工具调用的消息，全程录像到 `%TEMP%/openclaw/ws-tap-*.jsonl`，终态后删临时会话。
2026-10-14 实测一轮：50 帧，事件面如下。

## 事件字典（直播流；协议文档 + 实测双源）

### chat 事件（五种 state，实测三种）

| state | 载荷要点 | 实测 |
| --- | --- | --- |
| `status` | `phase`：preparing_workspace / preparing_context / starting_model（schema 共 7 种，另有建 worktree、装环境等）；限流时带 `retry{attempt,maxAttempts,reason}` | ✓ 三相位全见 |
| `delta` | `deltaText` 增量追加；`replace:true` 表示整段替换；首帧附完整 message 快照 | ✓ |
| `final` | message 完整快照 + usage + stopReason | ✓ |
| `aborted` | message + stopReason | — |
| `error` | `errorMessage`；`errorKind`：refusal/timeout/rate_limit/context_length/unknown；`errorDetail` 带 provider/httpStatus 等 7 字段 | — |

### 工具调用直播（本次查证的核心问题）

`session.tool` 事件（会话订阅者收到的镜像流）：

- `phase:"start"`：`{ name, toolCallId, args }` —— 调什么、参数是什么
- `phase:"result"`：`{ name, toolCallId, meta, isError, commandBearing, result:{content[]} }` —— **结果原文都在**
- 实测：`read(start)` + `read(result)` 两帧，args 带 `path/limit`，result 带 README 前 5 行原文

### agent 事件（同一连接实测收到的 stream）

`run_status` / `lifecycle` / `item` / `usage` / `assistant`；**`tool` stream 不投给这条连接**
（工具调用一律走上面的 `session.tool` 镜像）。两个亮点：

- `item` 流带现场解说：`{kind:"preamble", progressText:"我先读一下文件的开头几行。"}`
- `usage` 流实时吐 token：`{outputTokens:92}`

### 其他事件

`session.message`（消息落库，含微信等外部渠道写入）、`sessions.changed`、`presence`、`health`、
`tick/heartbeat`（噪音）；schema 里还有 `session.operation`（compact start/end，**上下文压缩发生点的直播**）、
`session.observer`（摘要订阅）、`session.approval`（需 `includeApprovals:true`）。

## 落地注意（踩过的坑）

- `connect` 的 `client.id` 是网关侧白名单枚举，乱填直接 `INVALID_REQUEST`——用 `webchat-ui`。
- 前端 `gateway.ts` 的 `handleEvent` 目前只处理 chat / session.message / sessions.changed /
  cron / shutdown 五种，其余静默丢弃。加直播 = 加分支，不用动网关、不用打补丁。

## 直播层提案（未实施，待拍板）

聊天页流式消息下方加一条「活动行」：监听 `session.tool` → 「🔧 read … ✓ (2.1s)」；
status 相位已有 `runs[key].status` 管道可直用；`agent:usage` 可喂实时 token 显示。
预估改动量：`gateway.ts` 一个事件分支 + store 一个字段 + `ChatStream` 一处渲染，半小时级。

## 关联

- 回放（事后看过程）：🔍 过程页，实现见 `server/plugins/trajectory.ts` + `src/components/TracePage.tsx`。
- 轨迹导出 CLI：`openclaw sessions export-trajectory --session-key <key> --output <名> --workspace <目录> [--json]`
  （产物固定落 `<workspace>/.openclaw/trajectory-exports/<名>/`，敏感字段官方导出时已 redaction）。
