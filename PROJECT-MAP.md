# PROJECT-MAP — 面向 AI 的项目地图

> **给谁看**：任何第一次进这个仓库的 code agent（ZCode / Claude Code / Codex / trae…）或新窗口。
> 读完本文 ≈ 10 分钟建立全貌：这是什么项目、代码在哪、从哪入手、什么不能碰。
> **配套**：规矩看 [AGENTS.md](AGENTS.md)（精简入口）；排障看 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)（问题台账，顶部有索引）；
> 对齐**当前真实状态**看 [PROJECT-STATE-2026-10-17.md](PROJECT-STATE-2026-10-17.md)（实查核验版——旧文档骗人是实锤过的，见其附录 A）。
> **更新纪律**：动结构（加目录/挪文件/加端点/换脚本）必须同步本文。最后核验：2026-10-24（目录、git、package.json 逐项实查）。

---

## 0. 这是个什么项目（30 秒）

个人项目「Rana · OpenClaw」：以开源 AI 助手框架 **OpenClaw**（npm 包 `openclaw`）为底座，在一台 Windows 主机上跑多个性格分工的 AI 智能体，再用全自研 Web 前端 **rana-web** 装进一个界面。人格原型是 MyGO!!!!! 的要乐奈（主色 #77DD77）。

- 三个 agent（作者自用配置，开箱默认单 agent）：`main`（云端干活主力，QQ 私聊+网页）、`rana-rp`（RP 陪伴人格，微信，云端中转模型经本地小代理）、`rana-qq-public`（QQ 群公共号，物理隔离）。
- **rana-web 没有独立后端进程**：22 组 Vite 中间件（`/__rana/*`，仅本机回环）就是"后端"。
- 自动化全是**边车脚本 + cron + 文件契约**：脚本独立进程跑完退出，输出落本地 JSON，前端只读文件。
- 隐私是一等公民：本仓库经 `push-public.cmd`（`git add -A` 全量）镜像到公开仓库，**任何入库文件默认视为公开**。

```
渠道层   微信→rana-rp   QQ私聊→main   QQ群→rana-qq-public   浏览器:5173→rana-web
           └────────────┴──────┬──────┴────────────┘
调度层   OpenClaw 网关 :18789（WebSocket 协议 v4，SQLite 存会话/cron，openclaw.json 热重载）
           bindings 路由 · cron 班表 · 记忆桥 · 插件 8 个 · acpx 派活
干活层   轻活 main 自己干（搜索/浏览器/文件）；编码重活→acpx→DSH（WSL 里的 DeepSeek 工人）
模型层   云端：main/公共号 deepseek-v4.1-flash、RP nalang（经本地 sse-fix-proxy :18801）
         本地：LM Studio :1234（微调 14B 在库可切回）+ qwen3-embedding（CPU 常驻，看门狗锁单实例）
```

---

## 1. 代码地图（改东西前先在这里定位）

### 1.1 根目录

