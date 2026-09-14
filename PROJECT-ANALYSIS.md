# Rana · OpenClaw 项目状态分析与演进建议

> 分析日期：2026-09-14 ｜ 分析对象：`K:\OpenClaw` 公开镜像（不含 `.openclaw/` 运行时状态）
> 方法：全量通读 README / AGENTS / KNOWN-ISSUES + 前端源码 + Vite 中间件层 + 边车脚本，逐模块核对文档与实现的一致性。

---

## 0. 结论摘要

这是一个**完成度相当高、工程纪律罕见地好**的个人项目。它不是玩具：`gateway.ts` 里那套针对"本机进程其实很不可靠"的防御工事（乐观创建/串行删除/三路去重）、`KNOWN-ISSUES.md` 的问题台账制度、以及"隐私是一等公民"的数据流分层设计，都是真实踩坑后沉淀出来的，含金量高于多数同类项目。

但项目正处在一个**典型的规模拐点**：功能在快速堆叠，架构减重没跟上。实测代码量 **约 14,350 行**（README 称约 8,000 行），其中 `vite.config.ts` 单文件 **2,339 行**、学习模块独占 **1,736 行**、边车脚本里有 **近 400 行是复制粘贴**。同时发现 **2 个会实际影响功能的缺陷**和 **1 个违反本项目自己隐私红线的泄露**。

一句话概括：**地基很好，现在该做减法和加装护栏了。**

---

## 1. 项目画像

### 1.1 实测规模（与 README 声明对照）

| 区域 | 实测行数 | README 声明 | 备注 |
| --- | --- | --- | --- |
| `rana-web/src/**` | **10,248** | "约 3,400 行源码" | 低估 3 倍 |
| └ `styles.css` | 2,052 | "1300+ 行" | 单体样式表 |
| └ `StudyPage.tsx` | 1,016 | — | 最重组件 |
| └ `gateway.ts` | 761 | "750 行" | ✅ 准确 |
| └ `fateCore.ts` | 532 | — | 八字/紫微本地计算 |
| `vite.config.ts` | **2,339** | "约 1000 行" | 低估 2.3 倍 |
| 边车脚本 `*.mjs` | 1,760 | — | 9 个脚本 |
| 文档 | 757 | — | README 466 + 台账 291 |
| **合计** | **≈ 14,347** | "约 8,000 行" | — |

> 数字漂移本身不是大事，但它说明 README 已落后于代码——对一个"文档即资产"的项目（KNOWN-ISSUES 是核心资产）来说，这会削弱文档的可信度。

### 1.2 技术栈

- **运行时**：Node 22+ / Vite 6 / React 18 / TypeScript 5.6（strict 未确认，构建走 `tsc -b`）
- **状态**：zustand 5（单 store，208 行，无 middleware、无持久化插件）
- **样式**：零 UI 框架，全手写 CSS + CSS 变量 + `color-mix` 派生
- **底座**：OpenClaw gateway（WS 协议 v4，`@openclaw/gateway-client` 2026.8.1）
- **本地算力**：LM Studio（14B 常驻 + 0.6B embedding 走 CPU）+ 看门狗
- **本地计算库**：`iztro`（紫微）、`lunar-javascript`（农历/干支）
- **测试**：**零**。无 vitest/jest/eslint/prettier/CI。

### 1.3 依赖拓扑

```
浏览器（React SPA）
   │ ① WebSocket 直连 :18789，失败 4s 后回退同源 /gateway 代理
   ▼
┌──────────────────────────────────────────────────────────────┐
│ OpenClaw gateway（外部进程，不在本仓库）                        │
│   会话/SQLite · cron · 三 agent 路由 · 记忆索引 · 密钥库        │
└──────────────────────────────────────────────────────────────┘
   ▲                    ▲                        ▲
   │ ② WS RPC           │ ③ 子进程 spawn         │ ④ 直读 SQLite / openclaw.json
   │                    │                        │
前端 lib/gateway.ts   Vite 中间件层            边车脚本（memory-bridge / news / study / fate）
（浏览器侧唯一连接）   （/__rana/*，11 组插件）   （各自独立实现握手与配置读取）
```

