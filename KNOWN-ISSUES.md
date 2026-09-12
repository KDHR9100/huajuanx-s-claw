# KNOWN-ISSUES.md — 工程问题台账

> **给所有访问本仓库的读者（人类与 code agent）**：这里是本项目的疑难问题登记簿。
>
> - 排障耗时超过十分钟、疑似上游/平台 bug、环境怪癖的问题 → **先查本文件**，命中直接复用方案，别重新踩一遍。
> - 新问题没登记过 → 按【条目模板】加到【登记区】顶部（新条目在上）。
> - 问题解决后**必须回来**补「解决方案」并更新状态；确认是平台/上游限制的，写清缓解办法。
> - **隐私红线**：本仓库经 `push-public.cmd` 镜像到公开仓库且是 `git add -A` 全量提交——禁止在本文件写入密钥、token、个人账号 ID、私有仓库地址。
>
> **条目模板**：
>
> ```
> ## [状态：未解决/已解决/上游限制] 一句话标题（登记日期）
> - 症状：
> - 根因：
> - 解决方案：
> - 状态：
> ```

---

## 登记区

## [已解决] QQ 机器人接入三连环坑：私聊默认全拦 / 多 agent 必须显式绑定 / 通道会话混入主窗口（2026-09-12）

- 症状：`openclaw channels add --channel qqbot` 成功、日志 `gateway READY`，但 QQ 私聊无回复。日志三种形态依次出现：`[access] blocked c2c from <openid>: not in allowFrom`（权限拦）→ 修权限后 `dispatch error: AgentSelectionRequiredError: ... no explicit owner`（路由缺）→ 修路由后消息落入 `agent:main:main` 主会话（与微信/网页三个入口混一个上下文）。
- 根因：①channels add 生成的默认 allowFrom 不放行任何真实用户，dmPolicy=open 下所有私聊被静默丢弃；②本项目 `agents.ownership=explicit` 且多 agent（main/rana-rp），每个通道必须在顶层 `bindings` 有显式 owner；③通道级绑定默认把消息路由进 agent 主会话，多通道共享聊天上下文。
- 解决方案：①`allowFrom` 填对方 openid（QQ 开放平台匿名 ID，从被拦日志直接抓，**不是 QQ 号**）并 `dmPolicy=allowlist`（白名单制）；②`bindings` 加 `{"type":"route","agentId":X,"match":{"channel":"qqbot","accountId":"default"}}`；③窗口要分开就绑**不同 agent**（各 agent 独立 sqlite，天然隔离）。终态布局（2026-09-12 用户两次调整后定稿）：**QQ→main（云端 flash，QQ 客户端功能多）、微信→rana-rp（本地 14B，RP 乐奈）**。**⚠️ 第四坑（同晚实证）：bindings 改 agentId 对"已活跃会话"热重载不生效**——运行中网关的会话路由粘在旧 agent 上（QQ 新会话能生效、微信老会话不跟），CLI `agents bindings` 读到的配置是对的但网关行为不对，表现为"改完绑定微信还是走云端"。解法：重启网关（清掉全部路由缓存），别信热重载。QQ 开发者控制台"未连接"指示灯不可信——WebSocket 实连且收发正常，以实测聊天为准。
- 状态：已解决（2026-09-12 全链路验证：收消息→本地 14B 生成→回复送达，约 48s/条）。
- ⚠️ 第五坑（2026-09-13）：终态跑偏——`agents.defaults.model.primary` 被写成本地 `rana-rp-14b` 而 main 无显式 model（吃默认），`rana-rp` 条目反被指到云端 flash，表现为「QQ→main 却是本地模型回话」。解法两层：①openclaw.json 修正 defaults 与 main=云端 `aliyun-maas/qwen3.8-flash`、rana-rp=`lmstudio-local/rana-rp-14b`（网关文件监听热重载）；②**会话级钉死模型也要改**——`agent:main:main` 的 model 字段停在 rana-rp-14b，仅改配置不动会话等于没改；用网关 RPC `sessions.patch {key, model}` 热生效，无需重启网关（第四坑的「热重载不生效」只针对 bindings 换 agent，模型 patch 是即时的）。

## [行为说明] `openclaw gateway restart` 在本项目永远报错——非默认 state dir 不走服务管理（2026-09-12）