| 路径 | 是什么 | 进公开仓? |
| --- | --- | --- |
| `README.md` | 人看的长文档（82KB：架构/功能/协议/运维全覆盖，双受众） | ✅ |
| `AGENTS.md` | code agent 入场规矩+速览（AI 进场第一份） | ✅ |
| `PROJECT-MAP.md` | 本文：面向 AI 的地图+入手路由+时间线 | ✅ |
| `KNOWN-ISSUES.md` | 工程问题台账（95 条，症状/根因/方案/状态，顶部有索引） | ✅ |
| `PROJECT-STATE-2026-10-17.md` | 实查状态快照（挂账/红线/实查配方，**对齐现状以此为准**） | ✅ |
| `PROJECT-ANALYSIS.md` / `OPTIMIZATION-ROADMAP.md` / `SYSTEM-MAINTENANCE-PLAN.md` | 历史文档（09-14/09-17，已加过期横幅留档） | ✅ |
| `OPEN-SOURCE-ROADMAP.md` | 开源五阶段任务书（阶段〇/二已完成，阶段一=测试/CI 已补） | ✅ |
| `TASK-TRAE-2026-10-17.md` | 测试骨架四批次任务书（**已收官**，A/B/C/D 全合入） | ✅ |
| `setup.cmd` / `setup.mjs` / `setup-templates/` | 开箱初始化 + 出厂模板（单 agent 骨架 + SOUL/USER/MEMORY 三件套） | ✅ |
| `skills/` | **可公开的技能母本**（运行时技能在状态目录，改完拷过去生效；现只有 `daily-report/` 收日报） | ✅ |
| `tools/` | 常驻守护脚本 + 人格回归测试（见 §1.5） | ✅（rp-soul-test 尚未提交） |
| `.github/workflows/ci.yml` | CI：push/PR → `rana-web` 下 `npm ci → build → test`（2026-10-17 首跑绿） | ✅ |
| `backup-dbs.cmd` | 每日本地 DB 快照到另一块盘 | ✅ |
| `rana-web/` | ★ 自建 Web 前端 + 边车脚本（见 §1.2–1.4） | ✅ |
| `.openclaw/.openclaw/` | **OpenClaw 运行时状态**（配置/会话库/记忆/人格），gitignore | ❌ 私有 |
| `push-public.cmd` / `backup-private.cmd` | 公开推送 / 私有备份脚本（含私有地址），gitignore | ❌ 私有 |
| `rp-tune/` / `rp-eval/` / `lmctl/` / `dsh-reference/` | RP 微调管线 / RP 评测 / LM Studio 控制台 / DSH 参考仓克隆，gitignore | ❌ 私有 |
| `.zcode/ .trae/ .workbuddy/ .mimosa/ .kilo/` | 各 AI 工具的本地会话数据，gitignore | ❌ 私有 |

### 1.2 rana-web 前端（React 18 + TS + Vite 6 + zustand，无 UI 框架全手写 CSS）