**关键结构特征**：**没有独立后端进程**。Vite 的 `configureServer` + `configurePreviewServer` 双挂载让 dev/preview 行为一致，这是本项目最漂亮的一笔（README 亮点 1 名副其实）。

---

## 2. 核心模块逐个盘点

### 2.1 `src/lib/gateway.ts`（761 行）— 项目地基，完成度 ★★★★★

手写的小型 RPC + 事件总线，质量超出预期：

- **握手**：WebCrypto Ed25519，`buildDeviceAuthPayloadV3` 规范化签名，token 与私钥分离（泄露 token ≠ 可冒充）。
- **请求**：id 配对 + 分级超时（普通 30s / 删除 120s）。
- **乐观创建**：`pending-create:` 占位 key → Promise 队列 → 真实 key 到达后迁移消息与 run 态；期间发消息自动等待。
- **乐观删除**：客户端**串行队列** + 超时后先 `sessionStillActive()` 核实再重试 + 删除后 15s 内继续过滤陈旧列表防"闪回"。
- **三路消息去重**：终态 `runId` 集合（上限 50）+ 落库事件扫最近 8 条 + `deletingKeys`。

这些不是教科书式防御，每一条都能在 KNOWN-ISSUES 里找到对应事故。**建议原样保留，不要重构。**

唯一可议：`MAX_RECONNECT = 6` 之后彻底放弃、需要手动刷新页面（见 §4.3）。

### 2.2 `src/lib/reasoning.ts`（128 行）— 脏输出清洗，完成度 ★★★★☆

一条管线解决微调小模型的"脏输出"：`<think>` / `<details><summary>` 双语法思考折叠（流式未闭合也处理）→ OpenClaw 封套剥离 → 元块清除 → 回声检测。有 `guard` 上限防死循环，考虑周到。

**这是纯函数、边界清晰、最值得先补测试的文件。**

### 2.3 `vite.config.ts`（2,339 行）— 后端层，完成度 ★★★★☆ / 可维护性 ★★☆☆☆

**11 组插件、14 组端点**：

| 端点 | 职责 |
| --- | --- |
| `/__rana/config` | dev-only 下发 token（生产构建刻意不挂） |
| `/__rana/provider-config` `/provider-models` | 云端 provider 增改删、代拉模型列表 |
| `/__rana/sys/status` `/sys/power` `/sys/virt` | 系统状态聚合（8s 缓存）、电源计划、虚拟化切换 |
| `/__rana/avatar` | 头像读写 |
| `/__rana/news` | 早报读取 + 触发生成（进程级互斥锁） |
| `/__rana/study/*` | 课表读写 + 唤醒她排课/出题/判分 |
| `/__rana/fate/*` | 生辰档案 + 解卦转发 |
| `/__rana/model-test` `/model-params` | 模型连通测试、超参调节 |
| `/__rana/agent-info` | 技能清单 / MCP 服务器名 |
| `/__rana/qq-profile` | 群画像只读展示 |

安全姿势是对的：写操作双重来源校验（回环地址 + Origin）、`execFile` 数组参数、powercfg 按 GBK 字节解码、GUID 白名单。**但 2,339 行单文件已是明确的维护债**，其中学习模块独占约 720 行、命理约 275 行。

### 2.4 边车脚本（1,760 行）— 设计优秀，实现有重复

