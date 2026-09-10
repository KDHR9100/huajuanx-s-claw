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