| 文件 | 职责 | 备注 |
| --- | --- | --- |
| `src/lib/gateway.ts` | ★ 连接层核心（约 760 行）：Ed25519 握手、req/事件 RPC、无限指数退避重连、乐观创建/删除、三路去重 | **别乱动**（踩坑换来的防御工事） |
| `src/lib/reconnectBackoff.ts` | 重连退避纯函数（1s→30s 封顶），vitest 4 用例 | 10-17 批次 D 抽取 |
| `src/lib/types.ts` | ★ `NAV_TABS` 页签**单一来源**（12 页签，拖拽排序记本地） | 加页签必经此处，别处别抄清单 |
| `src/lib/reasoning.ts` | 脏输出清洗管线：`<think>`/`<details>` 折叠、信封剥离、回声检测 | vitest 覆盖 |
| `src/lib/fateCore.ts` / `fateGlossary.ts` / `hexagrams.json` | 八字/紫微/干支/64 卦**纯浏览器本地计算** + 术语大白话注释 | 有"卦表系统性颠倒"前科，改命理表必须全量对拍权威源 |
| `src/lib/identity.ts` / `fetchRetry.ts` / `theme.ts` / `lmstudio.ts` / `studyNotify.ts` | 设备身份 / 带重试取数 / 主题 / LM Studio 面板 / 课表通知 | — |
| `src/store/useAppStore.ts` | zustand 全局状态（会话/消息/运行态/未读/置顶/页签顺序） | — |
| `src/App.tsx` | 12 个页面视图装配，每页套 ErrorBoundary（坏一块不白全站） | — |
| `src/styles.css` | 单体样式表（约 2489 行，房间场景/主题变量都在这） | 尾部追加别重排 |
| `src/components/` | 会话三件套 Sidebar/ChatStream/Composer + Topbar/TopNav/Room/Markdown/RanaArt；12 页面组件（SysPage/CronPage/ApprovalsPage/NewsPage/PlanningPage 四合一/BangumiPage/AppsPage/GroupsPage/DshPage/MemoryPage/**TracePage**🔍过程/CalendarPage）；面板弹窗（UsagePanel/SettingsModal/CloudConfigModal/LmStudioModal/SystemCleanupModal/ModelTuningCard/AgentKitCard） | 玄学子组件在 `apps/`（排盘/摇卦/万年历/术语） |
| `tests/unit/` + `vitest.config.ts` | 5 个测试文件共 **109 用例**：reasoning / fateCore / git-activity-lib / memory-bridge-parse / reconnect-backoff | `npm test` 跑 |
| `vite.config.ts` | 仅约 35 行装配（react + buildServerPlugins + /gateway、/lmstudio 代理） | **别往里塞功能**，实现在 server/ |

**加一个页面的四步链**：`src/components/` 建组件 → `App.tsx` 挂视图 → `types.ts` 的 `NAV_TABS` 加页签 → 需要本地数据就在 `server/plugins/` 加中间件并到 `server/index.ts` 装配。（历史上"四处注册漏一处"出过页签永不可达的 bug，见台账 09-14 条目。）

### 1.3 rana-web/server/ — 没有后端的全栈（22 组中间件，`/__rana/*`）

`server/index.ts` 装配 `buildServerPlugins()`；`server/lib/` 四个公共工具（paths 状态目录/config 读 openclaw.json/exec/http 回环校验）。所有**写操作**端点双重来源校验：socket 本机回环 + Origin 匹配 localhost。

| 插件文件 | 端点 | 一句话职责 |
| --- | --- | --- |
| dev-config.ts | `GET /__rana/config` | 发网关 token（**仅 dev 模式**挂载） |
| agents.ts | `GET /__rana/agents` | agent 清单，前端按配置显隐多智能体入口 |
| provider-config.ts | `/__rana/provider-config`、`/provider-models` | 云端 provider 增改删（写 openclaw.json 热重载；key 打码、删前引用检查、写前 .bak）+ 服务端代理拉模型列表 |
| model-test.ts | `POST /__rana/model-test` | 模型连通实测（key 只在服务端，不进前端不进日志） |
| model-params.ts | `POST /__rana/model-params` | 本地模型超参（白名单数值键，仅本地 provider） |
| sys-status.ts | `/__rana/sys/*` | status（硬盘/CPU/显卡+每进程显存/端口/网速/外网，8s 缓存）/ power / virt（UAC 提权切虚拟化） |
| avatar.ts | `/__rana/avatar` | 自定义头像（≤4MB，白名单类型，存本地） |
| news.ts | `/__rana/news` | 早报读取+触发生成（子进程互斥锁防并发） |
| study.ts | `/__rana/study/*` | 课表+待办+开课（**1068 行最大插件**；数据 `.study/`；排课走专用会话桥） |
| life.ts | `/__rana/life/*` | 人生目标/里程碑/内容库（845 行；数据 `.life/`；URL 服务端直抓**拒绝内网地址**） |
| events.ts | `/__rana/events` | 全局日历事件读写（数据 `.life/`） |
| fate.ts | `/__rana/fate/*` | 问卜档案+解卦转发（数据 `.fate/`；命盘浏览器本地算） |
| bangumi.ts | `/__rana/bangumi/*` | 追番：今日放送/搜索/封面代理转发（60 分钟缓存，白名单 CDN） |
| agent-info.ts | `GET /__rana/agent-info` | 技能+MCP 装备清单（CLI 子进程，按 agent 缓存 120s） |
| qq-profile.ts | `GET /__rana/qq-profile` | 群画像**纯只读**展示 |
| dsh-models.ts | `GET /__rana/dsh-models` | 读 WSL 里 DSH 的模型清单（读不到返回空） |
| approvals.ts | `/__rana/approvals*` | 审批挂起卡/历史/长期许可（2026-09-22 起审批已整体关闭，页保留查询） |
| context.ts | `GET /__rana/context` | 会话上下文体检（token 构成，只读） |
| memory.ts | `/__rana/memory` | 记忆页读写（**白名单制**：key→路径映射在服务端，机器维护文件 editable=false） |
| bridge-sync.ts | `/__rana/bridge-sync` | 🔗 记忆同步按钮：启动/轮询双桥一轮 |
| sessions-cleanup.ts | `/__rana/sessions-cleanup` | 系统会话清理手术（--dry-run 只盘点） |
| trajectory.ts | `/__rana/trajectory` | 🔍 过程页：按 run 导出会话轨迹（events.jsonl，瘦身 2137KB→212KB） |

### 1.4 rana-web 根目录的边车脚本（cron 自动化，独立进程跑完退出）

形态纪律：**独立 Node 脚本 + cron 触发 + 文件契约**——不依赖网关进程内任何东西，输出落本地 JSON，前端只读文件。

| 脚本 | 班次 | 数据落点 |
| --- | --- | --- |
| memory-bridge.mjs | 每小时 :00 | 三腿共享记忆桥（main⇄RP 双向+群聊→main 单向；纪要+晚报安全摘要 evening-digest.md）；化名映射 `memory-bridge.identity.json`（gitignore） |
| memory-bridge-parse.mjs | （被桥调用） | 纪要解析纯函数（批次 B 抽取，22 用例） |
| private-memory-bridge.mjs | 每小时 :17 | 私密记忆桥（**gitignore 私有**，全链路本地） |
| news-report.mjs | 每天 08:00 + 页面按需 | `.news/report.json` |
| health-patrol.mjs | 每 30 分钟 | `.health/patrol.json` + `patrol-status.md`（四项体检零模型调用；异常白天聚合发 QQ） |
| backup-check.mjs | 23:00 / 23:05 | 备份健康 fail-closed 判定（异常才告警） |
| git-activity.mjs / git-activity-cron.mjs / git-activity-lib.mjs | 21:30 日 / 周一 / 月 1 号 | Git 活动统计（只统计已推送提交；自动提交按前缀单独归栏；报告落盘由独立任务分段推 QQ） |
| study-agent.mjs / fate-agent.mjs / life-agent.mjs | 页面按需触发 | 专用会话桥三薄封装 → 会话 `agent:main:study-planner` / `fate-teller` / `life-planner`（180~285s 超时+互斥） |
| lib/agent-bridge.mjs / lib/rana-config.mjs | （共享库） | 三桥共享实现 / 状态目录定位+SecretRef 解析 |
| cron-session-cleanup.mjs | 手动（会话页入口） | 系统会话清理手术 |
| start-rana.cmd / start-gateway.cmd | 双击 | 一键启动（网关+Vite+浏览器）/ 网关启动器（顺带拉起两个看门狗，端口锁防多开） |
| local-overrides.cmd（gitignore）/ local-config.json（gitignore） | — | 本机个性化覆盖；模板见 `.example.cmd` / `.example.json` |
| docs/observability.md | — | 可观测性字典（chat 五态/事件面/导出格式） |
| design-mockups/ | — | v2 界面五版设计稿（纯 HTML 原型） |

### 1.5 tools/ 与 skills/

| 路径 | 职责 |
| --- | --- |
| `tools/embedding-watchdog.mjs` | 随网关常驻：锁死 embedding「恰好一份、ctx 2048、纯 CPU」，违例自动卸载重载 |
| `tools/sse-fix-proxy.mjs` | 随网关常驻 :18801：RP 中转站 SSE 缺结束标记就补上 + content 块数组拍平（10-03 blocks-flatten 刀）；**密钥不落代理** |
| `tools/rp-soul-test/` | RP 人格回归测试（10-23 新增，**尚未 git 提交**）：智谱 glm-5.3 / glm-5.3-flash 双档对比；`reports/` 已被自己的 .gitignore 挡住不入公开仓 |
| `skills/` | 技能公开母本。运行中的技能在 `<状态目录>/workspace-<agent>/skills/`（隐私区）；关系=这里改完拷贝过去生效。现只有 `daily-report/`（QQ 邮箱收日报） |

### 1.6 运行时状态目录（`.openclaw/.openclaw/`，全 gitignore）

改运行时配置必须带 `OPENCLAW_STATE_DIR=K:/OpenClaw/.openclaw/.openclaw`（或依赖脚本相对推导）。里面有：`openclaw.json`（主配置，保存即热重载）、`state/openclaw.sqlite`（cron 库——**读任务真相的唯一权威**）、`agents/*/agent/*.sqlite`（会话库）、`workspace-*/`（人格 SOUL.md 与记忆）、`private-memory/`、`mcp-servers/fate.mjs`（群算卦八工具，懒加载无需重启）、`tmp/apply-*.cjs`（**openclaw 升级后的补丁重打脚本**，见 §4）、`backups/`。

---

## 2. 数据都落在哪（全在本地，除注明外均 gitignore）

| 目录 | 内容 | 归属 |
| --- | --- | --- |
| `rana-web/.study/` | 课程表 schedule.json + 学习资料 + 错题本 | 规划页 |
| `rana-web/.life/` | life.json 人生目标 / library.json 内容库 / 日历事件 | 规划页 |
| `rana-web/.fate/` | profiles.json 生辰档案（可多人） | 程序页玄学 |
| `rana-web/.bangumi/` | 追番清单 | 追番页 |
| `rana-web/.news/` | 早报 report.json | 早报页 |
| `rana-web/.health/` | 巡检快照（2 天历史） | 状态页巡检卡 |
| `rana-web/.avatars/` | 自定义头像 | 外观设置 |
| `rana-web/.git-activity/` | Git 活动报告产物（含私人仓库标题，禁公开） | git 日报 |
| `.openclaw/.openclaw/` | 配置/会话库/人格/记忆/cron 库 | 网关 |

---

## 3. 怎么跑起来 / 怎么验证

```bash
# 开箱（新机器）：双击 setup.cmd → 双击 rana-web\start-rana.cmd → 页面填 API key
# 日常启动：双击 rana-web\start-rana.cmd（网关 18789 + 前端 5173 + 自动开浏览器，可重复执行）