- `memory-bridge.mjs`（365 行）：三腿记忆桥。隐私分层做得很扎实——RP 侧原文只进本地模型、群聊腿单向只进 main、`resolveApiKey()` 已适配 SecretRef。**本项目在数据流设计上最见功力的文件。**
- `fate-agent.mjs`（200 行）与 `study-agent.mjs`（201 行）：**约 95% 代码完全相同**（握手、会话定位、`extractJson`、看门狗、输出契约），差异只有 `SESSION_KEY` 和标签两个字。**这是全项目最明显的复制粘贴。**
- `news-report.mjs`（181 行）：抓取 + 搜索 + 总结，板块失败隔离。
- `tools/embedding-watchdog.mjs`（150 行）：显存治理看门狗，把"玄学调参"变成可验证的闭环。

### 2.5 页面完成度评估

| 页面 | 行数 | 完成度 | 说明 |
| --- | --- | --- | --- |
| 💬 会话 | 165+246+113 | ★★★★★ | 流式/思考折叠/乐观 UI/用量面板，最成熟 |
| 💠 状态 | 412 | ★★★★★ | 各卡片独立降级，8s 缓存 |
| ⏰ 定时任务 | 230 | ★★★★☆ | 系统任务如实标注"⚙ 系统"而非给假按钮 |
| 📰 早报 | 169 | ★★★☆☆ | 按需生成省额度；**总结卡疑似失效**（§3.2） |
| 📚 学习计划 | 1,016+264 | ★★★★★ | 最完整闭环：排课→执行→考核→错题本→期末考 |
| 🧰 程序（玄学） | 64+532+504+336 | ★★★★★ | 全本地计算，术数术语带注释，工程量大 |
| 👥 群画像 | 195 | ★★★☆☆ | 只读展示 + 模型切换；**入口不可达**（§3.1） |
| 🔨 派活 | 108 | ★☆☆☆☆ | 仅表单发消息，**无回执/无进度/无日志**；入口不可达 |

---

## 3. 已确认缺陷（按严重度）

### 3.1 🔴 「群画像」「派活」两个页签在界面上根本不显示

**证据链**：
- `src/store/useAppStore.ts:77` — `ALL_VIEWS = ["chat","sys","cron","news","study","apps"]`（**6 项**）
- `src/lib/types.ts:52` — `AppView` 含 8 项（多出 `groups`、`dsh`）
- `src/components/TopNav.tsx:11-20` — `TABS` 定义了 8 项
- `src/App.tsx:88,94` — 两个页面的渲染分支都在
- `loadTabOrder()`（`useAppStore.ts:83-85`）**先按 `ALL_VIEWS` 过滤、再补齐 `ALL_VIEWS` 缺失项** → 返回值恒为 6 项

**后果**：TopNav 只渲染 `tabOrder` 里的页签，因此 `groups` / `dsh` 永远不出现。两个已写完的页面（303 行代码）从 UI 上不可达。git log 显示 `cc06903 派活页雏形接入导航`、`2e702aa 群组页雏形` 两次提交都加了 TopNav 与 App 分支，**唯独漏了 `ALL_VIEWS`**。

**修复**：1 行。把 `ALL_VIEWS` 改为与 `AppView` 同源（推荐 `ALL_VIEWS` 由 `TABS` 常量导出，避免三处各写一遍）。

### 3.2 🔴 早报「乐奈的总结」因 SecretRef 迁移静默失效

**证据**：`rana-web/news-report.mjs:131,139` 直接把 `p.apiKey` 当字符串用：
```js
if (!p?.baseUrl || !p?.apiKey) throw new Error("aliyun-maas provider 未配置");
headers: { Authorization: `Bearer ${p.apiKey}` }
```
KNOWN-ISSUES 已记录 doctor 把 provider 明文 key 迁进密钥库后，`apiKey` 变成 `{source:"store",id}` 对象。`memory-bridge.mjs` 与 `vite.config.ts:1985` 都补了 `resolveApiKey()`，**只有 `news-report.mjs` 没补**。

**后果**：对象 truthy → 校验通过 → 发出 `Bearer [object Object]` → 401 → 被 `catch` 吞掉 → 只留一行日志「乐奈总结失败（跳过）」。用户看到的是总结卡**空着但没报错**。