- 症状：`openclaw gateway restart` 报 `service management skipped: non-default state dir or config path. Rerun with HOME set...`；新加 channel（如 qqbot）后想重启网关生效时必撞上。
- 根因：该命令走「服务注册」式管理，要求 OpenClaw 装在默认位置（C 盘用户目录）；本项目网关由 `rana-web\start-gateway.cmd` 手动拉起（脚本内 `set OPENCLAW_STATE_DIR=K:\openclaw\.openclaw\.openclaw`，无服务注册），CLI 检测到非默认路径直接拒绝——是保护行为，不是故障。
- 解决方案：项目标准流程——用 PowerShell `Get-CimInstance Win32_Process` 找 `openclaw.mjs gateway` 的 node PID → `taskkill /PID <pid> /F` → 分离重跑 `start-gateway.cmd`（`Start-Process cmd -ArgumentList '/c','K:\OpenClaw\rana-web\start-gateway.cmd' -WindowStyle Minimized`）。验证：`%TEMP%\openclaw\openclaw-当日.log` 搜对应 channel 的 `gateway READY` / `Gateway ready`。另：裸跑 `openclaw channels add` 能写对 K 盘配置位置（CLI 自行定位），无需手动带 `OPENCLAW_STATE_DIR`。
- 状态：已解决（2026-09-12 qqbot 实证：token 获取、WebSocket 连上 sgroup.qq.com、gateway READY 均正常，微信通道同步恢复）。

## [已解决] embedding 模型双实例（qwen3-embedding-0.6b + :2）（2026-09-11）

- 症状：LM Studio 里 `text-embedding-qwen3-embedding-0.6b` 与 `text-embedding-qwen3-embedding-0.6b:2` 同时驻留（各 ~0.6GB 显存）；OpenClaw memory 子系统偶发 "memory embeddings retryable error" 重试。
- 调用方：OpenClaw **记忆子系统**（语义记忆索引）——main 与 rana-rp 两个 agent 各有一套索引，对话压缩/记忆落库后各自触发 embedding；openclaw.json 无任何 embedding 配置，属自动探测 LM Studio 模型后的 JIT 加载。
- 根因：LM Studio JIT 按「模型+配置」区分实例——**同模型不同 context_length = 两个实例**（实测一份 8192 一份 32768）；且模型卸载后的空窗期里两个调用方竞争加载也会裂开。
- 解决方案：全卸后用与 OpenClaw JIT 请求**完全一致**的参数显式加载一份常驻（无 TTL）：`POST /api/v1/models/load {"model":"text-embedding-qwen3-embedding-0.6b","context_length":32768}`；同参请求会复用不再裂开（同参复打验证仍 1 份，embeddings 调用返回 1024 维正常）。运维要点：
  - 卸载单实例：`POST /api/v1/models/unload {"instance_id":"<实例id>"}`——v1 卸载接口只收 instance_id；实例 id 与 config 从 `GET /api/v1/models` 的 `loaded_instances` 数组看（/api/v0/models 不显示 instance_id）。
  - `lms unload <key>` 会卸该模型全部实例；`lms load --context-length` 在本机对该模型报 Unknown error，改用 REST。
  - 与 09-10 的 rana-rp-14b:2 双实例同机制（当时显式加载 49152/parallel2 治好）。
- 状态：已解决（驻留 1 份 ctx 32768，复用与调用均验证）。**2026-09-12 复发**：又见 8192 实例（常驻丢失后 OpenClaw JIT 以低 ctx 先行加载），同方治理一次成功（unload → 32768 常驻重载，/v1/embeddings 实测 1024 维）。防复发要点：重启 LM Studio 或改模型配置后必查 `/api/v1/models` 各实例 ctx 与 OpenClaw JIT 请求是否一致；同窗口常驻 LLM（如 rana-rp-14b ctx 16384）同理。

## [已解决·会复发] Clash 7897 被 Windows 动态端口保留段圈占 → 代理失效 → git 推送 GitHub 挂死（2026-09-11）