# 测试与构建（在 rana-web/ 下）
npm test          # vitest，109 用例（CI 同款）
npm run build     # tsc -b && vite build
npm run preview   # 生产预览（中间件同样挂载，token 端点除外——刻意设计）
```

- **CI**：`.github/workflows/ci.yml`，push/PR 自动跑（node 22 / working-directory=rana-web / npm ci→build→test）。
- **重启网关**：任务管理器杀 node → 重跑 `rana-web\start-gateway.cmd`（无服务注册，进程死了就是死了）。**重启后 3-5 分钟插件装载期连不上属正常**；超 10 分钟无日志+CPU 归零才是卡死病，补一刀重启。
- **日志速查**：

| 位置 | 看什么 |
| --- | --- |
| `%TEMP%\openclaw\openclaw-当日.log` | 网关主日志（JSON-lines；搜 `stalled session`/`timer tick failed`/`cron: job`） |
| `rana-web/.gateway.log` | 网关启动窗口重定向 |
| `%TEMP%\openclaw\embedding-watchdog.log` / `sse-fix-proxy.log` | 两个常驻守护 |
| `K:\OpenClaw\.openclaw\.openclaw\private-memory\.bridge.log` | 私密桥业务输出（回执 ok 也可能静默降级，验收要 tail 它） |

---

## 4. 按任务入手（路由表）

| 你要干嘛 | 先读 | 再动 | 特别注意 |
| --- | --- | --- | --- |
| 排障 | KNOWN-ISSUES 顶部**索引**→按症状关键词搜 | 照方抓药；>10 分钟的坑解决后**回写台账** | 台账是"写给下一个 agent 的程序" |
| 对齐项目现状 | PROJECT-STATE-2026-10-17 + 其附录 B 实查配方 | 以 cron 库/代码/git 实查为准，文档只做线索 | 旧状态骗人实锤过 |
| 加页面/页签 | §1.2 四步链 | components→App.tsx→NAV_TABS→(可选)新中间件 | 页签清单单一来源在 types.ts |
| 加后端端点 | 照 §1.3 任一插件抄 | `server/plugins/` 新文件 + `index.ts` 装配 | 回环+Origin 双校验必抄；写前 .bak |
| 改连接层 | 台账"乐观/去重/闪回"相关条目 | gateway.ts | ⚠️ 禁触区：pendingCreates/deletingKeys/deleteChain/finalRunIds 等乐观更新状态机 |
| 改命理/卦表 | — | fateCore.ts / hexagrams.json / 状态目录 gua.mjs | **必须全量对拍权威源**（64 卦曾系统性颠倒+履卦丢失两案） |
| 加定时任务 | README「全系统班表」章 | 独立脚本+`openclaw cron`（带 STATE_DIR；Windows 用 `--command-argv` JSON 数组）；改完回读 sqlite 核验 | 隔离会话**禁 exec**（审批送不到=900s 死循环）；长文本走 UTF-8 临时文件别信控制台引号 |
| 加技能 | skills/README.md | 运行时装 `<状态目录>/workspace-<agent>/skills/`；可公开的拷 `skills/` 母本 | 装东西必须主人明确批准 |
| 改人格 | setup-templates/ 看出厂模板 | 状态目录 `workspace-*/SOUL.md`（私有）；新会话生效 | 人格文件永不入公开仓 |
| 升级 openclaw | 台账 10-01 升级条目 + §1.6 | **先手动备份全部 agent 库**（`agents/*/agent/*.sqlite`，自动快照只保 state 库）→ 升级 → 跑 `state tmp/apply-*.cjs` 全套重打 | 本机 dist 补丁：env-clone-fix / scope-closed-fallback / pmgate（读工具硬闸门）/ creation-pub（\\?\ 前缀）/ worker-cpu / qqbot 收图+/helps 补丁——**漏一个出怪病** |
| 改 RP 链路 | 台账 09-25 / 10-03 条目 | sse-fix-proxy.mjs | 会话钉子只有一种合法清除形态：删光 override 字段 |
| 提交/推送 | AGENTS.md 铁律 | push-public.cmd 是**主人手动**跑的（git add -A 全量） | 任何新文件默认将公开，密钥/私人内容先查 .gitignore |

---

## 5. 红线（违反=事故，完整版见 PROJECT-STATE §3）

1. **公开镜像纪律**：`push-public.cmd` 是 `git add -A` 全量提交——密钥/token/个人账号 ID/私有仓库地址**绝对禁入**；不确定先看 `.gitignore`（根 + rana-web 两份）。
2. **运行时状态不进 git**：`.openclaw/` 整体封禁；改运行时配置带 `OPENCLAW_STATE_DIR`。
3. **隔离会话（cron/isolated）禁 exec**；exec 审批白名单只放 git.exe，**解释器永不放行**。exec 审批主会话侧 09-22 起整体关闭（自动化优先，主人拍板）。
4. **密钥只在密钥库与 gitignore 文件里**；日志/文档/报告不落密钥。
5. **并行会话常发生**：README/台账可能正被另一个窗口编辑——Edit 前重读，提交前 `git status` 看一眼。
6. **别动的资产**：gateway.ts 乐观更新与去重、记忆桥隐私分层、KNOWN-ISSUES 台账制度——重构风险>收益。
7. 不确定就问主人，不许猜；没提过的功能不做（全局红线在本仓库同样生效）。

---

## 6. 文档地图（哪份管什么、新鲜度）

| 文档 | 角色 | 新鲜度 |
| --- | --- | --- |
| AGENTS.md | AI 入场规矩+速览（每会话自动注入） | 活文档 |
| PROJECT-MAP.md（本文） | AI 地图：结构/入手路由/时间线 | 活文档（动结构必须同步） |
| KNOWN-ISSUES.md | 问题台账（排障先查；解决后回写；顶部索引） | 活文档，新条目永远加顶部 |
| PROJECT-STATE-2026-10-17.md | 权威现状快照（挂账分层/红线/实查配方） | 基线 10-17；大施工后应出新版 |
| README.md | 人看的长文档（架构/功能/协议/运维） | 10-17 对齐过 |
| rana-web/docs/observability.md | 可观测性字典（chat 五态/事件面/导出） | 10-14 |
| OPEN-SOURCE-ROADMAP.md | 开源五阶段任务书 | 活文档（阶段一测试/CI 已补，阶段三英文门面待做） |
| PROJECT-ANALYSIS.md / OPTIMIZATION-ROADMAP.md / SYSTEM-MAINTENANCE-PLAN.md / TASK-TRAE-2026-10-17.md | 历史留档（均带状态横幅） | 已完结，别当现状 |

---

## 7. 演进时间线（changelog 摘要，源自 git log；详细根因都在 KNOWN-ISSUES）

- **2026-09-08 建仓**：Rana Web UI 起步（会话/重命名/置顶）。
- **09-09 ~ 09-12**：前端骨架成型（思考折叠/云端配置/乐观更新）、QQ 接入三连环、命理页、多 agent 化、记忆桥上线。
- **09-13 ~ 09-16**：心跳瘦身（500 万 token/天→10 万）、学习计划+待办+规划页四合一、萌娘百科 MCP 防幻觉、发行版打包落地（setup.cmd 开箱即用）。
- **09-17 ~ 09-22**：系统维护第一批（cron 清僵尸/备份修复/取数重试）、两层 AGENTS.md 体系、审批页、git 日报三跳演进、模型 maxTokens 全量补齐。
- **09-25 ~ 09-30**：SSE 修复代理（RP 中转站缺结束标记）、记忆页、群聊算卦全家桶（撤回/邮件报告/档案）、/helps 秒回补丁。
- **10-01 ~ 10-04**：升级 openclaw 2026.9.7 + QQ 插件 2.0.4——本机 dist 补丁时代开始（DataCloneError / Async work scope / pmgate 硬闸门 / \\?\ 路径前缀 / 空转烧核五连案全破）；RP 真病根=中转站不认 content 块数组，代理拍平根治。
- **10-06 ~ 10-11**：记忆桥 RP 腿云端优先 + 晚报安全摘要；vite.config 拆出 server/ 目录（5000→35 行）；三 agent 桥合并。
- **10-14 ~ 10-17**：可观测性落地（🔍过程页轨迹回放）；**测试与 CI 从零到一**（vitest 109 用例四批次 + GitHub Actions + 断线重连加固，任务书收官）；PROJECT-STATE 实查快照诞生（三家 AI 照抄旧文档集体翻车后）。
- **10-20**：群算卦断链三段案收口——自建 fate MCP 八工具（不开 exec）；exec 空 allowlist 空转修复；skills/ 公开母本（daily-report）。
- **10-23 ~ 10-24**：tools/rp-soul-test 人格回归工具（智谱双档对比，未提交）。
- **10-24**：面向 AI 文档体系落地（本地图谱/AGENTS 入口/台账索引）；真名脱敏手术——公开仓历史重写强推（**10-02 起 hash 全部换代，旧 hash 引用仅作时间线索**）；私有仓越权手术当日全部还原（详见台账 10-24 条目）。

---

*本文由 ZCode 整理于 2026-10-24。发现与事实不符：以真相为准，回来改本文——别让它变成下一份骗人的旧文档。*