**修复**：复用 `memory-bridge.mjs:37` 的 `resolveApiKey()`（建议抽到共享模块，见 §5.2）。

### 3.3 🟡 公开仓库内存在硬编码个人信息与本机路径（化名机制有效，配置放错了地方）

**先说清楚什么是对的**：`memory-bridge.mjs` 的群聊腿有一套**刻意的化名机制**——`151` 行把主人 openid 映射为群内化名而非真名，`175` 行的提示词明确要求"群聊纪要一律写化名"。**群聊侧的输出隐私是达标的**，这也是本项目把隐私当一等公民的又一例证。

佐证：`147` 行的注释仍写着"主人 openid → **真名**"，而 `151` 行代码返回的是化名——**注释没跟着改**，这是"后来补上化名、漏改注释"留下的化石，正说明化名是后加的隐私措施。

**再说问题**：化名保护的是"写进群纪要的内容"，保护不了"名字躺在 git 跟踪文件里被推到公开镜像"。两者是不同威胁面。而且同目录的 `memory-bridge.privacy-patterns.json` 已被 gitignore、其注释自称"私人词表，不入公开仓库"——**同一文件体系内，词表外置了、名字没有**，更像疏忽而非设计。

更具体的一处：`175` 行那句解释化名映射的提示词，会作为 prompt 一并 POST 给云端模型（群聊腿提炼）。模型只需要知道"群主在群里叫 X"，不需要知道它是某真名的化名——**这处披露是多余的，且与"不在公共场合写真名"的初衷相悖**。

`git ls-files` 确认以下**已跟踪**文件含硬编码：

| 文件:行 | 内容类型 |
| --- | --- |
| `memory-bridge.mjs:136,147,151,174,175,187,191` | 主人真实姓名 + 群内化名（6 处以上） |
| `memory-bridge.mjs:23` | `K:/OpenClaw/.openclaw/.openclaw` |
| `memory-bridge.mjs:360` | `G:/node/node.exe` + `C:/Users/<用户名>/...` |
| `vite.config.ts:38, 2118` | `C:\Users\<用户名>\AppData\...\openclaw.mjs`（**同一常量定义了两遍**） |
| `vite.config.ts:1991` | `K:\openclaw\...\state\openclaw.sqlite`（正是 KNOWN-ISSUES 第六坑警告的反斜杠形式） |
| `DshPage.tsx:10` | `K:/OpenClaw` |

对照：`.gitignore` 已正确排除 `.openclaw/`、`private-memory-bridge.mjs`、`privacy-patterns.json`、`git-activity.repos.json`——**制度本身健全，是执行漏了上表这几处**（`private-memory-bridge.mjs` 里直接用真名完全没问题，它在 ignore 名单里）。

**修复原则：化名行为一行不改，只把映射关系挪出公开仓库。** 新增 gitignore 的 `memory-bridge.identity.json`（与 `privacy-patterns.json` 同一套路），存 `{realName, groupAlias}`；代码运行时读取、缺文件时回退默认。群纪要仍写化名，云端 prompt 只说"群主在群里叫 X"、不再解释它是谁的化名。本机路径部分改为环境变量 / 运行时探测（见 §5 的 1.4）。

---

## 4. 潜在问题与技术债

### 4.1 无测试、无 lint、无 CI
零测试文件、零 lint 配置。项目有 4 处**纯函数密集、边界 Case 极多**的模块，正是测试收益最高的地方：`reasoning.ts`（脏输出解析）、`fateCore.ts`（历法/干支/紫微）、`git-activity.mjs`（统计口径）、`memory-bridge.mjs` 的 `parseEntries()`（正则过滤链）。