- 症状：`git push` 报 `Failed to connect to github.com port 443 via 127.0.0.1`（直连被墙必须走代理）；Clash Verge 界面看似正常、clash-verge.exe / verge-mihomo.exe 进程都在，但 `netstat` 查 7897 无监听，mihomo 只开着 DNS:53。**注意与"Clash 内核半死"区分：重启 Verge 进程无效**，sidecar 日志（`%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\logs\sidecar\`）里能看到真凶：`Start Mixed(http+socks) server error: listen tcp :7897: bind: An attempt was made to access a socket in a way forbidden by its access permissions.`
- 根因：Windows 的 Hyper-V/WSL NAT（winnat 服务）会在**动态端口范围内随机圈占保留段**，本机动态端口范围被设成了 1024–15000（默认应为 49152–65535，过宽），7860–7959 保留段把 7897 圈进去，任何进程都无法绑定。保留段每次 winnat 重启/系统重启会重新随机分配，所以表现为"时好时坏"。
- 解决方案（照方抓药，需管理员）：
  1. `netsh int ipv4 show excludedportrange protocol=tcp` 确认 7897 落在某个保留段内；
  2. 提权重启 NAT 让段重算：`net stop winnat && net start winnat`（会闪断 WSL 虚拟网络）；
  3. mihomo 会被 Verge 看门自动重拉并成功绑定（验证 `netstat -ano | findstr 7897` 出现 LISTENING）；
  4. （本次未做成）趁 7897 空闲时永久保留给自己：`netsh int ipv4 add excludedportrange protocol=tcp startport=7897 numberofports=1`——端口被 mihomo 占着时 add 会失败，需先停核心。
- 预防（待拍板，未实施）：把动态端口范围收回默认高位段 `netsh int ipv4 set dynamic tcp start=49152 num=16384`，Hyper-V 就永远圈不到 7897；但不确定当初是谁把范围改到 1024 的（Docker/虚拟化软件常见），改前需确认无软件依赖。
- 状态：已解决（推送成功、7897 正常监听）；保留段随机漂移，**下次系统重启可能复发**，按解决方案 1–3 操作即可。

## [已解决·自愈] 微信会话调用 ask_user 交互工具 → 会话阻塞 15 分钟 + 同窗口微信长连接收不到消息（2026-09-11）

- 症状：凌晨微信聊天中她回完一段话后突然沉默，用户补发消息无人应答；同一轮对话微信端比 rana-web 网页端多收到一条；`openclaw channels status` 显示 weixin `running` 但 `in:` 停在最后一条成功消息时间（补发的那条根本没到网关，死信队列 `channels dead-letters list` 也是空）；网关日志每 30s 刷 `stalled session: agent:main:main state=processing reason=blocked_tool_call activeTool=ask_user lastProgress=tool:ask_user:started recovery=none`。
- 根因（两层叠加）：
  1. **ask_user 交互工具在微信渠道无法完成**：`ask_user` 是核心工具（"openclaw" 工具族，带选项的交互提问卡），微信渠道呈现不了这个交互，工具挂起、会话占线，后续消息只能排队。约 900s（15 分钟）内置超时后才释放。微信端"多的一条"疑似即 ask_user 的提问文本被推送到微信，而 rana-web 不渲染该工具事件（推断，未逐字比对）。
  2. **微信通道长连接同窗口假死**：用户补发的消息未产生任何 inbound 日志，约 15 分钟后自愈（恢复收信）。ilink 长连接假死或服务端未推，本地无法进一步区分。
- 排障抓手：网关日志（`%TEMP%\openclaw\openclaw-当日.log`）搜 `stalled session` 看 `activeTool=` 是谁卡的；`openclaw channels status` 看 `in:` 是否还在走；`openclaw sessions tail --agent main --session-key agent:main:main` 看轨迹时间线。卡住时 `approvals pending` 为空（不是审批阻塞）。
- 解决方案：本次 900s 超时后自愈（轨迹实证：04:45:47 提交 → 05:01:19 完成，随后两轮正常）。通用解法：重启网关立即清 stalled 会话并重建微信连接。**预防（2026-09-11 已实施）**：`openclaw.json` → `agents.entries.main` 加 `"tools": {"deny": ["ask_user"]}`（备份 `openclaw.json.bak-nouserask`），让她一律纯文字提问；rana-web 前端本就不渲染 ask_user，禁掉无损失。网关日志已确认热重载生效。
- 状态：已解决（自愈 + ask_user 已禁用）。微信长连接假死无根治（上游 ilink 限制），复发时重启网关即可。

## [上游限制] cron 系统收敛任务（技能回顾/心跳）不能按 agent 单独启停（2026-09-11）

- 症状：想把 rana-rp 侧的 `skill-collection-review`（每周技能收集回顾）单独停用（本地 RP 模型上下文紧张、不挂 skill，跑了纯浪费），`openclaw cron disable <id>` 与网关 WS `cron.update` 均被拒；`cron list` 默认还看不到停用任务，早报一度以为"失踪"。
- 根因：OpenClaw 把 `skillCollectionReview` / `heartbeat` 两类 payload 定义为 **system-owned monitor jobs**，"gateway-converged and cannot be created or edited through the CLI or API"；其唯一开关是全局配置 `skills.workshop.autonomous.mode`（`auto`/`propose`/`off`，默认 auto，改 `propose`/`off` 后网关收敛时把任务置 disabled）——**没有 per-agent/per-workspace 粒度**。另外 `cron list` 默认只列 enabled，`--all` 才含停用行（早报 `morning-report` 任务完好，只是 `enabled=false`，重启用 `openclaw cron enable c4d2dc88-6cab-4592-8747-aae95136547b`）。
- 解决方案：rana-web 定时任务页（CronPage）对 system-owned 任务显示「⚙ 系统」标注并禁用开关/手动运行；全局开关待用户拍板（`propose` 模式仍保留纠正提案，`off` 全关）。附带发现：cron 存储存在大小写双 store_key（`K:\openclaw` vs `K:\OpenClaw`）遗留，官方建议另找时间跑 `openclaw doctor --fix` 规范化，勿与功能改动混做。**2026-09-11 补**：早报已改为独立页面方案（`news-report.mjs` cron 任务每天 08:00 抓 CCTV 新闻联播文字版 + 博查四类目搜索，写本地 `.news/report.json`，前端「📰 早报」页渲染，不再经任何会话）；旧会话版任务保留 disabled 状态、显示名标注"旧·会话版"。
- 状态：上游限制，UI 已标注；全局开关与 doctor --fix 待用户安排。

## [已解决] Mimosa 安全钩子一刀切拦截 cron trigger-script 文件（2026-09-11）

- 症状：写任何包含 `exec({ command: "..." })`（OpenClaw cron 无头 DSL 官方形态）的触发脚本文件，即使纯常量命令串，都被 Mimosa PreToolUse 以"命令注入·高危"拦截写入（连 argv 数组形式也不放行）。
- 根因：Mimosa 的静态规则对"exec + 命令"模式直接判高危，无法区分有无用户输入拼接；属误报但不可绕（也不应绕安全钩子）。
- 解决方案：放弃 trigger-script 方案，改用 `--session main --system-event`（纯文本走 CLI 参数，不经文件写入）让 main 会话的 Rana 自己跑统计脚本（实测 main 有 exec 权限且能产出人话汇报）。system-event 触发的回复默认可能 `NO_REPLY` 静默，事件文本里写明"必须汇报、不许 NO_REPLY"即可。同日另注：vite.config.ts 中间件用 `execFile(file, args[])` 数组参数形式（powercfg/nvidia-smi/powershell），未触发 Mimosa。
- 状态：已解决（Git 活动日报/周报/月报三个任务均跑通）。

## [已解决] Git 活动统计口径（自动同步提交灌水）（2026-09-11）

- 症状：直接 `git log --since` 统计"今天干了什么"会被 push-public.cmd / backup-private.cmd 的自动提交（`sync: <日期>` / `backup <日期>` 前缀）灌水，行数虚高到不可读。
- 根因：本仓库日常由两个脚本全量自动提交推送，机器提交与人工提交混在同一 main。
- 解决方案：`rana-web/git-activity.mjs` 按前缀正则（`^sync:` / `^backup\s`）把自动提交单独归栏（「实质工作」/「自动同步」两栏分开计数，代表性提交只取实质工作）；统计口径=origin/main 已推送提交（推送后本地 remote-tracking 引用即更新，无需联网 fetch）；边界写死本地时区（今日=00:00 起、周=上周一~周日、月=自然月）。WSL 四项目走 UNC（`\\wsl.localhost\Ubuntu-22.04\...`）直读。仓库清单在 `git-activity.repos.json`（已 gitignore，含本地路径不外泄）。
- 状态：已解决（daily/weekly 手动跑通，数字与手查 git log 一致）。

## [已解决] Windows 子进程输出中文乱码（powercfg GBK / PowerShell UTF8）（2026-09-11）

- 症状：vite 中间件 `execFile("powercfg", ["/list"])` 按 utf8 解码，中文电源计划名（"平衡"等）全成乱码；而 PowerShell 的 Get-Volume 卷标正常。
- 根因：powercfg.exe 输出跟随系统代码页（GBK/CP936），node 默认按 utf8 解码；PowerShell 侧因为脚本里显式设了 `[Console]::OutputEncoding=UTF8` 所以正常。
- 解决方案：`execFile(..., { encoding: "buffer" })` 拿原始字节，`new TextDecoder("gbk").decode(Buffer.from(stdout))`（Node 18+ 自带 full-icu 可用）。
- 状态：已解决（电脑状态页四个计划名显示正常）。

## [已解决·待用户日常复验] 本地 RP 会话频繁压缩 + LM Studio 同模型双实例 → 显存爆（2026-09-10）

- 症状：12GB 卡上 LM Studio 同时驻留两份 `rana-rp-14b`（第二份名 `rana-rp-14b:2`）加旧 `rana-rp-7b`，显存不够用、机器卡顿；RP 主会话每条消息背后 2-3 次本地模型调用；rana-web 里自己的消息弹两遍（见下一条）。
- 根因（三环叠加，各有独立成因）：
  1. **memoryFlush 指向旧模型**：`agents.defaults.compaction.memoryFlush.model` 仍是 `lmstudio-local/rana-rp-7b`（RP 换 14b 时漏改），每次压缩把 7b 拉进显存与 14b 并存。
  2. **压缩预算被 reserve 硬地板压死**：OpenClaw 压缩预算公式实为 `budget = contextWindow − min(20000, contextWindow − min(8000, contextWindow/2))`——reserve 有 20000 token 硬编码下限（`agent-settings` 里 `DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR=2e4`），**contextWindow 提到 24576 预算仍是 8000**，必须 ≥32768 预算才会涨。RP 提示词地板（SOUL+记忆注入）≈7-7.5k，接近预算上限 → 每 1-2 条消息就 compaction（摘要 14b + flush 7b + 回答 14b = 2-3 次调用）。
  3. **LM Studio 双实例**：`:2` 由不同加载来源/参数触发（GUI 固定聊天窗直连一份 + 网关 API JIT 一份，或 JIT 默认 ctx 与所需不一致时重复加载）。两份 14B Q4 各约 9GB，12GB 必爆。**查真实驻留用 `curl localhost:1234/api/v0/models`（`/v1/models` 会把未加载的也列出来，会骗人）**。
- 解决方案（2026-09-10 已全部实施并验证）：
  1. `memoryFlush.model` → `lmstudio-local/rana-rp-14b`（热重载生效）。
  2. `rana-rp-14b` 的 `contextWindow` → 32768、`params.maxTokens` → 8192（防 prompt+输出顶破物理槽位）。热重载后实测诊断行 `promptBudgetBeforeReserve=12768`（旧值 8000），压缩间隔从每 1-2 条消息拉长到约 15-20 条。
  3. LM Studio 经 `POST /api/v1/models/unload` 卸掉 `rana-rp-14b:2` 与 `rana-rp-7b`；`POST /api/v1/models/load` 以 `context_length=49152, parallel=2, flash_attention=true, offload_kv_cache_to_gpu=false` 加载唯一实例——总量 49152 双槽 = 每槽 24576（**parallel 槽会平分上下文，单请求最大 ≈ 预算 12.7k + 输出 8k ≈ 20.9k < 24576 安全**）；KV 缓存放系统内存（48GB RAM 充裕），GPU 只留权重（显存占用从双实例+7b 变为稳定 ~11.6/12.3GB、利用率低）。
  4. 驻留性：显式 load 无 TTL；且共享桥（*/30）与私密桥（7,37）每 ≤30 分钟必打一次 14b，即使有 TTL 也永不到期。
  5. 验证：03:00/03:07 两桥 receipt ok 均打单实例；20.5k token 压缩摘要 + 回答端到端跑通；模型列表全程无 `:2`、无 7b。
- 遗留注意：LM Studio GUI 里直连模型聊天仍会另起一份实例——要直连测试时用完关掉，或先 `lms status` 看一眼；cron_jobs 表有旧 store_key（大写 `K:\OpenClaw`）重复行四条，receipts 验证未触发，留观。
- 状态：已解决（预算提升、单实例、无 7b 三项均有日志/接口实证）；用户日常聊天场景明早自然复验。

## [已解决·待用户日常复验] rana-web 消息气泡弹两遍（2026-09-10）

- 症状：在 RP 主会话发消息，自己的消息在界面里出现两次；只发生在本地模型长会话。
- 根因：`rana-web/src/lib/gateway.ts` 落库消息事件（`sessions.messages` 订阅）的去重只比对消息列表**最后一条**的 role+text。compaction 插在用户消息与回复之间时，服务端补发的 user 消息事件到达时列表末尾已是 assistant 回复 → 去重失效 → 重复追加。云端会话预算大不触发压缩，所以只在本地 RP 会话复现。
- 解决方案：去重改为扫最近 8 条按 role+text 匹配（`list.slice(-8).some(...)`）；`npx tsc --noEmit` 通过，vite 热更后浏览器下次打开生效。压缩频率下降后该路径本身也更少触发。
- 状态：已解决（类型检查过、逻辑对齐根因）；待用户在 RP 会话日常复验。

## [上游限制] 微信通道主动推送依赖 contextToken（2026-09-10）

- 症状：定时任务（心跳等）向微信投递汇报时报 `sendMessage ret=-3 errmsg=invalid arguments`；同一晚更早的心跳曾成功，间歇性出现。
- 根因：微信 ilink bot API **主动发消息必须携带 contextToken**（用户最近在该会话发言产生的回复凭证）。凭证缺失或过期时 API 直接拒绝，与本地配置无关。诊断方法：`%TEMP%\openclaw\openclaw-YYYY-MM-DD.log` 搜 `sendMessageWeixin`，失败前会有 `contextToken missing ... sending without context` 警告。
- 解决方案：无根治。用户在微信发任意一条消息后凭证恢复，之后主动推送即可送达（曾验证：token 存在时 356 字汇报正常送达）。可选缓解（未实施）：网关侧检测 contextToken 缺失时降级投递到 web 会话，避免汇报彻底丢失。
- 状态：上游限制，行为已确认，按上述方式规避。

## [已解决] 大文件卷入 git 备份 → 推送永久挂死 → 心跳连环超时（2026-09-09）

- 症状：私有备份脚本 push 挂起无输出或报 `TLS ... unexpected eof while reading`；心跳 cron 每轮报 `cron: job execution timed out`（600s 上限）。
- 根因：备份脚本 robocopy 全量镜像 + `git add -A`，把 4.2GB 模型分卷（单块 280~560MB）卷进提交，超 GitHub 单文件 100MB / 推送体积上限，**push 永远不可能成功**。心跳清单含"备份未推送则修复"，于是每轮救火直至超时。
- 解决方案：①对未推送提交 `git reset --soft <远端HEAD>` 重写剔除大文件后重新提交；②备份仓根加 `.gitignore`（robocopy 参数含 `/XF .gitignore`，该文件不会被源目录同步覆盖）；③`git reflog expire --expire=now --all && git gc --prune=now` 回收死对象（实测 .git 4.2GB→22MB）；④推送一次成功。
- 预防：模型/数据集等大文件永远不进 git；新增大目录时同步检查备份仓 ignore 规则。
- 状态：已解决。

## [已解决·会复发] cron 会话删除失败 "did not finish stopping"（2026-09-09，两例）

- 症状：删除 cron 产生的会话报 `UNAVAILABLE: Session agent:<x>:cron:<uuid> did not finish stopping; retry the archive`，重试永远失败。
- 根因：state 主库（`<OPENCLAW_STATE_DIR>/state/openclaw.sqlite`）的 `worker_session_placements` 残留 run 级 placement（session_key 带 `:run:` 后缀、state=local、terminal_reason=null），归档 drain 的 placement identity 校验永远通不过。上游 bug。
- 解决方案：停 gateway → 备份两个 sqlite → `DELETE FROM worker_session_placements WHERE session_key LIKE '%cron:<jobid>%'`（注意该表 `session_id` 列存的是 run UUID 不含 cron UUID，**必须按 session_key 搜**；此表在 state 主库，不在 agent 库）→ 重启 gateway → 依次调 `sessions.patch {key, archived:true}` 和 `sessions.delete {key, archivedOnly:true, deleteTranscript:true}`。
- 状态：已解决；升级版本前每次删 cron 会话都可能再遇到，同法手术。

## [行为说明] 心跳超时后 turn 仍在后台运行（2026-09-10）

- 症状：心跳 job 标记 timeout 失败后，transcript 显示 agent 仍在继续干活数分钟甚至完成汇报送达；期间手动 `cron run` 报 already-running，下一班心跳可能报 agent-tool-failure。
- 根因：cron 的 600s 执行上限只把 job 记为失败，**不终止 agent turn**。
- 解决方案：无需处理；排障时以 transcript 为准而非只看 receipt。

## [已解决] ownership=explicit 下系统级 cron 无归属 → 全部定时任务瘫痪（2026-09-09）

- 症状：所有 cron 不动，网关日志每秒 `cron: timer tick failed: Agent-less cron job has no resolvable owner`。
- 根因：memory-core 内置系统任务（做梦等）不带 agent_id，ownership=explicit 时解析不了 owner。
- 解决方案：配置 `agents.defaults.systemAgent.agentId=main`（热重载生效）。**cron 全部不动时先查网关日志 timer tick**。

## [缓解] qwen3.8 思考吃满输出上限 → 空 content → 后续轮工具授权丢失（2026-09-09）

- 症状：工具调用中途报 "Tool exec/write not found"。
- 根因：thinking 耗尽 8192 输出 token → stopReason=length 且 content 为空 → 重试轮工具授权丢失。上游 bug。
- 解决方案：该模型配置 `params.enable_thinking=false`。
- 状态：已缓解，可向上游报告。

## [已解决] Windows 网关下 cron 任务命令 spawn ENOENT（2026-09-09）

- 根因：`--command` 形式会包成 `sh -lc`，Windows 网关下无 sh 可用。
- 解决方案：一律用 `--command-argv` JSON 数组形式，路径用正斜杠。

## [已解决] 学习计划月历列宽被课程条撑爆（2026-09-12）

- 症状：月历 7 列宽窄悬殊（最窄 25px），周末列被挤没，日期数字挤成一团。
- 根因：`grid-template-columns: repeat(7, 1fr)` 的 `1fr` 最小尺寸默认是 `auto`，格子里 `.cal-course` 设了 `white-space: nowrap`，长标题把轨道顶宽。
- 解决方案：改 `repeat(7, minmax(0, 1fr))`，超长课程条走省略号 + `title` 悬停提示。修在 `src/styles.css` 的 `.cal-grid/.cal-week`。

## [行为说明] IAB 自动化点击在本机 DPI 下静默失准（2026-09-12 复现）

- 症状：Playwright locator `click()`、`dom_cua.click()`、`locator.press("Enter")` 都"成功返回"但页面毫无反应（不是超时就是无效）；元素明明可点（elementFromPoint 命中自身）。
- 根因：IAB 输入注入层坐标与本机显示缩放（≈1.61）不匹配，注入点落到元素之外。
- 解决方案：用 `evaluate` 读 `getBoundingClientRect()` 拿 CSS 坐标，**中心点 ×1.61 后用 `tab.cua.click({x,y})`**；DOM 断言与文件实况双重验证点击是否真的生效。截图管线也会偶发 30s 超时，重开标签页或稍等可恢复。

## [行为说明] cron CLI 的 --announce 不接受 main 会话 system-event 任务（2026-09-12）

- 症状：`openclaw cron add --system-event ... --announce` 报错 "--announce/--no-deliver require a non-main agentTurn, command, or script session target"。
- 根因：system-event 载荷固定进 main 会话，CLI 不允许给它配 fallback 投递。
- 解决方案：不配 --announce——main 会话的回复本来就按最近活跃频道（微信）投递，git 日报一直是这么跑的；事件文本里写"绝对不许 NO_REPLY"即可（同既有经验）。