### 4.2 无 React 错误边界
KNOWN-ISSUES 已登记一次「状态接口返回形状与前端类型对不上 → React 整页白屏（nav 一起没）」。**根因未消除**：前端仍手写 payload 类型（`SysPage.tsx:47-54` 的 `StatusPayload`），JSON 过 `unknown` 后 TS 查不出来。App.tsx 无 ErrorBoundary，`window.gw` 也只是调试钩子。

### 4.3 连接层恢复策略偏保守
`MAX_RECONNECT = 6`（约 1+2+4+8+15+15 ≈ 45s）后进入 `error` 且不再重试，需手动刷新。考虑到网关重启是本项目**日常运维动作**，这里应该给"重新连接"按钮或更长的退避上限。

### 4.4 列表刷新为全量
`sessions.changed` 1.5s 防抖后 `refreshSessions()` 拉全量列表并整体替换。会话量增长后会有抖动与性能开销；另外 `loadHistory()` 不分页，长会话一次拉全部。

### 4.5 边车脚本与前端配置耦合本机绝对路径
所有脚本各自 `readFileSync("K:/OpenClaw/.openclaw/.openclaw/openclaw.json")`，且 `spawn` 写死 `G:/node/node.exe`。这让"克隆即读"体验很好、但"克隆即跑"完全不可行——与 README「想完整跑一套 → 自备环境即可」的承诺有落差。

### 4.6 设置状态散落
localStorage 至少有 7 个独立 key（token / device-identity / device-token / pinned / tab-order / show-reasoning / composer-height）+ 若干本地数据目录（`.study/` `.news/` `.fate/` `.avatars/`）。**没有统一的导出/备份/恢复入口**——一旦清缓存，排课表、卦例、人设偏好全丢（`.study` 等在服务端目录，token 和 UI 偏好在浏览器）。

---

## 5. 演进建议

分级说明：**P0** = 正确性/隐私，立刻做；**P1** = 架构减重，为后续提速；**P2** = 功能增强；**P3** = 长期架构。每项给出价值、可行性、难度。

### P0 — 止血（建议 1～2 个晚上）

| # | 建议 | 价值 | 可行性 | 难度 |
| --- | --- | --- | --- | --- |
| 0.1 | 修复 `ALL_VIEWS`，让 `groups`/`dsh` 页签可达；`ALL_VIEWS` 由 `TopNav` 的 `TABS` 单一来源导出 | 高：303 行已写好的功能即刻可用 | 极高（1 行 + 小重构） | ⭐ |
| 0.2 | `news-report.mjs` 接入 `resolveApiKey()`；失败时**在 report.json 里写 `summaryError` 字段**，前端显式提示而非静默留空 | 高：恢复一个"每天都在用"的功能，且同类静默失败不再发生 | 高（已有现成实现） | ⭐ |
| 0.3 | 硬编码外置：新增 gitignore 的 `memory-bridge.identity.json` 存真名/化名映射（**化名行为一行不改，群纪要照样写化名**），并删掉云端 prompt 里那句映射解释；本机路径改环境变量/运行时探测 | 高：化名保住了"输出"，但映射本身还躺在公开仓库与云端 prompt 里 | 高（机械替换，行为零变化） | ⭐⭐ |
| 0.4 | 加 React ErrorBoundary（页面级），白屏时给出"哪一块坏了 + 重载该页"而非整站消失 | 高：KNOWN-ISSUES 已记录的复发事故 | 高 | ⭐ |
| 0.5 | 校正 README 的数字、目录导览（缺 `GroupsPage`/`DshPage`/`apps/`）、页签数（4→8）、中间件组数（6→11） | 中：文档可信度是这个项目的资产 | 极高 | ⭐ |

### P1 — 架构减重（投入产出比最高的一档）

| # | 建议 | 价值 | 可行性 | 难度 |
| --- | --- | --- | --- | --- |
| 1.1 | **拆分 `vite.config.ts`**：抽出 `server/` 目录（sys / study / fate / news / provider / model / avatar / agent-info / qq-profile），`vite.config.ts` 只剩装配 | 高：2,339 行单文件是当前最大的维护瓶颈；拆分后学习（≈720 行）和命理（≈275 行）可独立演进 | 高：中间件本来就只依赖 Node 标准 API（README 亮点 1 已论证） | ⭐⭐ |
| 1.2 | **合并 `study-agent.mjs` + `fate-agent.mjs`** 为 `lib/agent-bridge.mjs --session <key> --label <名> --message <文本>`，两个脚本退化为薄封装 | 中高：消除约 190 行重复；将来加"第三个专用会话"成本从复制 200 行降到 1 行 | 极高 | ⭐ |
| 1.3 | **统一 OpenClaw 客户端**：目前 WS 握手有 4 份实现（浏览器 `gateway.ts`、Node 侧 study/fate/e2e）。抽 `lib/openclaw-client.mjs` 供 Node 侧复用 | 中高：SecretRef、TLS 补丁、超时策略只需改一处 | 高 | ⭐⭐ |
| 1.4 | **边车脚本配置统一**：新增 `lib/rana-config.mjs` 统一解析 `OPENCLAW_STATE_DIR`（回退到默认）与 `resolveApiKey()`；`spawn` 用 `process.execPath` 替代写死的 node 路径 | 中高：让"克隆即跑"从口号变现实；也是 0.3 的落地载体 | 高 | ⭐⭐ |
| 1.5 | **引入 vitest + 首批纯函数测试**：`reasoning.ts` / `fateCore.ts` / `parseEntries` / `git-activity` 口径 | 高：这四处改动的 blast radius 大且无类型保护 | 高（vitest 与 Vite 同生态，零配置成本） | ⭐⭐ |
| 1.6 | 连接层恢复增强：重连上限提高 + 顶栏/横幅提供"重新连接"按钮 | 中：网关重启是日常操作，不该每次都刷新页面 | 高 | ⭐ |

### P2 — 功能增强

| # | 建议 | 价值 | 可行性 | 难度 |
| --- | --- | --- | --- | --- |
| 2.1 | **派活（DSH）做成真闭环**：现在只往 main 会话丢一条消息。应有任务列表、状态（排队/跑/完成/失败）、产出 diff 与验收结果回执、失败重试 | 高：目前 v0，是唯一"半成品"页；也是本项目"重活外包"叙事的关键一环 | 中：需依赖 acpx 侧是否有可查询的任务状态（**先做可行性探测**） | ⭐⭐⭐ |
| 2.2 | **设置与本地数据备份/恢复**：一键导出 `.study` / `.fate` / `.avatars` / localStorage 偏好为单文件，可还原 | 高：清缓存 = 丢课表和卦例，风险真实存在 | 高（纯前端 + 现有中间件加一个打包端点） | ⭐⭐ |
| 2.3 | **记忆桥可观测面板**：现在只有 `.bridge.log`。做一个页面展示三腿最近一次运行状态、产出条数、失败原因、被拒原文 | 中高：记忆桥是系统"心脏"，坏了没人知道（本次 §3.2 类问题就是这么藏住的） | 高（读日志文件 + 状态 JSON 即可） | ⭐⭐ |
| 2.4 | **会话搜索与导出**：服务端有全文 SQLite，前端加会话内/跨会话搜索 + Markdown 导出 | 中：会话越攒越多， retrieval 缺失会越来越痛 | 中：需确认 `sessions.list`/`chat.history` 是否支持搜索参数 | ⭐⭐ |
| 2.5 | **前端可观测性页**：把 `[gateway]` 前缀的控制台日志接进一个可筛选的页面面板 | 中：排障时不必开 DevTools，也便于用户自助反馈 | 高（包一层 console + 环形缓冲） | ⭐ |
| 2.6 | **长会话性能**：`loadHistory` 分页 + 消息列表虚拟滚动 | 中：目前一次性拉全量，长会话会拖慢 | 中 | ⭐⭐⭐ |
| 2.7 | `styles.css`（2,052 行）按区域拆分为 `styles/` 多文件 | 低中：纯可维护性 | 高（CSS 无构建风险） | ⭐⭐ |

### P3 — 架构演进（长期，先看需求再动）

| # | 建议 | 价值 | 可行性 | 难度 |
| --- | --- | --- | --- | --- |
| 3.1 | **后端层独立**：README 已声明中间件"可原样搬进任何 Node HTTP 服务器"——那就真拆出 `server/index.mjs` 独立进程，Vite 只做 `/__rana` 转发 | 中高：解耦后前端可独立部署、后端可独立重启（现在改中间件必须重启 Vite） | 中：需处理双进程生命周期，与"单进程零部署"的初衷有取舍 | ⭐⭐⭐ |
| 3.2 | **类型契约从手写改为 schema 校验**：前后端共享一份 zod/TypeBox schema（`@openclaw/gateway-protocol` 已在用 TypeBox），端点响应运行时校验 | 高：直击 §4.2 白屏事故根因 | 中：改造面大，建议随 1.1 拆分同步做 | ⭐⭐⭐ |
| 3.3 | **人格与主题外置为配置**：把"她的房间"配色、文案、角色设定抽成 `persona.json`，让本项目可被复用为"任意角色的本地 AI 伙伴框架" | 中：从"Rana 的家"升维成"可复用框架"，是开源价值的最大跃迁点 | 中 | ⭐⭐⭐ |
| 3.4 | 增量会话列表（`sessions.changed` 携带 diff 时改增量 patch，否则仍全量） | 低中 | 依赖上游事件是否带 diff | ⭐⭐ |

---

## 6. 建议的实施顺序

```
第 1 批（今晚）—— 止血
  0.1 ALL_VIEWS 修复  →  0.2 早报 SecretRef  →  0.3 映射外置  →  0.4 ErrorBoundary  →  0.5 文档校正

第 2 批（下一个周末）—— 减重，为所有后续提速
  1.5 vitest 首批测试（先给 reasoning/fateCore 上保险）
  1.4 lib/rana-config.mjs 统一配置
  1.2 + 1.3 合并 agent-bridge 与 openclaw-client（顺手把 1.4 接进去）
  1.1 拆分 vite.config.ts（这一批的最后一步，前面拆完了它自然就薄了）

第 3 批 —— 按兴趣选做
  2.3 记忆桥面板（强烈推荐，它是系统健康度的晴雨表）
  2.1 派活闭环  →  2.2 备份恢复  →  2.4 会话搜索
```

**排序理由**：P0 全是"低成本、立刻见效"，且 0.3 涉及隐私暴露面（虽非输出侧，但公开仓库与云端 prompt 都是实际暴露）；P1 的拆分与测试是**给 P2/P3 铺路**——在 2,339 行单文件和零测试上直接做"派活闭环"必然返工。2.1 建议先做 acpx 侧可行性探测再排期，避免写一堆 UI 却拿不到任务状态。

---

## 7. 值得保留、不要动的东西

- `gateway.ts` 的乐观 UI 与去重三件套——每一招都对应一次真实事故，重构风险远大于收益。
- `memory-bridge.mjs` 的隐私分层（提炼在哪边、原文就在哪边）——这是本项目最有复用价值的设计思想。
- `KNOWN-ISSUES.md` + 双层 AGENTS.md 的台账制度——项目最值钱的资产，继续坚持"解决后必须回写"。
- `tools/embedding-watchdog.mjs` 的"用看门狗锁死不变量"思路——把玄学运维变成可验证闭环。

---

*本报告基于静态代码分析，未启动服务验证。§3 的三项缺陷均有文件与行号证据；§4 为静态推断，建议在修复 P0 后按 §6 顺序推进。*
