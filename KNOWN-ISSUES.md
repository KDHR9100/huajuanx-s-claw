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

***

## 登记区

## [已解决·待观察] QQ 收到 600s 超时罐头话——心跳班越权"施工"救备份磨满超时；真凶是 push 通道 TLS 挂三天（2026-10-03）
- 症状：主人 QQ 17:42 收到 `Request timed out before a response was generated. Please try again, or increase agents.defaults.timeoutSeconds...`（超时罐头话，与 9-17 心跳马拉松条目同款话术）。同日三个 cron 任务被 consecutive-failures 自动禁用：memory-bridge / private-memory-bridge（13:04/13:17，根因见上一条已解决）+ **Daily Private Backup（17:32，连错 10 次）**；backup-check-run 连错 7 次未到阈值。
- 根因（三层叠）：①**push 通道挂了三天**——备份日志 10-01 起每天 `TLS connect error: unexpected eof`（Clash 半死老症状），本地快照与 commit 天天成功、全积压推不出去；②**.eva-parts 多 GB 拆分压缩包又进备份**（GitHub 100MB 硬限，10-02 手术漏网），10-03 晚并行手术者 reset + chore commit 再清一轮并更新 .gitignore；③**心跳班（glm-5.3-flash）巡查发现备份故障后越权进入施工模式**——29 个工具调用连做"读技能→查 cron 库→读备份脚本日志→探 Clash 7897→测 GitHub 连通→三次 push 补推→写 _catchup_push.cmd 后台重试循环→起后台 push 进程"，在第 29 个调用上正好撞满 600s 全局超时被掐，罐头话发 QQ。与 9-17 那次不同：**不是无意义马拉松，是干正事但违反"巡查/施工分工"纪律**（9-17 处方的 prompt 纪律被 glm 突破）。
- 解决方案：`openclaw cron enable f8b51148...` 重新启用备份任务（consecutiveErrors 清零）；两个记忆桥由并行会话当日已修（见上一条）；手术者清掉超限文件后 push 通道恢复（18:08 后 TLS 握手成功、远端本地同步 05699d4），三天积压清零。
- 遗留：①**心跳巡查/施工纪律对 glm 也只是软约束**——治本候选：prompt 再加硬纪律 / 心跳专用超时旋钮（9.7 无此配置）/ 认命（真故障时心跳班敢干活其实有价值，代价是偶尔一条罐头话）；②backup-check-run error 7x，今晚 23:00 自检班自然验证 push 恢复后是否自愈；③心跳班在 workspace 留了 `_tmp_cron_check.js`、`_catchup_push.cmd` 等临时脚本，可择机清。
- 状态：已解决（备份链路全通、任务全部复活），心跳纪律问题待拍板。

## [已解决] memory-bridge 连挂 10 次被自动禁用——rana-rp 的 model 字段改对象形态后脚本 .split 炸；顺修 main 腿坏事件崩溃（2026-10-03）
- 症状：cron 任务 memory-bridge（每小时跑 memory-bridge.mjs）自 10-03 04:04 起连续 10 次 error，调度器按 consecutive-failures 自动禁用并发告警。报错固定在脚本第 27 行 `TypeError: ((intermediate value) || "").split is not a function`。
- 根因：①当天凌晨 RP 换模型手术把 openclaw.json 里 rana-rp 的 `model` 从字符串改成了 `{primary, fallbacks}` 对象形态（AgentEntrySchema 支持），memory-bridge.mjs 仍按字符串 `.split('/')` 取子模型名 → 整脚本崩；②附带发现 main 腿两天来一直软失败（`Cannot read properties of null (reading 'type')`）——个别 transcript_events 的 event_json 解析结果为 null/非对象后直接取 `.type` 炸掉整条腿。
- 解决方案：memory-bridge.mjs 新增 `modelStr()` 规整函数（字符串原样、对象取 .primary、其余回空串），RP 侧 RP_DISTILL_MODEL 与 glmChatConfig() 的 qq 侧 model 读取统一走它；readNewEvents() 解析 event_json 后补 `j` 非空判断，坏事件跳过不炸腿。手动试跑 exit 0（main 34 msgs -> 0 entries），`openclaw automations enable 1960c470-7f87-4d95-a057-95252cda5cfd` 重新启用，consecutiveErrors 清零。
- 状态：已解决（脚本崩溃已修，14:04 下一班自然验证）。注意：RP 腿的 400 "No models loaded" 是 LM Studio 未加载模型的既有软故障，脚本设计为下轮重试、RP 恢复使用本地模型后自愈，不算本条病灶；同日 automations list 里 private-memory-bridge / Daily Private Backup / backup-check-run 等任务也在 error 状态，根因与本条无关，待另行排查。
## \[已解决·本机手术] RP 全线拒答两天——SSE 代理静默死亡、RP 无 fallback、会话钉死压配置三病叠加，真病根=中转站不认 content 块数组（2026-10-03）

- 症状：凌晨 02:04 微信 "hi" 无回复（87 秒后报 `connection refused by the provider endpoint`——本地 18801 代理进程已死，网关连不上它）；02:27 微信+网页、02:50 网页的三发真实聊天回合全报 `provider rejected the request schema or tool payload`（`400 empty-sse`，rawErrorHash `sha256:341298593183`，与 10-02 条目同指纹）。同期小探针请求（1k 级）全 200——「大请求必挂、小探针全过」比 10-02 记录的间歇抖动凶得多。网关侧另有事件循环延迟 180ms+ 持续半小时的亚健康（一个 Memory Dreaming cron 卡过 295s 后自释放）。
- 根因（三层）：① **代理无看护**——sse-fix-proxy 上次干活是前日 23:49，之后进程静默死亡（无死亡日志），start-gateway.cmd 只管启动不管保活（10-02 已登记「无看护，RP 未配 fallback 每次平台抖动弹脸」待拍板项，当晚即兑现成事故）；② **RP 无 fallback**——`fallbackConfigured: false`，平台抖动直接 surface_error 弹脸；③ **会话钉死压配置**——`agent:rana-rp:main` 会话 entry 上有 `modelOverrideSource:"user"` 的钉子（钉在 nalang-turbo-0826，网页端某次手动切模型留下的），它同时**禁用配置级 fallback**（dist `resolveModelFallbackAvailability`：用户钉死 ⇒ `disabled_by_model_override`），只改配置不清钉子等于白改。
- 手术记录（2026-10-03 03:40-03:46，备份：`openclaw.json.bak-rp1115-20261003` + `state/backups/rp-pin-fix-20261003/`）：① `openclaw.json` rana-rp 的 `model` 从字符串改成对象形态 `{primary: rp-nsfw/nalang-turbo-1115, fallbacks: [rp-nsfw/nalang-turbo-0826]}`（AgentEntrySchema 支持，1115 当夜探针实测 200）；② 停网关后直改 rana-rp agent 库 session_nodes 的 entry_json 清钉子——**第一版写成 `modelOverrideSource:"auto"`+保留 override 字段，网关启动即拒**（`invalid persisted session row requires repair for agent:rana-rp:main`，会话完整性闸门不认残缺 override 形态）；**正确形态照 dist openclaw 工具 applyModelIdentity 的做法：保留 `model`/`modelProvider` 指向新模型，把 providerOverride/modelOverride/modelOverrideSource/modelOverrideRouteResolution 及 fallback-origin 两字段整个删掉**——无钉子状态走配置 default（1115）且 fallback 生效；③ 重启网关（顺带清掉亚健康），启动零降级横幅、8 插件正常、QQ/微信双通道 READY，`openclaw models list --agent rana-rp` 确认 1115=default。
- 教训：**改会话 entry 只有一种合法「清除钉子」形态（删光 override 字段），半清不清会让网关拒启**；官方修法是 `openclaw doctor --fix`，直改库必须照 dist 的干净形态抄。**会话级用户钉死压过一切配置且禁 fallback**——排障时先查 entry_json 再动配置。
- **04:00-04:15 追记（手术做了，病没好——真实病根在更深处）**：03:52 主人微信实测，兜底机制正常工作（1115 挂了自动切 0826）但**两个都 400**——推翻「0826 单池生病」假设。转录取证：**10-02 09:39 reset 后唯一成功回合是第一轮（信封复读），此后 15:07 起真实回合 ~100% 连挂 18 小时**（7+ 发，横跨 0826/1115），此前"间歇抖动"的定性不成立。A/B 重放实验（node 直打代理，与网关同指纹；python 探针会被 Cloudflare 1010 签名封禁不能用）：采样参数块/40KB 大载荷/工具数组/workspace 六件套/空 assistant 历史**全部 200 无罪**。**实验把免费档当日额度打爆（429）一度中止**；主人确认额度有后恢复排查。
- **真病根（04:45 实锤，代理转储立功）**：给 sse-fix-proxy 加请求/响应转储（`%TEMP%\openclaw\sse-fix-proxy-last-exchange.json`，每次覆盖，抓密钥形状不抓密钥本体），CLI 打一发真实回合复现 400 后拿到**上游真实错误体**（此前两天一直被两层包装掩盖：网关显示 "Malformed diagnostic JSON redacted"、代理标 "empty-sse"——其实错误体一直存在，是 SSE 包着的 JSON）：**`generationConfig.prompts[2].content must be a string`**——中转站后端是 Gemini 系，不认 OpenAI 协议的 content **块数组**（`[{type:"text",...},...]`），要求纯字符串。而 openclaw 2026.9.7 会把「会话元信息（⟦openclaw:ctx⟧ Conversation info）+ 用户文本」以及**短时间连发的多条消息合并**编成多 text 块数组发出。时间线闭环：升级 9.7 是 10-01 晚；10-02 09:39 reset 后第一条消息是单块→字符串→成功（信封复读那轮）；从第二条起出现块数组→15:07 开始 100% 被拒。重放变体 V4（块数组拍平）→200，其余变体全 400，实锤。
- **修复（代理第二刀 blocks-flatten）**：sse-fix-proxy 加 `normalizeBody`——转发前把**纯文本**块数组拍平成字符串（含非文本块如图片的消息原样放过）；因请求体改写，转发改为缓冲后整发（自动重算 Content-Length）。备份 `tools/sse-fix-proxy.mjs.bak-nodump-20261003`（dump 补丁前原版）；dump 与 flatten 两个调试补丁都在，确认稳定后可按需回退。CLI 实测：`blocks-flattened (33114B -> 32848B)` → `200 FIXED 10.3s`，**Rana 正常角色扮演回复**，微信/网页待主人日常使用确认。
- 教训：**改会话 entry 只有一种合法「清除钉子」形态（删光 override 字段），半清不清会让网关拒启**；官方修法是 `openclaw doctor --fix`，直改库必须照 dist 的干净形态抄。**会话级用户钉死压过一切配置且禁 fallback**——排障时先查 entry_json 再动配置。**上游错误体有两层伪装（网关 redacted + 代理 empty-sse 误标），"400 空体"定性是错的——排障必须拿到原始错误文本，代理转储是最短的路**。python 探针打不得（Cloudflare 1010 签名封禁），要打就用 node。
- 遗留：①**18801 代理看护已落地（2026-10-03 省心版）**——health-patrol 加 ssefix 检查项：端口死了自动拉起再复查，拉起成功也记异常报备（"掉线过已自愈"），失败则报"需手工拉起"；备份 `health-patrol.mjs.bak-pressefix-20261003`；杀进程实测全流程通过；②openclaw 9.7 把多 text 块编成 content 数组——对标准 OpenAI 端点合法，但对 Gemini 系"OpenAI 兼容"端点不兼容，属**上游 issue 候选**（openclaw 侧可考虑对 openai-completions 扁平化纯文本块）；③RP 会话历史里积了失败残骸（空 assistant、五连 hi 合并块），能用但脏，主人可择机 /reset 换干净上下文；④当日免费额度有限（实测约几十发），排障实验注意节约。
- 状态：**已解决**（病根=上游不认 content 块数组，代理拍平修复；CLI 实测 Rana 已正常回复；模型 1115 主+0826 兜底保留）。

## \[已解决·本机修复] 9.7 后兜底心跳连班虚报"巡检脚本停摆"——心跳 cwd 变成通用 workspace，提示词相对路径全凭模型拼、时对时错（2026-10-03）

- 症状：10-02 当天 4 班心跳（11:51/14:51/17:51/23:51）向主人 QQ 虚报「巡检状态文件 memory/patrol-status.md 不存在，零成本巡检脚本疑似停摆」；实际 health-patrol.mjs 全程健在（状态文件每 30 分钟照常更新，23:30 仍有新班）。同日 21:00 班用 optional 读取沉默放过、22:00 晚报班又碰巧读对——**同一提示词时对时错**是最大线索。
- 根因：心跳提示词让读**相对路径** `memory/patrol-status.md`。升级 2026.9.7 后心跳隔离会话的 cwd 是 `state/workspace`（通用目录），不是 main 的 `workspace-main`；旧版系统能把相对路径按 agent workspace 正确解析，9.7 下模型拿到错误 cwd 后自己拼绝对路径，拼成 `workspace\memory\patrol-status.md` → File not found → 按纪律报"停摆"。诊断路径：agent 库 `agents/main/agent/openclaw-agent.sqlite` 的 `transcript_events` 表按 session 拉心跳班次原文（session 事件 cwd 字段 + read 调用实锤；注意 `heartbeat_outcomes` 表是空的，别在那白等）。
- 解决方案：心跳提示词里的路径写死绝对路径 `K:/OpenClaw/.openclaw/.openclaw/workspace-main/memory/patrol-status.md`（openclaw.json `agents.defaults.heartbeat.prompt`，备份 `openclaw.json.bak-hbpath-20261003`）。**教训：心跳/cron 类提示词里引用文件一律写绝对路径，绝不依赖相对路径解析——升级后 cwd 基准可能悄无声息地变**。
- 状态：已解决（2026-10-03 落地；下一班心跳自然验证，若仍读错再查配置热载、必要时重启网关）。

## \[已解决·平台限制] RP 偶发 "provider rejected the request schema or tool payload"——SillyTraven 免费中转间歇性 400 空错误体，与内容/本地改动无关（2026-10-02）

- 症状：RP 会话（rp-nsfw/nalang-turbo-0826）偶发整回合失败，报 `LLM request failed: provider rejected the request schema or tool payload.`；日志签名 `400: [Malformed diagnostic JSON redacted]` + failoverReason=format + rawErrorHash `sha256:341298593183`（注意：此 hash 与 10-01 问卜阿里云审查 400 同指纹，但那只说明"错误体不是合法 JSON"，两案上游完全不同，勿混淆）。sse-fix-proxy 侧对应 `-> 400 empty-sse`。实例：10-01 14:04/14:06、10-02 15:07（转录里留下的空 assistant 消息 seq 即失败残骸）。
- 排除过程（内容假说逐条证伪）：①同款 400 在本地任何改动之前就有（10-01 14:04）；②直打中转 A/B 对照——干净最小请求、历史带 openclaw.inbound_meta 信封回显的请求、普通历史请求三发全 200，信封内容与 SOUL 新句子都不是扳机；③平台不稳直拍：10-02 白天内同一端点先后出现 `getaddrinfo ENOTFOUND`（DNS 瞬断自愈）、代理 502 `upstream connect failed`、空错误体 400，几分钟后又全通——免费档（50次/天）后端过载/抖动形态。真实 RP 回合（16k 上下文大请求，响应曾慢到 27s）易撞上，小探针请求都能过。
- 解决方案：无需修本地；失败那发重发即可（13:39 失败后无重试但下一发正常）。可选加固（未拍板）：给 rana-rp 配 fallback 模型让 400 自动切换；或换免费档模型 id（nalang-turbo-1115 等）绕开单池抖动。
- 状态：已解决（定性为平台间歇故障，观察即可；若频发再考虑 fallback/换模型）。诊断注意：同 hash 400 ≠ 同根因，先看 provider 字段再归案。
- **10-03 补记（复发升级→最终破案）**：当晚 02:27/02:50 三发真实聊天回合连挂（同 hash `sha256:341298593183`、`400 empty-sse`），形态升级为「真实回合全挂、小探针全 200」——已按本条预留方案换模型：主 1115 + 0826 兜底（含会话钉子手术，见同日新条目）。换模型没有恢复服务，深挖后**真病根落案：中转站（Gemini 系后端）不认 OpenAI content 块数组**，openclaw 9.7 恰好在升级后开始把多 text 块编成数组——本条记的 10-02 15:07 一例确认属此案（会话转录 seq 实锤）；10-01 14:04 两发发生在升 9.7 之前（当时还是 9.2），未重验，不排除确属平台间歇。错误体一直存在，被网关 redacted + 代理 empty-sse 误标两层伪装盖住。修复=代理 blocks-flatten，详见 10-03 条目。

## \[已解决] RP 回复开头复读 openclaw.inbound_meta/outbound_meta JSON 信封——系统提示词 Message Context 被 RP 模型整段抄进正文（2026-10-02）

- 症状：网页 RP 聊天里 Rana 回复开头原样复读 ```json 信封（`openclaw.inbound_meta.v2`，channel/provider/surface=webchat），前端如实显示。同一会话库共四例：09-09 rana-rp-7b（webchat 版）、09-14 rana-rp-14b（微信 v3 版）、10-01 与 10-02 nalang-turbo-0826（云端，outbound/inbound 各一）。短输入（"hi"）+ 刚 /reset 的全新上下文最易触发；10-02 这次 reset 后第一句就犯，证明污染源是系统提示词本身、不是聊天历史。
- 根因：OpenClaw 每回合在系统提示词注入「### Message Context」可信元数据（防提示注入用，core dist `inbound-meta-*.mjs` 的 buildInboundMetaSystemPrompt）。RP 专精模型（本地微调 7b/14b、云端 nalang）指令服从松，偶尔把它当台词复读——不是网关/前端/中转代理的 bug（sse-fix-proxy 逐块透传不碰内容），模型输出里本来就带着。
- 解决方案（主人拍板「1+2 一起」）：**①显示层剥离**——`rana-web/src/lib/reasoning.ts` 的 `stripOpenclawEnvelope` 增补两条规则：完整 ```json 信封围栏（可带 `[时间]` 头）剥除；流式中围栏已开、出现 `"openclaw.in/out"` 前缀即整段按回显处理（信封是逐 token 吐的，等全名到齐会闪现一两秒原始 JSON）。整条只剩信封 → 走原有 sys-echo 折叠占位；`ChatStream.tsx` 的 sysEcho 占位加 `&& !streaming`（流式期间显示等待动画而非占位）。store 存原始数据不动，历史加载/落库去重零影响。esbuild 打包实测 9 用例全过（4 条真实污染样本 + 3 条既有规则回归 + 2 条不误杀），`tsc -b` 零错。**②提示词抑制**——`workspace-rana-rp/SOUL.md` 说话方式节加一句「Message Context 是背景不是台词，永远不要复读进回复」。vite dev HMR 即生效（刷新页面即可）；SOUL 下一轮对话生效。
- 状态：已解决（显示层兜底必中，复发也只是被剥掉看不见；提示词层降频率、服从性不打包票）。旁证：`private-memory-bridge.mjs:80` 与 `rp-tune/build_dataset.py:59` 早有同款规避——此怪癖是 RP 模型家族病，换 RP 模型后留意复发。

## \[已解决·本机补丁] 升级 2026.9.7 后 QQ 入站/心跳全死 "DataCloneError"——process.env 原生对象塞进 worker 任务过不了克隆边界；9.2 回滚被 agent 库 schema 24 堵死（2026-10-02）

- 症状：升级当晚 22:00 起心跳每班必死（`heartbeat failed: DataCloneError: #<Object> could not be cloned`，49ms 内暴毙）；**主人 QQ 私聊消息 00:59/01:19 两条全无回复**（`[default][handle] dispatch error: WorkerTaskError: DataCloneError`）。对照：钉 glm 的 cron（晚报/睡前小结/问候）全正常，CLI `openclaw agent` 直发同会话也正常——一度误导向"aliyun 模型运行时毒物"。
- 定位（阶梯排除法 + dist 探针实锤）：① 无模型钉 cron 复现器**通过**→排除模型/provider；② 换无补丁 2.0.4→仍死；③ 换 2.0.3→仍死→排除插件与本地补丁；④ CLI 挂 QQ 投递上下文→通过→排除投递上下文。**结论=核心 9.7 回归**。给 `worker-task-pool-*.mjs` 的 `start()` postMessage catch 打探针补丁（失败时递归 structuredClone 体检 input），一次心跳拿到病理：`input.request.env`（112 键，**每键单独可克隆、整体不可**）= Node `process.env` 原生拦截器对象——9.7 把它原样放进 worker 任务，`structuredClone`/`postMessage` 天生不收（CLI/cron-glm 的任务不带 env 所以幸免）。
- **修复（dist 本地补丁 env-clone-fix）**：`worker-task-pool-CqZMVo9-.mjs` start() 里 postMessage 前加一道——`structuredClone(input)` 失败且 `input.request.env` 存在时摊平 `{...input.request.env}`（求值成纯字符串普通对象）再发。**探针一并保留**（再失败会写 `state tmp/clone-probe.log` 病理）。备份 `worker-task-pool-CqZMVo9-.mjs.bak-probe-20261002`。验证：心跳 ok 77s 正常完成、探针零记录、新 cron 派发正常。**openclaw 升级后需重打**（重打脚本 `state tmp/apply-clone-probe-v2.cjs` 后再跑 env-fix 注入，或按本条目手工）。
- **9.2 回滚被堵死的过程（重要教训）**：9.7 首启把 **4 个 agent 库迁到 schema 24**（9.2 只认 19，启动即拒）+ state 库迁 contentVersion 19 + openclaw.json 写 `meta.lastTouchedVersion`。逐层恢复（state 库有 `pre-startup-migration-*.bak` 自动快照✓、config 有手工备份✓）仍卡在 agent 库——**昨 17:47 的私有备份 robocopy 镜像到的已是迁移后的 schema 24 库**（备份任务在升级窗口后跑的），9.2 时代 agent 库无备份（仅有 main 的晨间备份）→ 回滚=丢 RP/群聊历史，不可接受，被迫走前进路修复。**教训：①升级前必须先手动备份全部 agent 库（`agents/*/agent/openclaw-agent.sqlite`），自动快照只保 state 库；②robocopy 备份任务别排在升级窗口附近，镜像到的可能是中间态。**
- 连带状态：核心现为 2026.9.7（重装后 pmgate 补丁已重打）；qqbot 插件目录已复位 2.0.4+三块补丁（排障期间临时换过 2.0.3）；acpx 在 9.2 排障期曾被禁用、恢复 9.7 config 后已回到 enabled（9.2 跳过 acpx 是因 9.7 安装器把捆绑插件升到要 ≥9.5/9.7 API 的新版）。心跳 activeHours 临时拉长后又还原 01:00。
- 状态：已解决（补丁生效、心跳验证通过；**QQ 入站待主人实测**——同派发路径，预期已通）。
- **10-02 早追记（第二层余震）**：主人 07:25-07:27 的 QQ/网页消息报 `Async work scope is closed`（2 秒即败，前置 `failed to record session participant` 警告）——env 修复后主会话车道暴露的**运行时状态残留**（疑似 01:50 安装替换期的混乱关闭+多次换库所致；库完整性与会话节点均验证完好，非数据病）。~~标准重启即愈~~ **⚠️10-02 上午证伪：当时"系统事件测试 11s ok"的验收有盲区——系统事件走 `isSystemEvent` 分支跳过 participant 记录，恰好绕过病点，等于没测**。后续见下一条目。

## \[已解决·本机补丁] 9.7 通道入站消息全死 "Async work scope is closed"——GatewayScheduler wake 作用域提前 drain，消息 turn 挂在死作用域上三连撞（2026-10-02）

- 症状：主人全部 QQ 私聊入站 2 秒暴毙（网页同会话同步显示错误），前置 `failed to record session participant` 警告；**网页直发/CLI 直发/心跳/cron 全通**——病只在"通道入站→主会话"路径。当日 7 条入站全败、日志落盘结局 40 条全 error 零 ok。重启无效（每次启动复发），当晚"重启即愈"结论即由此证伪。
- 排除清单：插件版本（`plugins list` 实跑 qqbot 2.0.4/微信 2.4.9；update-checker 报 2.0.3 是读旧目录误报）、数据库（4 库完整性全过）、env-clone-fix 补丁（其 postMessage 失败分支从未跑过，`tmp/clone-probe.log` 根本不存在）、qqbot 2.0.4 三补丁（逐一对账在位）、启动降级（下述）。
- **"降级→死证"假说已推翻**：启动日志两次出现 `prepared model runtime startup degraded after 120000ms`（插件装载阻塞事件循环 124s > 120s 窗口），一度锁定为根因；主人拍板路线 B 禁用 10 个未用插件（anthropic/xai/ollama/talk-voice/geolocation/canvas/linux-node/cua-computer/file-transfer/device-pair，保 qqbot/weixin/memory-core/openai/lmstudio/acpx/browser/github），装载 253.7s→180s、降级消失——**10:12 消息照死同款**。降级只是伴随症状。插件瘦身收益保留（启动 6.5min→4.7min）。
- **真凶（探针实锤）**：给 `async-work-scope-ClifbwQr.mjs` 的 track/run closed 分支打探针（记录 closed 作用域的出生+命中堆栈 → `state tmp/scope-probe.log`），一条消息两条铁证——**死证出生=`GatewayScheduler.run`←`GatewayScheduler.wake`←Timeout 定时器**；命中① `recordSessionParticipantBestEffort`→`trackAsyncWork`、命中② `runContextEngineFactoryResolution`→`captureAsyncWorkTracker`。即 9.7 通道入站消息 turn 的异步上下文挂在某次 wake 作用域延续上，**该作用域提前 drain 而 turn 未完**，turn 前两个"加入当前作用域"检查点当场撞死。网页/CLI/心跳/cron 不经调度器驱动的通道队列所以全活。
- **修复（dist 本地补丁 scope-closed-fallback，主人拍板）**：`async-work-scope-ClifbwQr.mjs` 加 `__scopeUsable=(scope)=>!!scope&&scope.phase!=="closed"`，四处兜底——`trackAsyncWork`（closed→直跑）、`captureAsyncWorkTracker`（closed→脱离上下文跑）、`getAsyncWorkSignal`（closed→返回 undefined；**第二刀**：补丁一后 turn 走深，10:56 死在 `This operation was aborted | 20` = lane task 挂上死证已 abort 的 signal，191ms 即败）、`runWithTrackedCancellation`（closed 父→按无父直跑）。open/closing 语义未动；探针保留观察其余直接调用点。备份 `async-work-scope-ClifbwQr.mjs.bak-scope-probe-20261002`（干净原版）；语法验证 `node -e "import('file:///…mjs')"`。
- 验证：补丁二版 11:04 ready、QQ READY，主人实测 QQ 回复正常，日志零 error。✅已解决。
- **升级 9.7+ 需重打**：全套四补丁=env-clone-fix / scope-closed-fallback / pmgate / qqbot 三补丁（重打脚本在 `state tmp/`）。上游 issue 证据链已齐（出生+命中堆栈）未发。
- 连带观察（10-02）：①04:34/04:45 两单 cron 超时（rana-qq-public 240s、main 900s，均死在 model-call-started）台账首记，主人需核对有无漏收推送；②内存 RSS 1.51GiB WARN（新实例 11 分钟涨 622MiB）观察即可；③系统事件验收法有结构性盲区（isSystemEvent 跳过 participant 记录），验"入站消息车道"必须真实消息，`cron --system-event` 只能当烟测。

## \[已解决] 网关升级 2026.9.2→2026.9.7 + QQ 插件 2.0.4 + 三张补丁重打（2026-10-01）

- 做了什么：按主人工单（`workspace-main/tasks/zcode-workorder-20261001-openclaw-upgrade.md`，执行结果已回写该文件 RESULT 节）升级主程序、doctor --fix、QQ 插件升 2.0.4、重打全部 dist 补丁、重启验收。验收全绿：migrations 警告清零、superseded 零复发、openclaw 工具正常、RP 模型链路无 400、早晚问候强跑 ok、private-memory-gate 双项测试通过。
- **版本线事实**：npm 稳定渠道 latest = **2026.9.7**（beta 同版）；「2026.9.22」是 ClawHub 商店渠道编号，与 npm 不同线——工单预期「≥2026.9.22」实为渠道混淆，2026.9.7 即本渠道最新。
- **升级网络路**：Clash 半死（端口在听 TLS 全断，连百度不出——09-11 老病形态）时 `openclaw update` 必败于 npm ECONNRESET 且会留「update in progress」烂尾状态；正路 = **npmmirror 直连**（不走代理）：`npm i -g openclaw@<ver> --registry=https://registry.npmmirror.com --allow-scripts=@google/genai,esbuild,koffi,protobufjs,openclaw`（不带 allow-scripts 会静默跳过 postinstall 内置插件安装）；烂尾状态用「重跑一次 update（同样指镜像）让它判定 already-current」收敛。
- **2026.9.7 dist 重构**：read 工具从 `sessions-*.js` 搬到 **`tools-*.mjs`**（模块化拆分，7529 个文件，大量 .mjs），execute 签名参数名加下划线（`_toolCallId`/`_onUpdate`）。**private-memory-gate 重打脚本已通用化**：`state tmp/apply-pmgate-patch-v2.cjs`（自动按「function createReadToolDefinition + name:"read"」定位文件、正则锚定 execute 行，多候选优选 tools-\*；更新恢复环境 `package-update-activation-recovery.mjs` 里还有一份 read 拷贝未打——恢复环境仅升级期运行，接受）。备份 `tools-BIHgerau.mjs.bak-pmgate-20261001`。
- **QQ 插件 2.0.4 未原生修收图**（buildCtxPayload 仍 audio-only）——收图补丁继续必要。2.0.4 装进 **generation 目录**（`…qqbot-a7ec020d86__openclaw-generation__g-…`，旧目录闲置）；补丁重打脚本 `state tmp/apply-qqbot-patches-204.cjs`（四处锚点与 2.0.3 逐字一致，实测全中）；2.0.4 原版备份 + 2.0.3 已打补丁参考版 + 完整 diff 存 `state/backups/qqbot-dist-refs-20261001/`。09-20 条目挂的「CLI 发送修复待验」现在可验（2026.9.7 > 2026.9.5）。
- **新版本行为**：首启多约 90s canonical-validation 迁移（reclamation worker 阵发，正常）；插件 18 个（新增 github）；「SSE 修复代理」是外挂进程**不是 dist 补丁**，升级不影响（本次又验证：随网关自启、RP 链路经它无 400）。插件钩子 `before_tool_call` 在 2026.9.7 **仍不分发**（private-memory-gate 插件版/env-guard/snippet-store 均无 register 痕迹）——上游 bug 候选继续挂，闸门由 dist 补丁承担。微信插件已随后升 2.4.8→**2.4.9**（2026-10-01 主人拍板；无本地补丁依赖；`plugins update` 报"runtime application failed"属热应用失败、重启网关即装载——注意 qqbot 的 update-checker 仍会读旧目录报"current 2.0.3"，实际运行的是 generation 目录里的 2.0.4，以 plugins list 为准）。
- 状态：已解决（doctor 报的 7 条 cron 连败全是升级前旧账：qwen3.7 配额 403×2（模型已改写自愈中）、备份 git 推送撞死 Clash×2（代理复活即愈）、9-30 网络错误×3（当晚正班验证）——计数器随各自下次成功清零）。

## \[已解决] 问卜会话整天 "agent run failed"——deepseek 上下文撞阿里云内容审查闸门，扳机是整读进上下文的 shared-rana 记忆文件（2026-10-01）

- 症状：网页问卜会话（`agent:main:fate-teller`，会话钉 `aliyun-maas/deepseek-v4.1-flash`、fallback 随用户钉模型一起被禁用）10:40/10:48/12:39 三次 "The agent run failed before producing a reply"；日志签名恒定：`400: [Malformed diagnostic JSON redacted]` + failoverReason=format + rawErrorHash `sha256:341298593183`（与 09-14 qwen 隔离 turn 事件同指纹）。诡异点：11:12 连通性测试一发通过、12:36 同会话两次后台运行 4 发全 200，显得随机玄学。
- 根因：当天 10:38 记忆任务中她用 read 把 `workspace-main/memory/shared-rana-2026-09.md`（1.96 万字、双 agent 陪伴记忆、含私密向内容）**全文读进会话上下文**（转录 seq 171 工具结果），此后该会话每次请求都带着这段内容 → 阿里云 token-plan 的 data inspection（内容审查）大概率拦截，真实错误码 `data_inspection_failed`（"Input text data may contain inappropriate content"）。**审查是概率性的**（同载荷偶有放行——11:12 与 12:36 即漏网样本）。日志里的 "Malformed diagnostic JSON" 是二次假象：流式模式下 400 错误体是 SSE 包着的 JSON（`data: {...}`），openclaw 按 JSON 解析失败才显示红字。**本条修正 09-14 条目「端点日间不健康已自愈」的结论：同指纹事件实为上下文内容撞审查闸门，不是端点随机病。**
- 实证（重放实验：密钥从 state 库 `secret_store_entries` 读入内存直打 token-plan 端点，不落盘不打印）：① 用转录重建当日失败载荷直发 → 6/6 复现 `data_inspection_failed`（流式/非流式皆拦）；② 同载荷把 shared-rana 文件内容替换为占位符 → 200；③ 该文件前 8000 字单独发 → 200（扳机在文件内容，且与「文件+会话历史」的组合相关）。附带发现：空 assistant 消息以 `content:null` 回传会被该端点 400（"The content field is a required field."），发 `content:""` 则过——openclaw 实际序列化为后者。
- 解决方案（2026-10-01 主人拍板）：`openclaw sessions delete agent:main:fate-teller --agent main --yes` 删会话（转录已级联归档到 `agents/main/sessions/*.jsonl.deleted.*.zst`；问卦记录删除前已汇编进 `personal/querents/<求测人>.md`），下次页面触发自动开全新会话；即便不动，次日 daily reset 也会自愈。防复发：求测人档案 README 加规——问卜会话禁止 read 整读 shared-rana 共享记忆文件，要引用先 grep 定位只读命中行。
- 排障抓手（可复用）：转录在 `agents/main/agent/openclaw-agent.sqlite` 的 transcript_events（assistant 的 toolCall 块→`tool_calls`、toolResult→`role:"tool"`、空 assistant 发 `content:""`）；每轮编译载荷快照在 trajectory_runtime_events 的 context.compiled / model.completed（大字段截成 "[Truncated]"）；网关 WS 最小客户端见 state 目录 `tmp/send-new.mjs`（纯 token 连接握手能过但只有读权，chat.send 必 FORBIDDEN missing scope:operator.write——与 system-presence 缺 scope 条目同族；`openclaw tui --message` 在 stdin 非 TTY 时连上即退、不会真发；对运行中会话做手术直接 `sessions delete --yes` 最省事）。
- **同日第二接（硬闸门落地）**：主人要求「工具层拦截整读私密记忆」的硬闸门。探路记录：① 内部钩子（hooks/ 目录）不支持工具事件，只有插件钩子 `before_tool_call` 能拦；② `plugins.load.paths` 是已登记的死路——目录可见（`plugins list` 显示 enabled）但 register() 从不执行，`env-guard`/`snippet-store` 一直空转（本次实测坐实）；③ 官方 `openclaw plugins install <tarball> --accept-capabilities` 可装入 `state extensions/` 管理区并执行 register()，但 `before_tool_call` 分发始终不发生（debug 日志可见其他钩子在跑、工具循环处 hasHooks=false，时有时无）——**上游 bug 候选，插件源码保留在 `awesome-openclaw-plugins/private-memory-gate/`（api 契约+调试埋点齐全），升级后可重试**；④ **最终生效方案=本地补丁 read 工具**（QQ 收图补丁同款模式）：在 dist `sessions-BdNAJTEP.js` 的 `createReadToolDefinition` execute 入口插入私密路径检查（`/private-memory/`、`workspace-main/memory/shared-rana*`、`workspace-rana-rp/soul.private.md`，相对路径先按 cwd 解析），命中即抛错、报错原文直达模型。备份 `sessions-BdNAJTEP.js.bak-pmgate-20261001`，补丁脚本 `state tmp/apply-pmgate-patch.cjs`（可重复执行、版本变了会拒插）。**重打流程：升级 openclaw → 停网关 → 跑补丁脚本（锚点不匹配时按新版本重新定位 execute 入口）→ 起网关 → 用"读 private-memory/ledger.json 应被拦 + 读 MEMORY.md 应正常"双项验证**。⑤ 测试注意：`openclaw agent` CLI 的测试轮与网关共用日志文件，验证网关内行为要用 cron 触发；测试 cron/会话已清理。
- 状态：已解决（会话已删档重建；硬闸门补丁已生效并双项验证通过：私密文件被拦、普通文件正常）。

## \[已解决] 2026-10-01 早「重启后连锁故障」——degraded state 是总病根，doctor --fix 一并清掉（2026-10-01）

- 症状（同一时段五连）：① `openclaw` 工具（系统 agent 子回合）三连败 `prepared model runtime plugin generation was superseded for ...\agents\rana-rp\agent`，外层报 "could not reach working inference" 且 Cause 嵌套重复；② `automations` 工具 get 任务报 "cron job not found"（任务实际存在，CLI `cron edit` 却能改到）；③ 群画像两任务 `qwenanliang/qwen3.7-flash-2026-07-15` 403 Free quota exhausted，fallback `next=none`；④ `[system-agent/setup-inference]` 探测失败 `No API key found for provider "aliyun-maas"`（agent auth store 是空的）；⑤ 启动日志 `continuing with degraded state` + `Failed migrating legacy device identity`。
- 根因：⑤ 是总病根——启动迁移失败进 degraded state（09-11/09-14 两条目挂账的大小写 store 遗留 + 设备身份迁移冲突），模型运行时代际管理在 degraded 期反复被顶掉，一切依赖 runtime preparation 的路径随机死；`automations` 工具读的是过期快照（CLI 直连库无此病）。④ 是独立的设计行为：setup-inference 探测只认 agent auth store 的静态 profile，不解析 SecretRef/中央密钥库，而 main 的 aliyun-maas key 只存在密钥库里。③ 独立：qwenanliang 账户该型号免费额度耗尽（同账户 deepseek-v4-pro-0813 实测 200 可用）。
- 解决方案（2026-10-01，术前备份 state 库+main agent 库到 `state/backups/zcode-fix-20261001/`）：① 停网关跑 `openclaw doctor --fix --non-interactive` 再重启——重启后 ①②④⑤ 全部消失（degraded/migration/superseded/No API key/cron not found 零命中），doctor 顺带把 main 的 exec 配置迁到新写法（`{security,ask}`→`{mode:"full"}`，语义不变）；② main agent auth store 落静态 profile：`openclaw models auth paste-api-key --provider aliyun-maas --agent main`（key 从 state 库 `secret_store_entries` 取；该命令会在 openclaw.json 登记 `auth.profiles["aliyun-maas:manual"]` 节点，provider 的 SecretRef 本体不动）；③ 群画像两任务模型保持 `qwenanliang/deepseek-v4-pro-0813`（实测 200）；qwen3.7-flash 想复活去 dashscope 控制台充值或关「仅免费」。
- cron 核对结论（对应当天「cron: job updated」×5 的疑云）：问候任务 106785cf 的 payload.message 由 main agent 当天早班用 `openclaw cron edit` 正确更新（新增课程播报流程），schedule/sessionTarget/delivery/model 一字未动；当日另 3 个任务 updated_at 变化均非误改——854405fc=运行状态回写（收据 ok），b566bd64+ebecc6f3=调度层在 error backoff 时把模型从 qwen3.7-flash 改写为同供应商 deepseek-v4-pro-0813（相隔 17ms 的成批写、非 agent 手笔，改写者未最终定案、结果已实测可用）。无新建、无重复、无其他任务被动。
- 状态：已解决（2026-10-01 重启验收：degraded/migration/superseded/No API key/403/clawsec ENOENT/权限拒绝/策略警告八项负向检查全绿 + 完整性校验 5 库通过）。
- **同日第二接（重要更正）**：上午的"全绿"验收有误——检查窗口从 `loading configuration` 起截，漏看了它**之前**的迁移横幅；09:39 重启后 `degraded state` 实际仍在。且 `doctor --fix --force --non-interactive` 也拒绝处理（疑似要在交互终端问"谁赢"，非交互直接放弃）。最终手术（2026-10-01 11:0x）：矛盾真相是 `state/identity/device.json`（9-13 生成的孤儿身份 `5c3e703c…`，无任何配对引用）与 state 库 `device_identities` 的正式身份（9-8 建，`b3a987c8…`，CLI 配对在用）不一致，迁移拒绝裁断→每次启动降级。修法=把正式身份从库里写回 device.json（字段：version/deviceId/publicKeyPem/privateKeyPem/createdAtMs），两边一致后迁移即过；旧文件术前备份 `backups/zcode-fix-20261001/device.json.bak-legacy`。验证：`doctor --lint` 启动迁移零警告 + 第三次重启文件日志 `state-migrations`/`degraded` 零新增。**连带确认：当天 10:40/10:48 fate-teller 会话两个 400（"provider rejected the request schema or tool payload"，reason=format）也是降级期连带伤**——修好后同会话同模型测试 turn 一次成功；"空 assistant 消息毒化历史"假说已实测证伪（token-plan 对含空 assistant 消息的请求返回 200）。**教训：验收降级横幅必须从启动第一行看起（横幅在 `loading configuration` 之前打）；node:sqlite 的查询参数绑在 `.all()/.get()` 上，`prepare()` 第二参不是参数位。**

## \[已解决·环境变量] clawsec-advisory-guardian 每次扫描 ENOENT feed-signing-public.pem——钩子硬编码 ~/.openclaw，套件实际在 state 目录（2026-10-01）

- 症状：启动后周期性 `failed to load advisory feed: ENOENT ...C:\Users\Administrator\.openclaw\skills\clawsec-suite\advisories\feed-signing-public.pem`，安全公告功能降级。
- 根因：09-27 装 ClawSec 时套件被手动搬进 state 目录（`K:\OpenClaw\.openclaw\.openclaw\skills\clawsec-suite`），但钩子 handler 默认按 `os.homedir()/.openclaw/skills` 找（与 09-27 登记的 skills CLI 硬编码同族病）。PEM 本体一直在 state 套件里，从未丢失。
- 解决方案：不改钩子代码（升级会被覆盖）——钩子自带环境变量逃生口（HOOK.md 有文档）。新建 `rana-web/local-overrides.cmd`（gitignored；start-gateway.cmd 首段自动 call）：设 `CLAWSEC_INSTALL_ROOT` / `CLAWSEC_SUITE_DIR` / `CLAWSEC_SUITE_STATE_FILE` 三个变量指向 state 目录。重启网关生效，**PEM 的 ENOENT 消失**。
- **同日第二接**：路径修好后报错换了个文件——`ENOENT ...advisories\checksums.json`。真相：套件的 advisories 目录本来就没带校验清单（feed.json/feed.json.sig/PEM 齐全，checksums.json+签名缺失）；自己生成需要套件作者的 ed25519 私钥（本地只有公钥），不可行。修法=再设一档钩子文档里的逃生开关 `CLAWSEC_VERIFY_CHECKSUM_MANIFEST=0`（只跳过校验清单层，feed.json 本体的签名校验仍然生效——公钥钉死在 PEM）。两开关都在 local-overrides.cmd 里，重启后零 ENOENT。
- 状态：已解决（2026-10-01，两段式：路径环境变量 + 校验清单开关）。

## \[已解决] rana-qq-public 策略警告：minimal profile 的 tools.exec 不再隐式扩权，需显式 alsoAllow process（2026-10-01）

- 症状：日志重复刷 `tools policy: profile "minimal" (agent "rana-qq-public") has configured tool sections (tools.exec) that no longer implicitly widen the profile. Add alsoAllow: ["process"] ... See #47487.`
- 根因：openclaw 上游行为变更（#47487）——minimal profile 下 `tools.exec` 配置段不再隐式授予 process 工具。群聊算卦 skill 靠 exec 跑 .cmd 脚本，等于被静默降权，警告每会话刷屏。
- 解决方案：openclaw.json `agents.entries.rana-qq-public.tools.alsoAllow` 数组增加 `"process"`（热重载即生效）。重启后警告消失。
- 状态：已解决（2026-10-01）。

## \[未解决·良性] system-presence 偶发 "missing scope: operator.read"——无设备身份的纯 token webchat 连接被拒（2026-10-01）

- 症状：全天仅一次 `[ws] res ✗ system-presence ... FORBIDDEN missing scope: operator.read`（conn=b7b81d1b…，client=webchat-ui）。
- 根因：rana-web 每次连接都申请 `operator.read/write/admin`（`src/lib/gateway.ts` 两处），配对表里两台浏览器设备的 approved_scopes 也都含 operator.read——被拒的这条应为**没有设备身份**的纯 token 连接（新浏览器档案或清过站点数据的页面），网关对无设备连接不授 operator.read。调用方不在 rana-web 现行源码中（全文 grep 无 system-presence），疑为旧构建缓存页面发起。
- 缓解：无实害（单次状态探测被拒，页面自行兜底）；让该页面刷新或重新配对设备即消失。**不要**为此放宽网关默认 scope。
- 状态：未解决（良性观察；高频出现再查调用方）。

## \[待拍板] acpx `permissionMode=approve-all` 安全警告——三档取值没有"询问"档，收紧会打断无人值守派活（2026-10-01）

- 症状：每次启动 `security warning: dangerous config flags enabled: plugins.entries.acpx.config.permissionMode=approve-all. Run openclaw security audit`。
- 事实（读 acpx 插件 dist 实证）：合法值仅 `approve-all` / `approve-reads` / `deny-all` 三档，且本机 `nonInteractivePermissions: "fail"`——后两档会让 DSH 派活中的写入/执行类权限请求直接失败，无人值守派活基本不可用。09-15 落地派活页时选 approve-all 是当时的合理取舍。
- 选项：A 维持现状（接受警告，派活可用，推荐——除非 DSH 已不用）；B `approve-reads`（派活只能干只读活）；C 停用 acpx 插件（彻底不用 DSH 时）。
- 状态：**已拍板（2026-10-01 主人）：维持 approve-all**——DSH 派活仍在用，接受该警告为已知取舍；除非 DSH 弃用，不再重议。

## \[观察] P2 性能杂音：heartbeat 延迟 20s / memory-core lane 排队 12s / bootstrap 6-13s / timeoutMs=undefined（2026-10-01）

- 症状：全部集中在 08:39-08:40——断电补跑（群画像 catch-up）+ 记忆做梦 + 画像班 + 会话删除风暴同窗并发时出现一次；`[model-fetch] timeoutMs=undefined` 则每条请求日志都带。
- 判断：前三者是负载瞬时挤兑（lane 等待与心跳延迟在并发回落后自行消失），非持续病；`timeoutMs=undefined` 是日志字段显示"未显式配 fetch 超时"，当天所有 provider 请求均正常返回，不构成故障。不给 provider 盲配超时（RP 经中转站本来就慢，见 09-25 SSE 条目）。
- 状态：观察项。若空闲时段再现再查；不为此动配置。

## \[已解决] 每晚日报把没办成的事写成办成了——日报无核实步骤，照日记字面润色升级（2026-09-26）

- 症状：22:00 双人晚报「今天的工作」出现「按约把三笔账一起算清」，实际当天只向对方发过一条计划提纲消息、对方始终未回，事情根本没办——没做成被写成了做成了。
- 根因（两层叠加）：① 日记只记动作不记结果——亲历事件的主会话写了「我按约定去谈了」，没写「对方未回、未闭环」，唯一信源缺状态；② 晚报是隔离小会话，只读三个记忆文件、工具调用≤6次，提示词仅约束「不确定的不编」，没有「必须区分做没做成」的纪律，而列点格式天然诱导模型把动作润色成成绩；隔离会话禁 exec、聊天记录在 agent sqlite 里，日报任务也**没有能力**回查原始对话核实。
- 解决方案（2026-09-26 落地，A+B 组合 = 亲历者先确认、汇报再保真）：**A.** evening-report cron 提示词加「状态红线」：只有文件明确写「完成/办成了」才准写完成态；「发了没回／约了没进行／谈了一半没结论」必须照实写；从文件看不出结果的写「进行了/待进行」，禁止升级成完成。**B.** workspace-main/AGENTS.md 记忆三件套加「日记必须记结果」规矩：每记「我做了X」必须跟实际结果（办成/没回/没谈拢/约了未进行），未闭环的标注「未闭环」。
- 状态：已落地，待连看几晚日报确认不再出现完成态美化（首个观察样本：当晚 22:00 日报）。

## \[已解决·本机补丁] 微信 RP 无回复——sillytraven 中转站 SSE 流从不发结束标记，openclaw 把已生成完毕的回复整段判失败丢弃（2026-09-25）

- 症状：微信发消息给乐奈无回复（微信端最多收到一条 55 字符的 `⚠️ Agent run failed` 报错文本）；网页端能看到消息镜像进来，看起来像"网页好微信坏"。网关日志：weixin inbound 正常，embedded run 报 `Stream ended without finish_reason`（model rp-nsfw/nalang-turbo-0826），dispatch outcome=error。`channels status` 微信 running、in 实时——收信链路无恙，坏在模型调用层。
- 实测证据链：出事时刻精确对齐 09-25 04:43 把 RP 模型切到 rp-nsfw（该供应商 09-24 14:33 才加入）之后——中转站 api.sillytraven.dev 的 SSE 流**内容完整但从不发 finish_reason 块与 [DONE]**，openclaw 严格按协议收流，等不到结束标记即判整次 run 失败并丢弃全文。绕开 openclaw 直连该站实测八次（nalang-turbo-0826/1115、x-apex-dash-0826 三种型号 × 长短输出 × stream_options × Accept/UA 请求头）全部复现"内容完整+缺结束标记" → 服务端流式实现残缺，与我方无关（钥匙有效：假钥匙被拒 HTTP 400；本机无代理环境变量、hosts/DNS 干净、证书校验通过）。
- 为什么"之前直连脚本生成训练数据是好的"：rp-tune/st-continue.py、rp-eval/llm_client.py 收流方式宽容——读到对端关闭为止、拼 delta、[DONE] 有没有无所谓——结束标记缺失对它们无感；且脚本用的是 x-apex-dash-0826（实测同样无结束标记），分界在**客户端严格性**而非型号。内容本身从未丢过。
- 解决方案（2026-09-25 落地）：本机架"补暗号"代理 `tools/sse-fix-proxy.mjs`（127.0.0.1:18801，零依赖 Node）：SSE 响应缺结束标记时在流末尾补 `finish_reason:"stop"` 块 + `[DONE]`；非 SSE（JSON 报错等）原样透传；上游若修复自动退化为纯透传；钥匙不经手仍由 openclaw 持有。openclaw.json `models.providers.rp-nsfw.baseUrl` → `http://127.0.0.1:18801/v1`（备份 `.bak-ssefix-20260925`），热重载即生效无需重启网关；`start-gateway.cmd` 挂条件自启动（配置含 `127.0.0.1:18801` 才拉起；端口锁防多开，同 embedding-watchdog 规矩）。验证：代理三态测试（注入 / 400 透传 / JSON 透传）全过，微信实测回复成功。
- 排障抓手：代理日志 `%TEMP%\openclaw\sse-fix-proxy.log`（每请求一行，FIXED/passthrough/empty-sse 三态）；网关日志搜 `Stream ended without finish_reason`。**手动重启代理的生命周期坑（10-03 实锤）**：在 exec 会话里直接 `node sse-fix-proxy.mjs` 或 Start-Process 拉起的实例会随会话回收一起死（同晚端口两度掉线）；用 WMI 起才真正独立：`Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='node.exe K:\OpenClaw\tools\sse-fix-proxy.mjs'}`，起后 netstat 验 LISTENING + 打 `/v1/models` 验通。换上游站点或端口需同步代理的 SSEFIX_PORT/SSEFIX_UPSTREAM 环境变量与 start-gateway.cmd 里的 findstr 条件。回退 = 还原 .bak + 杀代理进程。
- 状态：已解决（2026-09-25 微信实测恢复）。上游协议缺陷未反馈站长（主人拍板不反馈）。

## \[上游限制] 网页（webchat）看不到她的实时思考——网关广播层不支持转发推理载荷（2026-09-22 修正）

- 症状：qwen3.8/deepseek 等思考型模型干活时，网页只有转圈动画，看不到思考流；`/reasoning stream` 命令"看似无效"。
- 实测证据链（2026-09-22）：① 命令与会话级设置**生效**（`/reasoning on/stream` 回执正常，state 库 session_nodes.entry_json 的 reasoningLevel 如实写入）；② 模型**真的在思考**（一轮"只回一个字"的测试 usage.reasoningTokens=141）；③ 但 webchat 的 chat 事件 delta **一个思考字节都没有**——dist 里 server-chat（webchat 广播模块）全文零 reasoning 处理，isReasoning 载荷在该路径被丢弃；④ 想让思考以 `<think>` 内联进文本流需要 provider 走"tagged"输出模式，而该模式由 provider 插件决定（`resolveReasoningOutputMode` 无插件时恒为 native），openclaw.json 自定义 provider 无从配置。
- 缓解：① rana-web 前端的「💭」折叠块只对**内联** `<think>`/`<details>` 的模型有效（本地 RP 系），云端原生推理模型无解；② 实用的替代是前端"安静计时器"（运行中超时无动静就提示可能在想/在等审批）＋审批页签角标联动（待做）；③ 根解等 openclaw 上游给 webchat 通道加推理车道（官方 issue 候选）。
- 关联：`agents.entries.main.reasoningDefault` 目前设为 "stream"——对 webchat 无效果但也无害；其他渠道（QQ）未见思考外发。此前 2026-09-21 把本条登记为"已解决"是**错误结论**，特此修正。
- 状态：上游限制（前端侧缓解方案待用户拍板）。

## \[已解决] 云端模型弹窗里"把旧行 id 改成新模型"会残留旧名字——顶栏挂错名（2026-09-21）

- 症状：在 ☁ 云端模型弹窗把过期模型的 id 直接改成新模型 id 后保存，右上角选择器里新模型顶着旧名字（如 id `qwen3.8-2.4t-a95b` 显示成「glm-5.2」），选名字实际用错人。
- 根因：弹窗表单不显示也不让改 name，改 id 后表单里残留旧行的 name 一起提交；保存逻辑（vite.config.ts upsertProvider）原样采信表单 name。
- 解决方案：① 根因——upsertProvider 改为"旧档案里没有的新 id 一律 name=id"，不再信任表单残留名（2026-09-21 已上线）；② 存量数据——qwenanliang 两行错位名手工归位（同日完成，热重载生效，顶栏已验证显示正确）。
- 状态：已解决（根因+存量都处理完；同日上线的弹窗改动还有：未保存改动关闭/切换拦截、保存后 3.6s 自动核对网关目录并琥珀色警示）。

## \[已解决·操作口径] 页面触发会话的 exec 审批送不到 QQ——去网页「审批」页手动批（2026-09-21；2026-09-22 已按主人决定整体关闭审批）

- 症状：排课等页面触发（study-planner 会话）的运行中，Rana 请求跑命令（exec/python），网关日志连刷 `approval-handler: no QQ target for <id> (session=agent:main:study-planner)`，会话 stalled 在 blocked_tool_call；命令既没批准也没拒绝，干等 15 分钟自动作废。
- 根因：审批推送目标按会话来源解析——页面触发的会话没有 QQ 目标，审批通知无处投递（会话与 QQ 无绑定）。审批**记录本身正常落在 state 库**（`state/openclaw.sqlite` 的 `operator_approvals` 表），只是推送不出去。
- 解决方案：**2026-09-22 起审批已整体关闭**（主人拍板：自动化优先）——openclaw.json 的 `agents.entries.main.tools.exec = { security: "full", ask: "off" }`，执行不再询问、全放行；配套在工作区 AGENTS.md 加了「过程直播纪律」（她每个动作前先在会话说一句），弥补网页看不到思考流的上游缺口。实测：dir 命令直跑零审批、边干边说生效。历史口径（审批页手动批、首屏等 6 秒）保留备查——若日后想恢复审批，删掉 tools.exec 那段即回原状。
- 关联：17:15 网关曾自行重启一次（前有 QQ WS 4009 超时），在飞的排课运行竟存活续跑，原因未查；再发生时先看 `%TEMP%\openclaw\openclaw-当日.log`。
- 状态：已解决（审批关闭 + 过程直播替代可见性）。

## \[已解决] 排课/换课件后 Agent 连续「couldn't generate a response」——默认输出额度 8192 被思考 token 烧光（2026-09-21）

- 症状：换新课件后「让Rana排课」，Rana 读完全部资料后停在思考；页面反复弹「⚠️ Exec failed」「Agent couldn't generate a response」。qwen3.8-flash、deepseek-v4.1-flash 换着用全部同样失败（用户已正确判断非模型问题）。日志特征：`incomplete turn detected ... stopReason=length ... surfacing error to user`，每轮约 100s。
- 根因：openclaw 对未配置 `maxTokens` 的模型**默认输出上限 8192**（dist 代码 `maxTokens: model.maxTokens ?? 8192`）。思考型模型（qwen3.8/deepseek-v4.1）做大重排任务时，8192 输出额度被 reasoning 全部耗尽——转录 usage 实锤：`output: 8192, reasoningTokens: 8192`，正文 0 字，`stopReason: length` → 回合不完整 → 网关报错。输入侧健康（11 万/100 万）。另：她口中的「命令审批走不通」是 exec 安全闸 `SYSTEM_RUN_DENIED: approval cannot safely bind this command`（powershell 管道），属设计内保护，read 工具可正常替代，不是故障。
- 解决方案：给 openclaw.json 里 **19 个云端模型条目补 `maxTokens`**（备份 `openclaw.json.bak-maxtokens-20260921`）：qwen3.8-*/glm-5.3/glm-5.2 = 131072（qwen3.8-max 实测 dashscope 接受 131072 返回 200；GLM 官方文档 128K）；qwen3.7/3.6/deepseek 系 = 65536；kimi-k2.7-code = 32768。lmstudio-local 4 个本地模型**不动**（contextWindow 是真实显存限制）。改后热重载逐 provider applied，无需重启。云端模型 contextWindow 原本已是 1000000（输入已是上限）。
- 状态：已解决（2026-09-21 配置生效；排课重试验证输出侧不再截断）。

## \[已解决] 排课被弹「prepared model runtime plugin generation was superseded」——页面切模型触发配置热重载，顶掉了在途请求（2026-09-21）

- 症状：规划→课表→「让Rana排课」，约 1.5 秒即失败，页面显示「她那边出错了：Error: prepared model runtime plugin generation was superseded for K:\\OpenClaw\\.openclaw\\.openclaw\\agents\\main\\agent」。同一秒日志依次出现：config change detected (agents.entries.main.model) → config hot reload applied → persisted sticky model selection agentId=main model=glm/glm-5.3。
- 根因：`study-agent.mjs` 每轮对排课专用会话 `sessions.patch` 粘性指定模型；当页面选的模型与 openclaw.json 里 `agents.entries.main.model` 不一致时，网关会把这个选择**持久化进配置文件** → 触发热重载 → 主 agent 的 prepared model runtime 整体换代 → 刚进来的排课请求还拿着旧一代 runtime，被判 superseded 直接弹回。自己触发的重载顶掉了自己，纯时序竞态；只在「模型与配置不一致的第一次」发生，配置落定后不再复现。
- 解决方案：无需改码——同值重复 patch 不改文件、不触发重载（2026-09-21 实测：patch 前后 openclaw.json 哈希一致、日志无新 reload），**再点一次排课即过**。若换新模型再遇：先在网关配置里把 `agents.entries.main.model` 预先改成目标模型（或重启网关），再发起排课。
- 状态：已解决（2026-09-21 定位根因，实测同值 patch 不触发重载；页面重试即可恢复）。

## \[已解决·绕行] 网关「回复投递」通道把内部代号拼进 QQ 地址——systemEvent 回复/心跳汇报发不出（2026-09-20）

- 症状：学习睡前小结（22:30/22:41 两班）收据 error，QQ 报「请求的资源不存在(用户/群已注销)」；网关 heartbeat failed 同款（23:31/23:43 两班）。同时段早晚问候、git 三推送的 message 工具直发全部 200 送达——一通一断，病灶在投递路径不在 QQ 通道。
- 根因：网关投递层把会话内部用户键 `user:c2c:<openid>` 整个当 QQ REST 路径参数（正确应传纯 openid），QQ 服务器查无此"用户"报已注销。**与 openid 大小写无关**——message 工具用同一个大写 openid 直发成功、拿到 messageId 为证。20:53 网关重启后首现，23:42 再重启不愈 = 持续性 bug（上游 issue 候选）。仅"回复投递"路径中招；message 工具直发路径健康。
- 解决方案（全部绕行，不动上游）：① 睡前小结新建直发版 `edfbc9fe`「学习睡前小结·直发」（隔离+glm+message 显式 channel="qqbot"+全量目标，照早晚问候配方），旧任务 `94f0079f` 停用保留回滚，实测 58s 送达；② 心跳 prompt 改直发（备份 `openclaw.json.bak-hbdirect-20260920`）：有事时 message 工具直发，同时把原 `<对方openid>` 占位符换成真实目标（那占位符本来也发不出去）；实测 23:43 班 read 巡检 → message 直发成功 → 收尾；③ 心跳收尾词统一 NO_REPLY（不外发暗号）——避免最终回复再走坏投递通道制造 error 收据噪音。
- ⚠️ 热重载坑（新证）：cron CLI 改动会产生"更新的 runtime 配置"，此后直接写 openclaw.json 触发的 reload 会被 `GatewayConfigReloadSupersededError` 静默取消（本轮日志只剩 superseded 一行、无 applied）——**CLI 动过配置后再改文件，必须重启网关才生效**。本次 23:42 重启后写文件立即正常热重载。
- 遗留（待拍板）：health-patrol.mjs 的 eventloop 持续时间显示 bug（patrol-status.md 出现「已持续 29831970 分钟」≈56 年，疑似时间基准算错）；23:43 心跳已按该假异常给主人发过一条汇报，00:00 巡检班后异常条目消失即自愈，但显示 bug 待修。
- 状态：已解决（绕行；上游 bug 登记候选）。

## \[已解决] 主人画像·周报连续超时——360 秒上限差 34 秒（2026-09-20）

- 症状：连续 5 次 `cron: job execution timed out (last phase: model-call-started)`；排查窗口内 glm 每轮调用 4~15s 全 200，模型端健康。
- 根因：周报工作量实测需 394s，任务 `timeoutSeconds=360` 差一点，到点被掐。
- 解决方案：`openclaw cron edit 15aadbf0… --timeout-seconds 600`，手动验证 394s 完成 ok。
- 状态：已解决。

## \[已拍板·暂缓] OpenClaw 9.5 升级调查——QQ 插件无新版，CLI 发消息 bug 升级修不了（2026-09-20）

- 调查结论：①`openclaw message send` 真实路径全坏（`outLog.debug is not a function`，任何长度、dry-run 假阳性）系 **QQ 插件 v2.0.0+ 自身 bug**（GitHub 8 月已有同款 issue），npm 最新插件仍为 2.0.3=本机现装版本，主程序升 9.5 修不了；②QQ 收图 bug 官方同样未修（插件无新版），升级触发插件重装即覆盖本地收图补丁（9-14 条目）；③升级收益（原子升级/插件热重载等）无硬需求，9.4 起 memory promotion 规则变严（minUniqueQueries）属未知影响项。
- 拍板（2026-09-20 主人）：**暂不升级**。触发条件：QQ 插件发布 2.0.4+（官方修复 CLI 发送/收图）时，连主程序一起升级。
- 届时 runbook：备份 openclaw.json 与 state → 升级 → 重打 QQ 收图补丁（按 9-14 条目）→ 全链验证（心跳 glm 班 / git 直跑+glm 中继 / 早晚问候 / QQ 收图 / 微信通道）。git-activity-cron.mjs 的 `--notify` 零模型推送代码已备好，CLI 修好后可评估把 glm 中继换回直推。
- 状态：暂缓（等插件 2.0.4+）。**2026-10-01 补：插件 update-checker 已报 2.0.4 发布——拍板触发条件达成**，升级（连主程序+重打收图补丁+全链验证）待主人点头后按本条 runbook 执行。**2026-10-01 晚已执行完毕**：主程序 2026.9.7 + 插件 2.0.4 + 三张补丁重打，全链验收绿（见当日升级条目）；CLI 发送修复待日常验证。**同日验货（拉 2.0.4 包逐文件 diff，官方 CHANGELOG 未写 2.0.4 条目）**：①**CLI 发送 bug 已修**（`createOutLog` 在网关缺席时从"返回空对象"改为兜底创建真 PluginLogger）——runbook 里"git 直推替代 glm 中继"可评估了；②**收图 bug 未修**（`ctx-builder.ts` 媒体过滤仍只认 `audio/`），升级后必须按 9-14 条目重打 dist 补丁；③出站投递车道化重构（新增 dispatch-deliver/reply-options/bot-streaming 指令，static-blocks 与 native-stream 互斥去重防双发）——行为有变，全链回归不能省；④`user:c2c:` 拼 URL 是主程序侧 bug，与插件版本无关，直发绕行继续。**注意：升级命令须带 npm 代理 env（Clash 没开时 ECONNREFUSED，9-13 条目）。**

## \[已解决·对症] exec 审批在隔离会话送不到人 → 900 秒挂起死循环——心跳瘫痪半日、网关曾被拖死（2026-09-20）

- 症状：心跳会话反复 `stalled session ... reason=blocked_tool_call activeTool=exec`，每轮约 920s 被 abort_embedded_run 强杀，cron 判 transient error 立即重试 → **约 15.5 分钟一轮死循环**（09-20 11:19–14:41 连续六轮；09-19 21:30/21:45 首发两轮，后者撞上网关进程无声退出）。日志铁证：`approval-handler: no QQ target for <id> (session=agent:main:main:heartbeat)` + `exec.approval.waitDecision 905~929s`，审批终态 `resolvedBy=approval-scope-closed`（run 被杀后自动 deny）。同病 09-19 下午还打过 dashboard 会话两发（14:04/14:43）。
- 根因：09-19 exec 审批闸门上线后，心跳里的**老习惯「顺手跑 git-activity.mjs 出统计」**（闸门前能跑通、无害）变成必挂：隔离小会话没有 QQ 投递目标，审批卡送不出去、无人能批，waitDecision 干等到 run 级超时。机制缺口（上游 bug 候选）：**审批无受众时应快速 fallback deny**（对照：`wsl …`/PowerShell 管道这类"cannot safely bind"命令就是秒拒的），而不是挂 900 秒。第二层缺口：agent exec 审批只支持 allow-once/deny，allowlist 只认程序路径——解释器（node.exe）不能路径级放行，于是「固定命令的长期许可」在 agent exec 场景**没有落点**，只能提示词层禁。
- 解决方案（09-20 落地）：①应急手法：`openclaw approvals pending` 抓现行 → 合法固定命令 `resolve <id> allow-once` 先解救当班（本次放行的即 git 周报脚本）；②根治：`agents.defaults.heartbeat.prompt` 追加禁 exec 纪律（写明"审批卡送不到主人、干等15分钟整班报废；git 统计/备份各有专门任务，失败只报告不代跑"），并补一句巡检文件**必须用 read 工具直读**（她用 memory_get 读 patrol-status.md 会 not_found → 误判"巡检停摆"误报）。prompt 热生效无需重启，备份 `openclaw.json.bak-hbnoexec-20260920`。验证：手动心跳班 49s ok、零挂起审批。
- 排障抓手：`approvals pending`（挂着的就是卡点，Expires In 列看余命）→ agent 库 transcript_events 看她想跑什么 → `cron runs <jobId>` 区分本症（600/920s 超时+审批记录）与模型收尾病（超时但审批零记录）。`approvals grants list` 空属正常——standing grant 只来自 automation 载荷的 allow-always，agent exec 不产生。
- 状态：已解决（对症：提示词纪律+应急手法；机制缺口登记为上游 issue 候选）。
- **09-20 16:20 补记（提示词路线判死 + 执行后备）**：提示词禁令对 qwen3.8-flash **无效**——14:56/15:00 两次写入禁 exec 纪律并热生效后，15:48 班第一个动作仍去跑 `git-activity --period=today`、16:00 班又换成 `node -e` 内联脚本读课程表（每班换个花样，审批记录三连），均被 CLI 逐单 deny 解救。查证 2026.9.2 的 heartbeat 配置模式（dist/index.d.ts）只有 agentId/every/activeHours/model/session/target/directPolicy/channel/prompt/timeoutSeconds/lightContext/isolatedSession——**无 per-job tools 禁用口子**；allowlist 只认程序路径（解释器禁放）。最终执行 9-15 预留后备：`heartbeat.model` 回钉 `glm/glm-5.3-flash`（main 聊天仍 qwen 不动，备份 `openclaw.json.bak-hbglm-20260920`）+ 重启网关。验收班 glm 26s：read 巡检文件（用对了 read 而非 memory_get）→ NO_REPLY → 零 exec 零审批。**教训：凡"必须不做某事"的硬约束，提示词对弱模型不构成保障，要么工具层禁（本版无口子）要么换强纪律模型。**

## \[已解决] 私有备份推送静默失败数日——主状态库超 GitHub 100MB 硬限制（2026-09-20）

- 症状：`backup-private.cmd` 的 push 重试 3 次后失败但容易无人察觉；远程私有仓滞后。夜间排查时表现为「整包上传完成后指针更新丢失」「HTTP 408」等多种假象，一度误判为纯网络问题。
- 根因：`.openclaw/.openclaw/state/openclaw.sqlite` 增长到 102MB、`backups/cron-surgery-*/openclaw.sqlite` 108MB——超过 GitHub 单文件 100MB 硬限制，服务端直接拒收（GH001；50MB 以上即有警告）。
- 解决方案：filter-repo `--strip-blobs-bigger-than 100M` 剥离超限 blob；备份仓自有 `.gitignore`（robocopy `/XF .gitignore` 不会覆盖它）排除主库与手术备份目录，未来备份不再撞墙；分块推送全部落地。
- 取舍与后效：主状态库不再经 git 远程备份（本地 robocopy 副本仍完整）；**改进方向（待做）**：备份链改为「sqlite 压缩转储后再入库」（压缩后通常只有原体积的 10-20%，可稳居限内）或改用 git-lfs。
- **09-20 晚补记（robocopy「失败 1 目录」根因）**：当日 17:30 与手动班连续 robocopy exit 11——`workspace-main\.claude\skills\teach` 是 09-19 12:15 生成的**悬空 junction**（指向已搬走的 `.agents\skills\teach`），robocopy 进入即失败且不打印明细（/NFL /NDL 下统计 FAILED=1 却无 ERROR 行；「目标同名文件占位」假设可用剪枝遍历 Test-Path 排除，真因是链接不可读）。解法：`cmd /c rmdir` 删链接（真身 `skills\teach` 无恙）；robocopy /L 复核 FAILED=0，实跑 backup done + 推送成功（`2d3a24f..e8869bd`）。**注意：全树 7 个 junction 里 6 个是 plugin-skills 活链接，禁止给备份加 /XJ 一刀切**。另两坑：Git Bash 调 `cmd /c` 必须写 `cmd //c` 且整段引号，否则参数被拆静默不执行；当晚首验 push 曾撞 Clash 抖动 3 连败（老病，见 9-11 条目），重试一轮即恢复。

## \[状态：待拍板→已审计] Mimosa L3 提交闸门时拦时放——完整扫描强拦（多为已设防代码的误报），扫描器缓冲溢出时静默放行（2026-09-19；09-20 深度审计复核）

- 症状：`git commit` 被「高危已强制拦截」拦截，指向 vite.config.ts study 中间件的 `materialAbs`/`writeSchedule`/`spawnAgent` 等 57 项 high（路径拼接/命令参数向量类）；同晚另三次 commit 因 `scanner_enobufs` 按兼容策略放行；`git push` 同样被扫。
- 根因：静态污点分析不认正则守卫与 containment 校验——被 flag 的函数实际都已设防（`materialAbs` 有 fail-closed 文件名校验 + `path.relative` 二次防线；`spawnAgent` 对 model/sessionKey 有白名单字符集），属误报；扫描器自身缓冲溢出时闸门降级放行，行为不稳定。
- **2026-09-20 深度审计复核（正式密封扫描）**：scanId `scan-2026-09-20T03-42-29.888Z-87591dd8a791`，seal `sha256:edf5ccf1…`，826 依赖包零告警；全仓 263 项发现中约 201 项在 gitignored 的 dsh-reference 第三方参考代码（不发布），首方 62 项（57H+5M）全部为同一族 path-traversal 误报——抽查 writeEvents/writeCollection 写死常量路径、writeJsonBak 调用方全传常量，**未发现真实漏洞**（覆盖度 partial/inconclusive，不据此宣称项目安全）。
- 候选方案：A 接受现状；B 在 Mimosa 侧做窄抑制（仅按本次密封扫描的 finding 标识收敛 vite.config.ts 该族误报，留档 scanId，防止过宽抑制掩蔽未来真问题）。注意 `push-public.cmd` 一键推送会撞同一闸门。
- 状态：已审计，处置待主人拍板（A/B）。

## \[已解决] 发行版打包三坑：cmd 中文注释炸解析 / OpenClaw 首启要两次 / workspace 必须显式（2026-09-19）

开箱即用发行版（setup.cmd + 发行模板）异地模拟验收时踩的三个坑，全部已修：

- **cmd.exe 按 GBK 解析批处理，UTF-8 中文注释会把 REM 行拆成命令**：症状是 start-gateway.cmd 报「'制造多开。日志见…' 不是内部或外部命令」+ 变量为空（`'""' 不是命令`）。原因：Write 类工具默认写 UTF-8，而老脚本当年是 GBK/纯 ASCII 所以没事。**规矩：启动链 .cmd 一律纯 ASCII 注释**（setup.cmd 例外——它第一行 `chcp 65001` 先切换了代码页，验证可行；local-overrides.example.cmd 同款处理）。
- **OpenClaw 网关首次启动会自动装内置插件（anthropic/browser/canvas…+qwen），装完「拒绝宣告就绪」要求再启一次**：`plugin migration inputs changed during startup convergence; refusing to report the gateway ready`。这不是故障——第二次启动即收敛。README 快速上手已提示「首启连不上就再双击一次」。另注：装插件走 openclaw 内部 npm，需要代理的网络要带 `HTTPS_PROXY`（老坑），发行文档提示用户。
- **`workspace-main` 目录不会被自动认领，必须在 agent 条目显式写 `workspace` 字段**：症状是 SOUL.md 不被注入、模型自称「没有名字的白纸」。本机 main 能工作是历史注册的运气；发行模板因此加 `__SETUP_WORKSPACE_MAIN__` 占位，setup.mjs 生成时替换为实际绝对路径（正斜杠）。显式指定后验证：模型自我介绍与 SOUL.template.md 人设一致。
- **台账自身也中过招（09-19 发布前扫描发现并已脱敏）**：09-17 写回的 cron 命名坑条目把主人真名写进了本文档、09-13 的 QQ 条目引用日志原文带了 appId。教训：**回写台账时引用配置/日志原文必须先脱敏**——红线条款早有，执行要跟上；发布/推送前跑一遍个人信息图样扫描应成为固定动作。

## [行为变更·须知] exec 审批闸门开启（auto 档）——她的命令执行从全放行改为白名单+自动审查（2026-09-19）

- 做了什么：`tools.exec.mode: "auto"`（备份 openclaw.json.bak-execgate）+ 白名单放行 `**/git.exe`。生效策略 `security=allowlist, ask=on-miss, askFallback=deny`（`openclaw exec-policy show` 可查）。目的：Rana 觅食装新工具（plugins install / mcp add / npm install）必须过人工批准，防诱导乱装。
- 行为变化：白名单命中的命令直接跑；没见过的命令先过网关内置自动审查器，可疑的弹审批（QQ 渠道已注册审批界面；CLI 用 `openclaw approvals pending` / `resolve <id> allow-once|allow-always|deny`）。**allow-always 的许可绑定"精确参数+当时工作目录"**，换个目录跑同一命令要重新批。
- 设计要点：**python.exe / node.exe / powershell.exe 这类解释器不能加路径级白名单**——放行整个程序等于连 `pip install`/`npm install`/任意脚本一起放行，闸门失效。它们靠自动审查器判断；固定常跑的（cron 里的 node 桥、备份）是 automation 载荷，走 standing grant（首次触发弹一次，allow-always 后对该任务长期有效）。
- 预期摩擦：开启后头一两天，她的新命令/cron 任务首次运行可能弹审批，批 allow-always 即沉淀为长期许可；属一次性成本。
- 配套：workspace-main/skills/skill-scout（觅食技能：搜索→评估→固定格式提案→明确批准才装；拒绝记录进 memory/ops-notes.md 台账）。原生自我学习（skills.workshop.autonomous.mode）维持默认 auto。
- **09-20 补记（实测修正三处）**：①agent 的 exec 审批**不支持 allow-always**（实测 `resolve <id> allow-always` 报 "Decision allow-always is not allowed for exec approvals; allowed decisions: allow-once, deny"）——上文「批 allow-always 即沉淀为长期许可」对 agent exec 不成立；长期许可只有两条路：allowlist（程序路径级 glob，解释器禁用）与 automation 载荷（cron command-argv）的 standing grant（`openclaw approvals grants list` 可查）。②「预期摩擦」在**无审批受众的隔离会话**（心跳/dashboard）的实际形态 = 900 秒挂起死循环而非弹卡等批（见同日新条目）——凡跑在隔离会话的 agent turn，必须 prompt 层预禁 exec。③闸门对"无法安全绑定"的命令（PowerShell 管道、wsl 包装等）是秒拒（SYSTEM_RUN_DENIED），不会挂起；会挂起的是 node.exe 这类"可绑定但无人批"的。

## \[已解决] cron 主动消息的三条投递弯路——isolated+announce/systemEvent 都送不到，正路是「自己发」（2026-09-17）

- 症状：早晚问候任务三连败——①隔离会话+announce→last：`Channel is required when multiple channels are configured`（隔离会话无历史，"last"解析不出）；②显式 `--channel qqbot --account default`：`Delivering to QQ Bot requires target`（还缺 qqbot:c2c:openid 目标，cron CLI 无 target 参数）；③systemEvent 进主会话：模型轮成功、回复也生成了（会话 transcript 实证），但**回复并不自动出站**（receipt deliveryStatus=not-requested，全天 QQ 出站 API 零调用）——旧台账「main 会话回复按最近活跃频道投递」的说法在 2026.9.2 版不成立。
- 根因：投递目标由 `deliveryContextFromSession`（会话历史）推导，隔离会话天然没有；主会话虽有 `pendingDeliveryNotice`（qqbot c2c→主人）但 systemEvent 回复不消费它。
- 解决方案（当晚 21:47 实测送达，QQ API 200 OK）：**让 agent 自己用 message 工具发**——心跳跑了几天验证过的路。配方：isolated + glm + 提示词里写死完整目标 `qqbot:c2c:<主人openid>`（openid 从 bindings 提取，任务存 state 库不进公开 git）+「发完最终回复只回『已问候』三字」防双发。任务 id 106785cf。
- 附带修正：巡检的 eventloop 检查改「只报持续性」（网关自报降级>2 分钟或连续两班才报）——问候班 10:00/21:00 与巡检 :00 整点必然撞车，模型调用的瞬时闪断是常态，当晚首班就误报了一次。
- **附带的坑（同晚第二例）：隔离会话+lightContext 没有 USER.md 身份档案，glm-5.3-flash 会瞎编主人名字**——两班问候把主人的名字写成了同音错字（内容全对、只名字错）。修法：cron 提示词里写死主人的正确名字与日常称呼并禁止同音字（真名只写在运行态 openclaw.json 的提示词里，不入台账不入库）；兜底心跳提示词同款加固。**凡是隔离会话里要称呼主人的 cron，名字必须写进提示词**，不能指望她从记忆文件里猜。
- 附带修正②：巡检 tcpOk 只查 IPv4 `127.0.0.1`——重启后 vite 只绑 IPv6 `[::1]:5173` 时会误报「前端没监听」（网页明明开着还 QQ 委屈用户）。已改双栈任一可连即算活（2026-09-18）。
- 排障抓手：QQ 有没有真发出去，看 `%TEMP%\openclaw\openclaw-当日.log` 的 `[qqbot:api]` 行（**日志按大小轮转，当天 4.9M 后重开**，老内容不保留）；会话里她回了什么，查 `agents/main/agent/openclaw-agent.sqlite` 的 transcript_events（session_key→current_session_id 要跟对，主会话每天 /reset 会换 id）。
- **09-20 补记（第四条弯路）**：多通道环境（qqbot+微信并存）下 message 工具**必须显式带 channel 参数**（`"channel":"qqbot"`），只写全 target 不够——10:00 早问候班首发送被拒（`Channel is required when multiple channels are configured`），模型当轮自行补参重发才送达；已在问候任务提示词里写死该参数（顺带加了隔离会话禁 exec 条款）。
- 状态：已解决（端到端验证通过）。

## \[未解决·有解法] Mimosa git 门钩拦截提交——静态规则只认「形状」不认守卫（2026-09-17）

- 症状：ZCode 会话里 `git commit` 被 Mimosa L3 拦截：vite.config.ts 学习中间件 12 处「path-traversal 入口」高危（spawnAgent/runAgent/writeSchedule/writeGoals/materialAbs 的定义与调用点），提示"高危已强制拦截，请修复并重新扫描"。**只拦 ZCode 会话内的提交**——用户手动 push-public.cmd、cron 里的备份 commit 都不经此钩子，不受影响。
- 根因：静态污点规则把「HTTP 请求对象 → fs 写入/exec 参数」一律标高危。materialAbs 其实早有 fail-closed 校验（拒绝分隔符/..），09-17 又补了 join 后 containment 双保险、model/sessionKey 白名单、writeSchedule 写入前校验——**守卫全在但规则看不见**，前后两次扫描结论一字不差（49 高危/1 中危）。这批写法是 9-12 起就有的存量代码，此前提交能过只因扫描一直不完整（scanner_enobufs 走兼容策略），当天第一次跑完全量才激活门禁。
- 解决方案（未执行，二选一）：
  1. **正规出口**：用户明确同意后跑官方深度扫描（`/mimosa-scan` 或 MCP `security_scan`），用 finding 级行为 Oracle 验证真守卫、正式关掉误报——README 明言 `mimosa validate <findingId>` 是 allowlist 级运行验证；勿手改 `.mimosa/finding-ledger/`（属绕过安全机制）。
  2. **阶段 5 重构顺带解决**：vite.config.ts 拆模块时把 study 写入重构成「白名单字段克隆后落盘」（请求对象先过显式字段提取），大概率同时满足静态形状。
- 当前状态：09-17 的加固+文档改动停在暂存区未提交（工作区文件已生效，vite 热更不依赖提交）；前两笔（f6b35df/ef2fdb1）在门禁激活前已落库。
- 状态：未解决（提交被拦）；运行无影响。

## \[已解决·要警惕] 开机自启动的「幽灵网关」——从 C 盘旧状态目录拉起、与 K 盘正牌网关抢 18789（2026-09-17）

- 症状：启动文件夹（shell:startup）里有 `OpenClaw Gateway.vbs`，登录即隐藏运行 `C:\Users\Administrator\.openclaw\gateway.cmd`——一个**用错状态目录**的网关，且抢占 18789 端口；与「禁止开机自启」的用户红线冲突。
- 根因：早期（迁到 K 盘状态目录之前）装的自启动残留。谁先绑定 18789 谁活：开机后若幽灵网关先起，正牌网关（K 盘 state、QQ/微信凭据、会话库全在那边）会被顶掉或共存打架——历史上「网页有会话但通道失踪」「状态目录错乱」类玄学问题大概率有它一份（如 9-13 `rana-web/openclaw.openclaw.openclaw/` 误建库事件同族）。
- 解决方案（2026-09-17）：自启动 VBS 移出启动文件夹（存 `C:\Users\Administrator\.openclaw.old\OpenClaw Gateway.vbs.disabled`，想恢复放回去即可）；整个 C 盘旧目录改名 `.openclaw.old` 观察一周后删。已核实无计划任务/自启动项再引用该目录。
- 排障抓手：`ls shell:startup` 看有没有 OpenClaw 项；`Get-CimInstance Win32_StartupCommand` 查引用；开机后 18789 被 PID 命令行含 `C:\Users\Administrator\.openclaw` 的进程占住 = 幽灵复活。
- 状态：已解决（自启动已停、旧目录已隔离）。

## \[已解决·要警惕] QQ 通道断网后重连耗尽「静默装死」——网络恢复也不自愈（2026-09-17）

- 症状：QQ 私聊/群聊全部离线，但网关进程活着、密钥/补丁/配置全正常；日志里 qqbot 子系统最后一次输出停在断网期间，之后再无任何报错（连"channel exited"都没有）。
- 根因：主机断网 9 小时（03:08–12:27，时间与迁移 WSL 吻合）期间，QQ 插件（@tencent-connect/openclaw-qqbot 2.0.3）的 WebSocket 例行重连（每 30 分钟 4009）从 03:08 起连续失败，**04:46 退避耗尽后彻底放弃重试且不再输出任何日志**。微信是轮询式通道能自愈，QQ 长连接不能——网络恢复后就成了"僵尸通道"。对照取证：`channels status --json` 的 `channels.qqbot.connected=false` 即僵尸铁证；进程对外连接里没有 api.sgroup.qq.com 的任何现解析 IP。
- 解决方案：标准重启（taskkill 网关 → start-gateway.cmd），重启后 `[qqbot] gateway READY` 即恢复。**防复发已落地**：`rana-web/health-patrol.mjs` 每 30 分钟查 `channels status`，QQ 不健康 30 分钟内必被发现并 QQ 私聊报警（见 SYSTEM-MAINTENANCE-PLAN.md 阶段2）。
- 排障抓手：QQ 连不上先看 `%TEMP%\openclaw\openclaw-当日.log` 搜 qqbot——**日志完全安静 = 大概率僵尸，直接重启**；有 100016 循环才是 secret 问题（见 9-13 条目）。注意 `rana-web/.gateway.log` 是陈旧文件（9-15 后不再更新），别再当依据。
- 状态：已解决（当日重启恢复；巡检兜底已上线）。

## \[已解决] cron 小写 store 孤儿病大面积发作——备份/git 日报/学习日报静默停摆 5 天（2026-09-17）

- 症状：Daily Private Backup 最后成功推送停在 9-12 17:30（当天 robocopy 其实成功、是 git push 撞 Clash 半死 TLS eof 失败）；git 活动日报/周报/月报、学习睡前小结/周报最后收据全部停在 9-11/9-12；全部无报错无通知（备份任务 failureAlert=false，其它任务的静默属常态）。
- 根因（两层叠加）：①9-12 傍晚网关只调度大写 `K:\OpenClaw\...` store 后（9-14 私密桥条目已记录该机制），**所有恰好只存在小写 store 行的任务全部变孤儿**——不止私密桥，还有备份、git×3、study×2 共 7 个；②当天 push 失败的近因是 Clash 7897 半死（端口在听、TLS 全断，见 9-11 条目），重启 Verge 后恢复。备份脚本的重试用 `timeout /t 60`，该命令在 cron 无控制台环境**秒失败**（ERROR: Input redirection is not supported），重试间隔形同虚设。
- 解决方案（2026-09-17 落地）：①备份脚本 push 重试 3 次且延时改 `ping -n 61`；②备份任务重建进活 store（新 id f8b51148，每日 17:30）；③停网关→备份 `state/openclaw.sqlite`（`backups/cron-surgery-20260917-145423/`）→ `DELETE FROM cron_jobs WHERE store_key GLOB 'K:\openclaw*'` 一举清掉 13 条小写行（含 5 条真僵尸 + 8 条重复对的小写半边）→ git×3/study×2 五条**从备份库原行复活到大写 store**（保留原 job_id 与中文载荷，仅重置调度状态）→ 重启网关；④过期心跳小抄（挂僵尸 8bd6d022 上、声称"备份由本清单接管"）已删，备份职责唯一归 cron，巡检盯新鲜度。验证：19 条任务无重复全在调度；手动备份跑通并推送成功（与 origin 齐平）。
- 教训：**cron 收据（`cron_run_receipts` 表）才是任务死活的真相**，`cron list` 看不到死 store 的行；一个任务"配置在但收据停更"= 孤儿。backup 新鲜度已纳入 health-patrol 巡检（>26h 报警）。
- 状态：已解决（全链验证通过）。

## \[已解决] 前端「挂载单次取数、失败静默、不重试」——首屏面板随机空白（2026-09-17）

- 症状：定时任务页/技能面板/课表「刷新后有、有时又没有」；会话页从不中招。断网/网关忙/重启窗口期概率大增。
- 根因：三处同款模式——①CronPage 最严重：`gateway.ts` 的 `request()` 在 WS 非 OPEN 时**立即拒绝**，而 App 挂载才发起 connect，页面挂载比握手快就秒拒，之后只有 cron 事件能触发重拉（连上也不重拉）；②AgentKitCard 走 `/__rana/agent-info`（中间件拉 CLI 子进程 20s 超时），单次 fetch 失败只显示小字；③StudyPage 同款单次 fetch。会话页因 connect 回调主动刷新 + `sessions.changed` 防抖 + 八处触发点而天然自愈。
- 解决方案：①`request()` 在 WS CONNECTING 时排队等握手（上限=请求超时），新增 `onConnected()` 广播；②CronPage 挂载+重连双路重拉，错误文案可点击重试；③新增 `src/lib/fetchRetry.ts`（重试 2 次、指数退避），AgentKitCard/StudyPage 接入。tsc 通过。
- 教训：新页面取数要么走 fetchRetry，要么挂 onConnected——别再写裸的单次 fetch。vite 拆模块（规划书阶段5）时保持此约定。
- 状态：已解决（逻辑对齐根因；等待日常复验）。

## \[未解决·疑似] rana-web/.life/ 目录整目录消失——人生目标从未录入，内容库候选已捞回（2026-09-17）

- 症状：规划页「总览（人生目标）」「内容库」为空；`.life/` 目录连同 `.bak` 不存在；用户以为数据丢了。
- 根因（未实锤）：目录在 9-16 01:27 之后某时刻被仓库外动作删除。**关键反证：life 功能 9-15 深夜才上线，9-16 每次搜集会话注入的上下文都写着「（还没建人生目标）」，goals.json 里 0 个 lifeGoalId 引用——人生目标大概率从未录入过**，丢失的实际只有内容库搜集候选。头号嫌疑是 9-16/9-17「心跳马拉松」期间 Rana 拿着 workspace AGENTS.md 的后台整理授权误删（当时授权已在 9-17 收回，见心跳马拉松补录），无直接证据；git 从未跟踪该目录、私有备份 9-12 起停摆（见上条），故无恢复源。
- 解决方案：从被删 life-planner 会话的 zstd 归档（`agents/main/sessions/b8ecc360-*.jsonl.deleted.*.zst`，WSL zstd 解压）提取三次搜集共 **16 条候选**，按 LibraryEntry 契约重建 `rana-web/.life/library.json`；人生目标由用户在规划页重新录入。
- 排障抓手：被删会话数据没死——`agents/<agent>/sessions/*.jsonl.deleted.*.zst` 是全量归档，`wsl.exe zstd -d` 解开后按 `message.content[0].text` 找正文；Git Bash 调 wsl 记得 `MSYS_NO_PATHCONV=1`。
- 状态：数据已捞回；删除者未定案（若再发生，优先查心跳/整理类会话的 write/exec 轨迹）。

## \[已解决·防复发] 任务收尾把工具报错原话当回复外发——QQ 凭空弹 "⚠️ Read failed"（2026-09-16）

- 症状：00:09 QQ 私聊收到一条只有 "⚠️ Read failed" 的消息，看着像心跳或模型端点出了病。
- 根因：不是心跳（心跳在 xx:53 跑、会话是 `agent:main:main:heartbeat`）——是学习计划 Day3 课件任务在 `agent:main:dashboard` 会话的 announce 运行（00:00:34-00:09:55）收尾时，读当天日记 `workspace-main/memory/2026-09-16.md` 撞上"刚过零点文件还不存在"的 File not found（00:09:29）；模型 20 秒后已自行补救（00:09:49 新建日记并写好 Day3 记录，任务实际全部完成），但最终回复只抄了报错原话，被 announce 原样投到 QQ。全程 qwen3.8-flash 调用全 200，端点/网络无病。与 9-14/9-15 qwen「长工具链收尾不落笔」同族，都是**收尾表达问题**，不是端点病。
- 解决方案：主 workspace `AGENTS.md` 记忆三件套处新增「收尾汇报纪律」——当天日记不存在就直接创建再写（读不到不算事故）；汇报只说结果+一句话过程，工具报错原文不许原样当回复外发。该文件随启动上下文注入，对 main 的所有 turn 生效（dashboard/心跳/主会话全覆盖），无需动 openclaw.json。
- 状态：已解决（当晚课件已发、日记已补；约束已加，复发再登记）。

## \[已解决·复测坑] 规划页落地当天的两个测试坑：Git Bash curl 发中文=GBK 乱码入库、IAB 坐标点击偏移一格（2026-09-16）

- 症状：①用 `curl -d '{"title":"中文"}'` 测 `/__rana/life/*` 新中间件，写进 json 的中文全是乱码（GBK 字节被当 UTF-8 存）；②用 Playwright locator click 点 rana-web 顶部「🗺 规划」页签，实际打开的是左边的「⏰ 定时任务」——命中点整体偏移一格。
- 根因：①Git Bash 在 Windows 把命令行里的中文按 GBK 编码发出，服务端按 UTF-8 解析必乱（服务端无错，浏览器 fetch 走 UTF-8 不受影响）；②IAB 的 DPR 缩放怪癖再现（与「IAB 输入注入会阶段性完全失灵」同族）：Playwright 按布局坐标派发点击，IAB 内部渲染缩放后命中测试落在邻位元素上。
- 解决方案：①测中文接口一律把 JSON 写进 UTF-8 文件（Write 工具或 printf 重定向）再 `curl --data-binary @tmp.json`；②IAB 里驱动 rana-web 这类纯 React 按钮，用 `locator.evaluate((el) => el.click())` 走 DOM click（正好落进 TopNav onClick 兜底分支），完全绕开指针/坐标，稳定可用。
- 关联风险：规划页「让Rana去搜集」是 qwen3.8-flash 长工具链（多轮 web_search 后输出 JSON），已知该模型「工具干完不落笔」病（见 9-14/9-15 qwen 条目末尾）——life-planning skill 已写死「搜完立刻输出 JSON」+ 限 3~5 组搜索，中间件对无 JSON 回复返回可重试报错；若仍高发，在页面把该会话模型切成 DeepSeek/GLM 再试。
- 状态：已解决（两个坑都有稳定绕法；搜集链路待真实使用观察）。

## \[已解决·本地补丁] QQ 群图片被插件降级成文字占位 → 模型永远看不到图（2026-09-14）

- 症状：群里发的图片，Rana（rana-qq-public）只记「某某发了图」；钉多模态模型（qwen3.8-flash）也没用；群画像翻不到图的内容。
- 根因（四环排查后锁定）：**@tencent-connect/openclaw-qqbot 插件 2.0.3 的入站装配只把语音接进媒体通道**。QQ 事件里的图片附件被 `attachmentProcessor` 下载到了本地（`localMediaPaths`），但 `buildCtxPayload` 组装给核心的消息时 `media:` 字段只收 `startsWith("audio/")` 的文件——图片只剩 `[image: 文件名]` 文字占位，下载的图片文件无引用。核心侧支持完好（agent-turn-attachments 会把 image 附件转成模型图像块）。上游现状：2.0.3=npm 最新；之后 7 个提交无入站图片改动；issue #300（相关：手机 QQ 把「@+图」拆成两事件、纯图事件被门控丢弃，`DEFAULT_GROUP_CONFIG.requireMention: true` 默认开）开放中零回复。
- 解决方案：本地补丁 `dist/index.cjs`（备份 `state/backups/index.cjs.bak-20260914-imagepatch`）：①`voicePaths/voiceUrls` 过滤 audio→audio+image（新增 `mediaTypeOk`）；②`media:` 三元表达式重写为 IIFE——本地文件按 audio/image 双白名单成对取 `{contentType, localPath}`（顺带修了原代码过滤后索引与 `localMediaTypes` 错位的隐患），远端 URL 按扩展名补 image 项。`node --check` + 网关重启验证过。
- ⚠️ 维护：**插件升级/重装会覆盖本补丁**——升级后按本条目重打（或查上游是否已修）。测纯图（无 @ 文本）仍可能被 #300 的门控丢事件：要收纯图需对具体群设 `channels.qqbot.groups.<群openid>.requireMention: false`（代价=处理群里每条消息）。另一依赖：群画像任务若钉 qwen3.8-flash 会撞上一条目（qwen3.8-flash 带工具隔离 turn 400），识图链路要通需两个问题都避开。
- 状态：已解决（补丁落位、网关重启、渠道 READY；实际识图效果待群里实测）。

## \[已缓解·根因待查] 隔离类 turn 全被 qwen3.8-flash 400 拒绝——心跳/画像 cron 弹 "LLM request failed: provider rejected"（2026-09-14）

- 症状：QQ 私聊弹 "LLM request failed: provider rejected the request schema or tool payload"；当天日志 10 起同指纹失败（rawErrorHash sha256:341298593183，failoverReason=format，`400: [Malformed diagnostic JSON redacted]`）。中招的全是**隔离会话 turn**：每小时心跳（xx:52-57 分）、4:38 画像 cron、dashboard 会话；主会话聊天 turn 无失败记录。9-13 全天零报错。**补录（9-15 凌晨复盘）**：9-14 同一端点其实出了三种病——除 400 外还有 14 次 `Connection error`（实为 13:50/18:55/19:55 三波秒级重试风暴）和 3 次 `Provider returned an incomplete or malformed tool call`（14:49/22:23/22:40，HTTP 200 但生成内容残缺）；三种病 9-13 全为 0。
- 根因（待实锤）：时间线与 0:24 网关重启首次加载 acpx 插件吻合，头号嫌疑是 acpx 给工具列表新增 `acp_sessions` 等 schema 后 token-plan 的 qwen3.8-flash 端点拒绝整包 payload（400 非 JSON 网关页）。旁证：glm 系全天全绿、无工具的 model-test 全绿、问题仅在"带工具的请求"。已排除：deny acp\_sessions 无效（实验 A）；画像 cron payload 未改过也中招（排除心跳 prompt 写错）。**反证（9-15 复盘）**：0:24 加载 acpx 后 02:50 的心跳（qwen）依然成功——"架构一更新就全死"不成立；失败集中在 04:38-20:47（北京时间白天到晚间），02:50 与 21:55 之后均正常，呈**日间倾斜**，更像端点自身病了半天。
- 解决方案（实验 B，已生效）：隔离类 turn 换 glm 路线绕开——①`agents.defaults.heartbeat.model: "glm/glm-5.3-flash"`；②画像 cron `openclaw cron edit 854405fc... --model "glm/glm-5.3-flash"`。**⚠️ heartbeat.model 对运行中心跳不热生效（同 bindings 热重载坑），必须重启网关**。验证：重启后心跳/画像 cron 的 glm 调用全 200（\[model-fetch] status=200），心跳结果正常投递 QQ。
- 遗留风险：`main.model` 仍是 qwen3.8-flash——今天主会话 turn 未复现失败，但若 QQ 聊天也弹同款错误，一行 `agents.entries.main.model: "glm/glm-5.3-flash"` 即可绕开。
- 实验 C（2026-09-15 00:04-00:24，用户批准后执行）：手动心跳 A/B 对照，各 3 次——**臂1**（acpx 开 + 心跳摘 glm 钉回落 qwen）3/3 成功（76s/60s/113s）；**臂2**（acpx 关 + 心跳 qwen）端点层面同样干净（无 400/畸形/断连，21.5s/27.5s 两次成功）。两臂全绿 = **qwen 端点当夜已自愈，acpx 载荷诱因假说无法在同一病窗内复现，悬置**。臂2 唯一失败是一次 `agent-tool-failure`：模型把消息工具目标写成 `qqbot:c2c`（漏了 openid 后缀，提示语里就有正确格式），9-13/9-14 均零发生，属 qwen 单发手滑，与端点无关——已应用户要求在 `agents.defaults.heartbeat.prompt` 末尾追加目标格式提醒（提醒对任何心跳模型都有效；prompt 热生效，9-15 00:45 验证心跳 ok）。实验全程配置动过三处（heartbeat.model、activeHours.end、acpx.enabled），结束后已还原并与实验前备份 `openclaw.json.bak-expc` 语义比对一致，还原后心跳 00:23 glm ok（199s）。
- 教训：①"弹了两次"≠只发生两次——先 grep 指纹再数；②失败时间分布（xx:52-57）直接暴露触发源是心跳；③cron/heartbeat 的模型覆盖改动**不热生效**，验证前先重启网关；④手动触发心跳用 `openclaw cron run <heartbeat jobId>`，成败看 `openclaw cron runs <jobId>` 的 status/durationMs；heartbeat 是 system-owned 任务，`cron disable` 会被拒（"system-owned monitor jobs cannot be edited"）。
- 状态：已缓解（glm 路线全绿）；实验 C 已做：当晚两臂全绿无法归因，acpx 诱因假说悬置，主嫌疑 = token-plan qwen3.8-flash 端点日间不健康（已自愈）。**9-15 用户拍板：心跳 glm 钉已拔**（回落 qwen3.8-flash，00:53 心跳 22.6s 绿、运行窗口 14 次调用全 qwen 全 200；术前的 glm 配置存 `openclaw.json.bak-unpin-hb` 可随时回钉）；**主人画像 cron 也已切回** **`aliyun-maas/qwen3.8-flash`**（cron edit 即时生效无需重启）。⚠️ 但 9-15 01:01 画像手动验证跑暴露新问题：47 次 qwen 调用全 200、跑 468s，工具活干完却不写画像档案（停在 9-13 05:15）、"settled post-tool turn lacked a final answer"+finalization 失败（模型收尾时又去调工具）——与 9-14 晚 dashboard 同 signature，但端点健康下复现 = qwen3.8-flash 长工具链收尾问题，非端点病，待查。另：群画像（b566bd64，240s 上限）实际约每 30 分钟跑一次增量而非名单显示的每日，偶发 240s 超时后下一轮自愈。
- **补录（9-17 凌晨）——同一收尾病在心跳身上的放大形态：心跳马拉松**。数据：正常班一直 24~120s，但 9-16 00:02=442s、11:09=564s、9-17 00:33=557s（该班跑完后系统 isolated finalization 产出英文元话术 "Final answer: The current transcript…" 外发 QQ）、9-17 01:05 班 600s 撞死全局超时（QQ 收到超时罐头话）。机制：心跳是隔离小会话无上下文膨胀，变长全是 qwen 拿着 workspace AGENTS.md「用 cron/心跳做后台整理（更新文档都可以自主做）」的授权在心跳里跑 18 轮工具马拉松且不落笔。处方（9-17 已落地，治机制不换模型）：①`agents.defaults.heartbeat.prompt` 追加巡查纪律（工具≤8 次、长活只记待办不施工、收尾必须中文人话，prompt 热生效无需重启，备份 `openclaw.json.bak-hbpatrol`）；②workspace AGENTS.md「定时任务」段改写为巡查/施工分工，收回心跳的长活授权（每班新会话自动注入）。openclaw **没有**心跳专用的轮数/超时旋钮（600s 是全局 `agents.defaults.timeoutSeconds`，动它误伤主会话长任务）。观察 1~2 天：再出现 >300s 班或超时 → 执行后备 = 回钉 glm（配置在 `openclaw.json.bak-unpin-hb`，需重启网关）。

## \[已解决] 微信通道静默死亡——网关进程丢 OPENCLAW\_STATE\_DIR，微信插件回落主目录找不到账号（2026-09-14）

- 症状：微信发消息无回复（RP 侧），但网页端聊天正常、QQ 正常。`openclaw channels status` 的列表里**微信整个消失**（只剩 QQ），`status --json` 显示 `openclaw-weixin: {configured:false}` 且 `channelAccounts` 为空数组；网关日志里微信插件除 `[compat] OK` 外零输出（无 `starting weixin provider`、无报错）。微信插件的真实活动停在出事那次网关重启（同步游标文件 `openclaw-weixin/accounts/*sync.json` 的 mtime）。
- 根因：微信插件的凭据不在 openclaw\.json（那里只有 `channelConfigUpdatedAt` 一个字段，属常态），而在 **state 目录** `openclaw-weixin/accounts/` 下。插件找 state 目录的顺序是 `OPENCLAW_STATE_DIR` → `CLAWDBOT_STATE_DIR` → `~/主目录/.openclaw`，**不认** **`OPENCLAW_HOME`**；而网关核心只认 `OPENCLAW_HOME`（用户级变量，指向 `K:\OpenClaw\.openclaw`）。网关进程的 `OPENCLAW_STATE_DIR` 丢失（启动脚本 `start-gateway.cmd` 里明明 `set` 了，但进程环境块里没有——openclaw 启动器/agent-exec 有多处「保存-恢复该变量」的代码，存在弄丢路径；用 psutil 读进程环境实证缺失），插件于是回落到 `C:\Users\Administrator\.openclaw` 找账号 → 空列表 → 通道从不启动且不报任何错。QQ 无恙是因为其凭据直接写在 openclaw\.json。诊断时的迷惑点：CLI 侧 `channels list` 说「configured」（CLI 进程里有变量），网关侧说没配置——同一文件两个进程结论相反即此病。
- 解决方案（2026-09-14 落地）：①`setx OPENCLAW_STATE_DIR K:\OpenClaw\.openclaw\.openclaw` 写成**用户级永久环境变量**（与 OPENCLAW\_HOME 同址，以后任何方式启动网关都带）；②按标准流程重启网关（taskkill + start-gateway.cmd，启动时再在父进程显式注入一次双保险）。验证：`channels status` 出现 `openclaw-weixin ... running, in:1m ago`，日志出现 inbound + `outbound: text sent OK`，微信实测收发全通。
- 排障抓手：①`channels status --json` 看 `channelAccounts.<通道>` 是否为空数组（空=插件没找到账号）；②对比 `channels list`（CLI 本地视角）与 `channels status`（网关视角）对同一通道的结论；③`python -c "import psutil; print(psutil.Process(<网关PID>).environ().get('OPENCLAW_STATE_DIR'))"` 直接验尸进程环境；④微信插件代码在 `.openclaw/.openclaw/npm/projects/tencent-weixin-openclaw-weixin-*/`，其 `src/storage/state-dir.js` 即目录解析逻辑。
- 状态：已解决（setx 永久变量 + 重启后全链路实测通）。

## \[已解决·部分上游限制] "Automation" 会话删不掉——run 会话 gateway 不认 + 父会话被 placement 残留卡死（2026-09-14）

- 症状：会话列表里一批 cron 产生的会话（前端显示 Automation 开头）删不掉；点 ✕ 或 CLI `sessions delete` 报错。两类症状：①`agent:main:cron:<jobId>:run:<runId>` 的 **run 级会话** → `Session not found`（gateway 的 delete 接口不认 run 级 key，哪怕 `sessions list` 能列出来）；②`agent:main:cron:<jobId>` 的**父会话** → `could not safely stop ... cloud worker placement identity changed`（state 主库 `worker_session_placements` 里 13 行 run 级残留 `terminal_reason=NULL`，"删除前安全停止"校验永远不过）。`sessions cleanup` 只是常规维护，不清这些。
- 根因：cron 每次执行产生 run 会话；run 的 placement 在任务结束后不清（残留），父/子删除路径都被它卡死或排除。多数涉事 job id 已不在现役 cron 表（死任务遗骸）。
- 解决方案（09-09 手术法的 2026 复用+扩展）：①停网关 → 备份 `state/openclaw.sqlite` 与 `agents/main/agent/openclaw-agent.sqlite` → `DELETE FROM worker_session_placements WHERE session_key LIKE '%:cron:%'`（**只删 cron 类，main/群聊等活跃 placement 别动**）→ 重启网关；②父会话 `openclaw sessions delete <key> --agent main --yes` 逐个删（会级联归档；删除确认必须 --yes，且**全局 key 必须带 --agent**，否则误报 Session not found）；③**run 级会话 delete 依旧 not found（gateway 不认，上游限制）**——placement 已清、不再占用，列表残留交给前端「系统会话」隐藏开关（Sidebar 默认隐藏 `:cron:`）。残留小写 store\_key 行（09-14 已登记）留给 doctor --fix（2026-10-01 已跑完）。
- 一键化（2026-09-15 落地）：上述手术流程脚本化为 `rana-web/cron-session-cleanup.mjs`（自动停网关→备份含 -wal/-shm→清 placement→重启网关→按 agent 枚举删 cron/heartbeat 父会话；`--dry-run` 只盘点不动刀），进度落盘 `%TEMP%\openclaw\cron-session-cleanup.json`；界面入口在会话页左下角「🧹 清理系统会话」（`/__rana/sessions-cleanup` 中间件拉起+轮询）。**脚本会短暂停止网关（约 30-60 秒），微信/QQ 通道期间暂停**。上游 bug（run 级 delete 不认 + placement 不清）拟向上游报 issue，已登记进 OPEN-SOURCE-ROADMAP.md 阶段一。
  - 首日两 bug 修复实录（都可复用）：①`node:sqlite` 的 DatabaseSync **没有顶层** **`db.run()`**，增删改必须 `db.prepare(sql).run(params)`（参数绑定）；②JS **正则字面量不做变量插值**——`/:${PORT}\s/` 匹配的是字面文本 `${PORT}`，端口拼接必须 `new RegExp()` 或改用 `includes(":18789 ")`。②的副作用曾让"停网关"静默失效（手术在 WAL 模式下热做居然也成功，说明该 DELETE 对运行中的库也安全，但流程仍按先停后做设计）；taskkill 失败已从静默 catch 改为写进进度日志。
  - 已知常态：`agent:main:main:heartbeat` 会话节点删后会被心跳系统自动重建（实测 10 分钟内回来），属上游行为非故障；真正占列表的大头是梦境/cron 积累，清理后增长缓慢，随手点一下即可。
- 状态：已解决（13 行 placement 清除、5 个父会话删除、19→6 条；run 级残留 4 条为上游限制，UI 已默认隐藏；术后可用一键脚本随时重清——09-15 dry-run 实测又攒了 6 个父会话、9 行残留）。

## \[已解决] 心跳 30 分钟整会话唤醒、94% NO\_REPLY 空转 ≈500 万 token/天 + 记忆桥降频 + 私密桥复活（2026-09-14）

- 症状（诊断口径）：heartbeat 每 30 分钟在 `agent:main:main` 整会话跑一轮（9-13 实跑 33 次、31 次 NO\_REPLY），每次携带 \~15 万 token 上下文（cacheRead），折 \~5M tokens/天；心跳 turn 实测 11-72s，与用户消息在主会话互斥排队（"说话等好一会"的贡献者之一）。另：main 主会话自 9-8 无压缩滚到 151,762/262,144（58%）。
- 根因：心跳默认无 isolatedSession/lightContext，每轮带全量主会话；30m 间隔过密；`agents.defaults.heartbeat` 旧块（`{agentId, target}`）在启动日志反复报 Invalid input（strict schema，字段集不全时整块拒收但任务仍按默认跑）。
- 解决方案（2026-09-14 落地）：①心跳块补全合法字段集：`every:"60m"` + `isolatedSession:true`（每次全新小会话，官方口径 \~100K→2-5K tokens/次）+ `lightContext:true` + `activeHours:{start:"10:00",end:"01:00",timezone:"user"}`（深夜静默）+ 自定义 prompt（自己读日记判断，没事只回 NO\_REPLY）；②主会话瘦身：顶层 `session.reset:{mode:"daily",atHour:6}` 每日翻新 + 立即归档一次（chat.send "/new" 会排队 216-530s 才回包，别急着判失败；`openclaw sessions compact --max-lines 60` 是无模型依赖的即时截断路，但要求无 active run）；③记忆桥 `*/30`→`0 * * * *`。
- ⚠️ 附带挖出真 bug：**private-memory-bridge 任务是孤儿**——cron\_jobs 表里它的 store\_key 是小写 `K:\openclaw\...`，网关只调度大写 `K:\OpenClaw\...` store（历史大小写双 store 遗留），即**私密记忆桥从 9-12 18:07 起就没被网关跑过**（private-memory/ 目录停更两天）。解法：`openclaw cron add --name private-memory-bridge --cron "17 * * * *" --exact --command-argv '["G:/node/node.exe","K:/OpenClaw/rana-web/private-memory-bridge.mjs"]' --no-deliver --agent main` 重建进网关 store。孤儿行与 memory-bridge 的小写残留行留给 `openclaw doctor --fix`。
- 状态：已解决（重启网关后 heartbeat 显示 every 1h 且 Invalid input 警告消失；两桥任务在列；主会话 total 归零）。

## \[已解决] 新页签四处注册漏一处 → groups/dsh 页签 UI 永不可达（2026-09-14）

- 症状：群画像页（195 行）与派活页（108 行）代码完整、路由分支齐全、git 也提交了，但顶部导航永远不显示这两个页签。
- 根因：页签注册有**四处**——`types.ts` 的 `AppView`、`TopNav.tsx` 的 `TABS`、`App.tsx` 的渲染分支、`store/useAppStore.ts` 的 `ALL_VIEWS`（TopNav 只渲染 `tabOrder`，而 `loadTabOrder()` 按 ALL\_VIEWS 过滤补齐）—— GroupsPage/DshPage 两次提交都改了前三处，**唯独漏了 ALL\_VIEWS**。tsc 与运行时都不报错，纯逻辑性遗漏。
- 解决方案：单一来源化——`NAV_TABS` 常量上移到 `lib/types.ts`（8 个页签），TopNav 渲染与 store 的 `ALL_VIEWS = NAV_TABS.map(t=>t.id)` 都引用它；**以后新增页签只改 types.ts 一处 + App.tsx 一个分支**。
- 教训：涉及"清单两处维护"的注册点，要么合并为单一来源，要么在台账里记全注册点清单。
- 状态：已解决（tsc 过；页签 8 个）。

## \[已解决] QQ 机器人渠道 secret 校验失败循环重连 + QClaw 桌面版双实例隐患（2026-09-13）

- 症状：网关日志每 60s 刷 `[qqbot:<appId>] Connection failed: ... {"code":100016,"message":"invalid appid or secret"}`，attempt 一直涨；QQ 私聊/群聊全部离线。
- 根因：openclaw\.json 里 `channels.qqbot.clientSecret` 与开放平台当前值不匹配（期间另发现 QClaw 桌面版 `K:\QClaw\v0.2.33.617` 内置 OpenClaw 也在跑同一渠道，同 appId 双实例存在互踢隐患，2026-09-13 用户已卸载 QClaw）。
- 解决方案：用户提供有效 AppSecret → 写回 openclaw\.json（先备份）→ 重启网关。
- 状态：**已解决（2026-09-14）**——secret 已写入，重启后日志 `✅ Access token obtained` + `[qqbot] gateway READY`，无 100016。

## \[已解决·等用户实测] WSL2 无法启动——HCS\_E\_HYPERV\_NOT\_INSTALLED（2026-09-13）

- 症状：任何启动 Ubuntu-22.04 的命令报 `Wsl/Service/CreateInstance/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED`，持续性故障非瞬时；桌面 HTA 与 rana-web 状态页的「WSL 模式」按钮切了两次都打不开。
- 根因：**切换器本身有缺陷**——「游戏模式」一口气关四样（hypervisorlaunchtype off + VBS + HVCI + 凭据守护），「WSL 模式」却只开 `bcdedit hypervisorlaunchtype auto` 一样，**从不装回「虚拟机平台」（VirtualMachinePlatform）功能**；反复开关后该功能层被卸（WSL2 靠它），于是 auto 也救不回来。
- 解决方案（2026-09-14 已修两处切换器，等用户点一次 + 重启）：「WSL 模式」路径补 `dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`（幂等，功能在就秒过）+ `Microsoft-Windows-Subsystem-Linux` 同理。修的是 `G:\Desktop\傻逼tx关我wsl.hta`（GBK 编码原样保留）与 `rana-web/vite.config.ts` 的 `switchVirt("auto")` 分支。「游戏模式」分支未动。
- 预防：以后凡「切回 WSL」的动作都必须走 dism 补功能层，只开 hypervisor 是欠账。
- 状态：已解决（代码层）；等用户点「WSL 模式」→ UAC → 重启后实测 WSL 起 → 补 DSH 冒烟。

## \[已解决] openclaw plugins install 走 npm 不带代理 → termination timeout（2026-09-13）

- 症状：`openclaw plugins install @openclaw/acpx` 命令 exit 0 但实际 `npm install failed: termination timeout (no output from npm)`，npm/projects 留空壳目录；版本解析正常（`Resolved @openclaw/acpx@2026.9.4 ... incompatible ... using 2026.9.2`）说明 CLI 本身通了，是 npm 下载阶段挂死。
- 根因：registry.npmjs.org 直连超时；本机网络惯例是走 Clash 代理（127.0.0.1:7897），但 CLI 内部调 npm 不继承 git 的代理配置。
- 解决方案：安装命令带 npm 环境变量：`npm_config_proxy=http://127.0.0.1:7897 npm_config_https_proxy=http://127.0.0.1:7897 openclaw plugins install <包名>`；失败残留的 `npm/projects/openclaw-<pkg>-*` 空目录先删再装。
- 状态：已解决（acpx 2026.9.2 装成，兼容当前运行时）。

## \[已解决] 右上角「⚡测连通」全灭——下拉发裸模型名，服务端误当接口名解析（2026-09-13）

- 症状：模型选择器里点任何模型的 ⚡ 都显示「✗不通」（悬停提示：`找不到 provider：<模型名>`），怀疑 apiKey 被密钥库藏坏了。
- 根因（主犯）：gateway `models.list` 目录的 id 是**裸模型名**（如 `qwen3.8-flash`），provider 是独立字段；前端 Topbar 只把裸名 POST 给 `/__rana/model-test`，端点却按「`/` 前第一段=providerId」解析——没有斜杠时整个名字被当成 provider，必然报「找不到 provider」。**排查时 curl 手写完整** **`provider/model`** **能测通，把真凶掩盖了**（第一轮误判成「额度+旧标签页」）。真实叠加项：aliyun-maas 8 个 429=token-plan 周配额尽（09-13 15:01 北京时间重置）、bailian deepseek-v4-flash-0731 403=免费额度尽——429/403 恰说明 key 有效（401 才是 key 坏）；另有思考型模型 max\_tokens=16 回复必空（推理就要几百 token）。
- 解决方案：①端点三路解析：完整 `provider/model` → 裸名+显式 providerId（前端 test() 现在会带）→ 裸名全配置唯一匹配，撞车（qwen3.8-max 三家都有）就挨个试、谁先通算谁；②附带优化：max\_tokens 16→512、超时 45s→75s、429/401/403 报错加人话前缀（额度用完≠key 坏）、空回复带 note（前端 ✓ 后缀 💭）。
- 教训：**测带参接口必须用调用方的真实请求形状**（从页面 store/DOM 抠出来），手写"标准"参数会造出全绿的假阳性；IAB 点击注入失灵时，`playwright.evaluate(fetch...)` 是等价的用户视角验证路。
- 状态：已解决（页面内实测 glm/bailian/lmstudio/qwenanliang 全 ✓，aliyun 按设计回人话 429；22 个模型 13 通、9 个不通全为账号侧额度问题）。

## \[已解决] QQ 机器人接入三连环坑：私聊默认全拦 / 多 agent 必须显式绑定 / 通道会话混入主窗口（2026-09-12）

- 症状：`openclaw channels add --channel qqbot` 成功、日志 `gateway READY`，但 QQ 私聊无回复。日志三种形态依次出现：`[access] blocked c2c from <openid>: not in allowFrom`（权限拦）→ 修权限后 `dispatch error: AgentSelectionRequiredError: ... no explicit owner`（路由缺）→ 修路由后消息落入 `agent:main:main` 主会话（与微信/网页三个入口混一个上下文）。
- 根因：①channels add 生成的默认 allowFrom 不放行任何真实用户，dmPolicy=open 下所有私聊被静默丢弃；②本项目 `agents.ownership=explicit` 且多 agent（main/rana-rp），每个通道必须在顶层 `bindings` 有显式 owner；③通道级绑定默认把消息路由进 agent 主会话，多通道共享聊天上下文。
- 解决方案：①`allowFrom` 填对方 openid（QQ 开放平台匿名 ID，从被拦日志直接抓，**不是 QQ 号**）并 `dmPolicy=allowlist`（白名单制）；②`bindings` 加 `{"type":"route","agentId":X,"match":{"channel":"qqbot","accountId":"default"}}`；③窗口要分开就绑**不同 agent**（各 agent 独立 sqlite，天然隔离）。终态布局（2026-09-12 用户两次调整后定稿）：**QQ→main（云端 flash，QQ 客户端功能多）、微信→rana-rp（本地 14B，RP 乐奈）**。**⚠️ 第四坑（同晚实证）：bindings 改 agentId 对"已活跃会话"热重载不生效**——运行中网关的会话路由粘在旧 agent 上（QQ 新会话能生效、微信老会话不跟），CLI `agents bindings` 读到的配置是对的但网关行为不对，表现为"改完绑定微信还是走云端"。解法：重启网关（清掉全部路由缓存），别信热重载。QQ 开发者控制台"未连接"指示灯不可信——WebSocket 实连且收发正常，以实测聊天为准。
- 状态：已解决（2026-09-12 全链路验证：收消息→本地 14B 生成→回复送达，约 48s/条）。
- ⚠️ 第五坑（2026-09-13）：终态跑偏——`agents.defaults.model.primary` 被写成本地 `rana-rp-14b` 而 main 无显式 model（吃默认），`rana-rp` 条目反被指到云端 flash，表现为「QQ→main 却是本地模型回话」。解法两层：①openclaw\.json 修正 defaults 与 main=云端 `aliyun-maas/qwen3.8-flash`、rana-rp=`lmstudio-local/rana-rp-14b`（网关文件监听热重载）；②**会话级钉死模型也要改**——`agent:main:main` 的 model 字段停在 rana-rp-14b，仅改配置不动会话等于没改；用网关 RPC `sessions.patch {key, model}` 热生效，无需重启网关（第四坑的「热重载不生效」只针对 bindings 换 agent，模型 patch 是即时的）。
- ✅ 多用户双待遇方案（2026-09-13 落地）：QQ 私聊全面开放，主人与陌生人各走各路——①`bindings` 支持按发信人精确匹配（`match.peer:{kind:"direct",id:"<openid>"}`），优先级高于频道级绑定：主人 openid→main（全套私人上下文），频道兜底→独立 agent `rana-qq-public`（专属工作区只放无私人信息的 SOUL/AGENTS、`tools.profile:"minimal"` 全锁、独立 sqlite，物理隔离）；②兜底绑定带 `session:{dmScope:"per-peer"}`，每个客人自动独立会话（`agent:rana-qq-public:direct:<openid>`）互不串；③`channels.qqbot.dmPolicy:"open"` + `groupPolicy:"disabled"`（群聊不开）。绑定改动需重启网关（第四坑同款）。
- ⚠️ 第六坑（2026-09-13）：**经 bash 向 JSON 写 Windows 反斜杠路径会被吃**——脚本经 shell 传输时 `\\` 折成 `\`，JS 字符串再把它当转义吞掉，`K:\OpenClaw\...` 变成 `K:OpenClaw...`（agent workspace 解析成不存在的目录）。解法：OpenClaw 配置里的 Windows 路径**一律写正斜杠** `K:/OpenClaw/...`（node 全兼容），别用反斜杠。
- ⚠️ 第七坑（2026-09-13）：`dmPolicy:"open"` 但 `allowFrom` 不含 `"*"` 时，core 配置层警告 **"all DMs will be dropped"**（且目录 schema 又禁止写 `"*"`，open 与白名单语义在 core/plugin 两层有分歧）。结合平台现实（QQ 个人开发者未放开，陌生人本来就私聊不到机器人），终态 v3 定稿：**`groupPolicy:"open"`（群聊=公开入口，@才回，走公共 agent，每群一个会话）+** **`dmPolicy:"allowlist"`（私聊白名单，实际受众=开发者沙箱名单里的人，主人 openid 在列）**。以后有朋友进了沙箱名单要私聊：从被拦日志抓 openid 塞进 allowFrom。

## \[行为说明] `openclaw gateway restart` 在本项目永远报错——非默认 state dir 不走服务管理（2026-09-12）

- 症状：`openclaw gateway restart` 报 `service management skipped: non-default state dir or config path. Rerun with HOME set...`；新加 channel（如 qqbot）后想重启网关生效时必撞上。
- 根因：该命令走「服务注册」式管理，要求 OpenClaw 装在默认位置（C 盘用户目录）；本项目网关由 `rana-web\start-gateway.cmd` 手动拉起（脚本内 `set OPENCLAW_STATE_DIR=K:\openclaw\.openclaw\.openclaw`，无服务注册），CLI 检测到非默认路径直接拒绝——是保护行为，不是故障。
- 解决方案：项目标准流程——用 PowerShell `Get-CimInstance Win32_Process` 找 `openclaw.mjs gateway` 的 node PID → `taskkill /PID <pid> /F` → 分离重跑 `start-gateway.cmd`（`Start-Process cmd -ArgumentList '/c','K:\OpenClaw\rana-web\start-gateway.cmd' -WindowStyle Minimized`）。验证：`%TEMP%\openclaw\openclaw-当日.log` 搜对应 channel 的 `gateway READY` / `Gateway ready`。另：裸跑 `openclaw channels add` 能写对 K 盘配置位置（CLI 自行定位），无需手动带 `OPENCLAW_STATE_DIR`。
- 状态：已解决（2026-09-12 qqbot 实证：token 获取、WebSocket 连上 sgroup.qq.com、gateway READY 均正常，微信通道同步恢复）。

## \[已解决] embedding 模型双实例（qwen3-embedding-0.6b + :2）（2026-09-11）

- 症状：LM Studio 里 `text-embedding-qwen3-embedding-0.6b` 与 `text-embedding-qwen3-embedding-0.6b:2` 同时驻留（各 \~0.6GB 显存）；OpenClaw memory 子系统偶发 "memory embeddings retryable error" 重试。
- 调用方：OpenClaw **记忆子系统**（语义记忆索引）——main 与 rana-rp 两个 agent 各有一套索引，对话压缩/记忆落库后各自触发 embedding；openclaw\.json 无任何 embedding 配置，属自动探测 LM Studio 模型后的 JIT 加载。
- 根因：LM Studio JIT 按「模型+配置」区分实例——**同模型不同 context\_length = 两个实例**（实测一份 8192 一份 32768）；且模型卸载后的空窗期里两个调用方竞争加载也会裂开。
- 解决方案：全卸后用与 OpenClaw JIT 请求**完全一致**的参数显式加载一份常驻（无 TTL）：`POST /api/v1/models/load {"model":"text-embedding-qwen3-embedding-0.6b","context_length":32768}`；同参请求会复用不再裂开（同参复打验证仍 1 份，embeddings 调用返回 1024 维正常）。运维要点：
  - 卸载单实例：`POST /api/v1/models/unload {"instance_id":"<实例id>"}`——v1 卸载接口只收 instance\_id；实例 id 与 config 从 `GET /api/v1/models` 的 `loaded_instances` 数组看（/api/v0/models 不显示 instance\_id）。
  - `lms unload <key>` 会卸该模型全部实例；`lms load --context-length` 在本机对该模型报 Unknown error，改用 REST。
  - 与 09-10 的 rana-rp-14b:2 双实例同机制（当时显式加载 49152/parallel2 治好）。
- 状态：**已根治（2026-09-12 看门狗上线）**。历程：09-11 首治（32768 常驻）→ 09-12 上午复发（8192 再裂）→ 09-12 下午再复发，确认"手动治理"挡不住，转看门狗根治。终态方案（两层）：
  1. **embedding 转纯 CPU 常驻**：0.6B 模型算向量 CPU 足够（实测单次 \~90ms 出 1024 维），显存零占用，还消除了"显存紧张挤掉常驻→再裂"的诱因。注意 REST `/api/v1/models/load` **没有** GPU offload 字段（实测报 unrecognized\_keys），纯 CPU 只能走 `lms load <key> -c 32768 --gpu off -y`（lms.exe 在 `~/.lmstudio/bin/`）。
  2. **看门狗锁死**：`tools/embedding-watchdog.mjs`，由 `rana-web/start-gateway.cmd` 随网关启动（无开机自启）。死规则 = 任何时刻该模型**恰好 1 份、ctx 32768、纯 CPU**；每 60s 巡检 `/api/v1/models`，偏离就 unload 全部 + `lms load --gpu off` 重载。端口锁（47611）防网关重启后多开。日志 `%TEMP%\openclaw\embedding-watchdog.log`。
  - 已实测验收：人为 REST 加载 8192 制造 `:2` 双实例 → 60s 内自动收敛回 1 份 32768 纯 CPU。
  - 想**手动清掉**模型（比如临时挤内存）：先停看门狗（关网关窗口，或 `taskkill /F /IM node.exe` 前先按端口找 PID：`netstat -ano | findstr 47611`），再 unload；否则下一轮会被拉回。
  - 附注：本次排查确认裂开**与 QQ 不同群聊无关**——openclaw\.json 的 `memory.search` 全局一份，main / rana-rp / rana-qq-public 三个 agent 共用；裂点始终是"JIT 默认参数(ctx 8192, GPU) ≠ 常驻参数(32768, CPU)"。API 的 `loaded_instances[].config` 只回报 ctx 不回报 GPU 属性，看门狗靠"重载永远 --gpu off + ctx 校验捕获 JIT 裂份"闭环。
- **2026-09-18 新篇章：显存 10.7GB 尸体的真凶是后端版本行为**。重启后 LM Studio（llama.cpp CUDA 2.40.0）加载嵌入模型时**强制 batch=ctx**（服务端日志有明示警告），计算缓冲随 ctx 线性膨胀且**上 GPU——`--gpu off` 完全拦不住**：实测 ctx32768=10.7GB / 8192=6.6GB / 2048=2.3GB（模型本体仅 609MB）。处置：看门狗 STANDARD_CTX 32768→**2048**（嵌入输入是记忆小块 ≤千余 token，足够；OpenClaw 嵌入请求实测复用 2048 实例不裂开），显存占用 11.6GB→3.2GB。另：卸载模型后显存不还的情况也存在（进程级残留），整树重启 LM Studio（`taskkill /PID <根> /T`，注意 Electron 多进程、杀子进程没用）可清零。
- **2026-10-02 终章：裂份循环的发动机找到了——LM Studio 的 JIT TTL 在背后拆看门狗的台**。主人在 LM Studio GUI 亲眼看到"第二个同样的 embedding 模型"拉起（几秒后即被看门狗摘除）。取证（server 日志 `~/.lmstudio/server-logs/2026-10/`）：12:46:29 OpenClaw embeddings 请求进来时 qwen3 不在内存 → 12:46:39 LM Studio JIT 按模型级残留参数抢跑加载 → 12:46:41 看门狗 lms load 并行重载 → 双份并存约 4 秒 → 12:46:43 看门狗纠正回单份。**模型为何总缺席：`~/.lmstudio/settings.json` 的 `jitModelTTL {enabled:true, ttlSeconds:180}`——lms.exe CLI 加载的份同样被 180 秒 TTL 回收**（主人 >3 分钟不发消息，常驻份即被拆，下一条消息必触发 JIT 抢跑）；`unloadPreviousJITModelOnLoad:true` 再补一刀（JIT 拉新份时卸掉在驻份）。看门狗日志里 04:00-04:46 UTC 的 4 次"偏离纠正"即此循环的中间帧。
  - **修复（两层）**：①`settings.json` 两键关闭——`jitModelTTL.enabled=false`、`unloadPreviousJITModelOnLoad=false`（备份 `settings.json.bak-watchdog-fix-20261002`；**LM Studio 重启后生效**，重启会断微信 RP 的本地模型，择空闲时机手动做）；②看门狗 `tools/embedding-watchdog.mjs` 升级：纠正时**保留标准实例（ctx=2048）只摘非标份**（全清重载制造的空档正是 JIT 抢跑的窗口），仅无标准份才全清+重载；纠正后 15s/45s 各快查一次追杀竞态裂份。看门狗已于 10-02 12:59 换新进程（旧 49244 → 新 63532）。
  - 残留谜团：JIT 裂份的 ctx=32768 来源未定位（全局 defaultContextLength=8192，config-presets/models 目录均无 32768）——疑似模型级"上次加载参数"记忆，不影响上述修复（看门狗按 ctx 校验兜底）。
  - **连带修：巡检时长天文数字**。`rana-web/health-patrol.mjs` 引用网关自报 `degradedSinceMs` 算"已持续 N 分钟"，该时间戳坏过（报 2985 万分钟≈57 年，升级前就有），已加 24h 合理性闸——超时按"连续两班（开始时间戳异常，时长未知）"口径处理。

## \[已解决·会复发] Clash 7897 被 Windows 动态端口保留段圈占 → 代理失效 → git 推送 GitHub 挂死（2026-09-11）

- 症状：`git push` 报 `Failed to connect to github.com port 443 via 127.0.0.1`（直连被墙必须走代理）；Clash Verge 界面看似正常、clash-verge.exe / verge-mihomo.exe 进程都在，但 `netstat` 查 7897 无监听，mihomo 只开着 DNS:53。**注意与"Clash 内核半死"区分：重启 Verge 进程无效**，sidecar 日志（`%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\logs\sidecar\`）里能看到真凶：`Start Mixed(http+socks) server error: listen tcp :7897: bind: An attempt was made to access a socket in a way forbidden by its access permissions.`
- 根因：Windows 的 Hyper-V/WSL NAT（winnat 服务）会在**动态端口范围内随机圈占保留段**，本机动态端口范围被设成了 1024–15000（默认应为 49152–65535，过宽），7860–7959 保留段把 7897 圈进去，任何进程都无法绑定。保留段每次 winnat 重启/系统重启会重新随机分配，所以表现为"时好时坏"。
- 解决方案（照方抓药，需管理员）：
  1. `netsh int ipv4 show excludedportrange protocol=tcp` 确认 7897 落在某个保留段内；
  2. 提权重启 NAT 让段重算：`net stop winnat && net start winnat`（会闪断 WSL 虚拟网络）；
  3. mihomo 会被 Verge 看门自动重拉并成功绑定（验证 `netstat -ano | findstr 7897` 出现 LISTENING）；
  4. （本次未做成）趁 7897 空闲时永久保留给自己：`netsh int ipv4 add excludedportrange protocol=tcp startport=7897 numberofports=1`——端口被 mihomo 占着时 add 会失败，需先停核心。
- 预防（待拍板，未实施）：把动态端口范围收回默认高位段 `netsh int ipv4 set dynamic tcp start=49152 num=16384`，Hyper-V 就永远圈不到 7897；但不确定当初是谁把范围改到 1024 的（Docker/虚拟化软件常见），改前需确认无软件依赖。
- 状态：已解决（推送成功、7897 正常监听）；保留段随机漂移，**下次系统重启可能复发**，按解决方案 1–3 操作即可。

## \[已解决·自愈] 微信会话调用 ask\_user 交互工具 → 会话阻塞 15 分钟 + 同窗口微信长连接收不到消息（2026-09-11）

- 症状：凌晨微信聊天中她回完一段话后突然沉默，用户补发消息无人应答；同一轮对话微信端比 rana-web 网页端多收到一条；`openclaw channels status` 显示 weixin `running` 但 `in:` 停在最后一条成功消息时间（补发的那条根本没到网关，死信队列 `channels dead-letters list` 也是空）；网关日志每 30s 刷 `stalled session: agent:main:main state=processing reason=blocked_tool_call activeTool=ask_user lastProgress=tool:ask_user:started recovery=none`。
- 根因（两层叠加）：
  1. **ask\_user 交互工具在微信渠道无法完成**：`ask_user` 是核心工具（"openclaw" 工具族，带选项的交互提问卡），微信渠道呈现不了这个交互，工具挂起、会话占线，后续消息只能排队。约 900s（15 分钟）内置超时后才释放。微信端"多的一条"疑似即 ask\_user 的提问文本被推送到微信，而 rana-web 不渲染该工具事件（推断，未逐字比对）。
  2. **微信通道长连接同窗口假死**：用户补发的消息未产生任何 inbound 日志，约 15 分钟后自愈（恢复收信）。ilink 长连接假死或服务端未推，本地无法进一步区分。
- 排障抓手：网关日志（`%TEMP%\openclaw\openclaw-当日.log`）搜 `stalled session` 看 `activeTool=` 是谁卡的；`openclaw channels status` 看 `in:` 是否还在走；`openclaw sessions tail --agent main --session-key agent:main:main` 看轨迹时间线。卡住时 `approvals pending` 为空（不是审批阻塞）。
- 解决方案：本次 900s 超时后自愈（轨迹实证：04:45:47 提交 → 05:01:19 完成，随后两轮正常）。通用解法：重启网关立即清 stalled 会话并重建微信连接。**预防（2026-09-11 已实施）**：`openclaw.json` → `agents.entries.main` 加 `"tools": {"deny": ["ask_user"]}`（备份 `openclaw.json.bak-nouserask`），让她一律纯文字提问；rana-web 前端本就不渲染 ask\_user，禁掉无损失。网关日志已确认热重载生效。
- 状态：已解决（自愈 + ask\_user 已禁用）。微信长连接假死无根治（上游 ilink 限制），复发时重启网关即可。

## \[上游限制] cron 系统收敛任务（技能回顾/心跳）不能按 agent 单独启停（2026-09-11）

- 症状：想把 rana-rp 侧的 `skill-collection-review`（每周技能收集回顾）单独停用（本地 RP 模型上下文紧张、不挂 skill，跑了纯浪费），`openclaw cron disable <id>` 与网关 WS `cron.update` 均被拒；`cron list` 默认还看不到停用任务，早报一度以为"失踪"。
- 根因：OpenClaw 把 `skillCollectionReview` / `heartbeat` 两类 payload 定义为 **system-owned monitor jobs**，"gateway-converged and cannot be created or edited through the CLI or API"；其唯一开关是全局配置 `skills.workshop.autonomous.mode`（`auto`/`propose`/`off`，默认 auto，改 `propose`/`off` 后网关收敛时把任务置 disabled）——**没有 per-agent/per-workspace 粒度**。另外 `cron list` 默认只列 enabled，`--all` 才含停用行（早报 `morning-report` 任务完好，只是 `enabled=false`，重启用 `openclaw cron enable c4d2dc88-6cab-4592-8747-aae95136547b`）。
- 解决方案：rana-web 定时任务页（CronPage）对 system-owned 任务显示「⚙ 系统」标注并禁用开关/手动运行；全局开关待用户拍板（`propose` 模式仍保留纠正提案，`off` 全关）。附带发现：cron 存储存在大小写双 store\_key（`K:\openclaw` vs `K:\OpenClaw`）遗留，官方建议另找时间跑 `openclaw doctor --fix` 规范化，勿与功能改动混做。**2026-09-11 补**：早报已改为独立页面方案（`news-report.mjs` cron 任务每天 08:00 抓 CCTV 新闻联播文字版 + 博查四类目搜索，写本地 `.news/report.json`，前端「📰 早报」页渲染，不再经任何会话）；旧会话版任务保留 disabled 状态、显示名标注"旧·会话版"。
- 状态：上游限制，UI 已标注；全局开关待用户安排。（2026-10-01 补：doctor --fix 已跑完，store 规范化/迁移挂账清掉。）

## \[已解决] Mimosa 安全钩子一刀切拦截 cron trigger-script 文件（2026-09-11）

- 症状：写任何包含 `exec({ command: "..." })`（OpenClaw cron 无头 DSL 官方形态）的触发脚本文件，即使纯常量命令串，都被 Mimosa PreToolUse 以"命令注入·高危"拦截写入（连 argv 数组形式也不放行）。
- 根因：Mimosa 的静态规则对"exec + 命令"模式直接判高危，无法区分有无用户输入拼接；属误报但不可绕（也不应绕安全钩子）。
- 解决方案：放弃 trigger-script 方案，改用 `--session main --system-event`（纯文本走 CLI 参数，不经文件写入）让 main 会话的 Rana 自己跑统计脚本（实测 main 有 exec 权限且能产出人话汇报）。system-event 触发的回复默认可能 `NO_REPLY` 静默，事件文本里写明"必须汇报、不许 NO\_REPLY"即可。同日另注：vite.config.ts 中间件用 `execFile(file, args[])` 数组参数形式（powercfg/nvidia-smi/powershell），未触发 Mimosa。
- 状态：已解决（Git 活动日报/周报/月报三个任务均跑通）。

## \[已解决] Git 活动统计口径（自动同步提交灌水）（2026-09-11）

- **09-20 补记（形态改造）**：「让 main 会话模型跑脚本」的旧形态自 09-19 21:30 起四连 600s 超时（qwen 长工具链收尾病，与 exec 审批无关——审批记录零条），且只要模型跑命令就绕不开审批墙（agent exec 无长期许可）。已改为**直跑形态**：git-activity.mjs 新增 `--out=<绝对路径>` 落盘参数，三个任务（日报 21:30 / 周报周一 09:00 / 月报 1 号 09:00）以 `--command-argv` 直跑、报告写 `rana-web/.git-activity/report-<period>.md`（已进 .gitignore——含 WSL 私人仓库提交标题）；旧三任务已停用保留回滚。实测**978ms 完成、零审批**（CLI 创建的 command 载荷属 trusted automation，不走 exec 审批）。
- **09-20 补记②（QQ 推送链 + CLI 假阳性坑）**：报告回话走两段式——直跑落盘 + 2 分钟后 glm 中继任务（`--message` 提示词仿早晚问候配方：read 报告 → message 工具带 `channel="qqbot"` 全量推送 → 只回「已送达」）实测 32s 端到端送达（QQ API 200）。**⚠ `openclaw message send` CLI 在 2026.9.2 的真实发送路径全坏**——任何消息（哪怕 2 字）都报 `outLog.debug is not a function`，而 `--dry-run` 正常返回（假阳性！dry-run 不走发送路径）；v2026.9.5 或已修复，升级验证后可把中继换回零模型推送（git-activity-cron.mjs 的 --notify 分段推送代码已备好）。升级时注意重打 qqbot 图片补丁（见 9-14 条目）。

- 症状：直接 `git log --since` 统计"今天干了什么"会被 push-public.cmd / backup-private.cmd 的自动提交（`sync: <日期>` / `backup <日期>` 前缀）灌水，行数虚高到不可读。
- 根因：本仓库日常由两个脚本全量自动提交推送，机器提交与人工提交混在同一 main。
- 解决方案：`rana-web/git-activity.mjs` 按前缀正则（`^sync:` / `^backup\s`）把自动提交单独归栏（「实质工作」/「自动同步」两栏分开计数，代表性提交只取实质工作）；统计口径=origin/main 已推送提交（推送后本地 remote-tracking 引用即更新，无需联网 fetch）；边界写死本地时区（今日=00:00 起、周=上周一\~周日、月=自然月）。WSL 四项目走 UNC（`\\wsl.localhost\Ubuntu-22.04\...`）直读。仓库清单在 `git-activity.repos.json`（已 gitignore，含本地路径不外泄）。
- 状态：已解决（daily/weekly 手动跑通，数字与手查 git log 一致）。

## \[已解决] Windows 子进程输出中文乱码（powercfg GBK / PowerShell UTF8）（2026-09-11）

- 症状：vite 中间件 `execFile("powercfg", ["/list"])` 按 utf8 解码，中文电源计划名（"平衡"等）全成乱码；而 PowerShell 的 Get-Volume 卷标正常。
- 根因：powercfg.exe 输出跟随系统代码页（GBK/CP936），node 默认按 utf8 解码；PowerShell 侧因为脚本里显式设了 `[Console]::OutputEncoding=UTF8` 所以正常。
- 解决方案：`execFile(..., { encoding: "buffer" })` 拿原始字节，`new TextDecoder("gbk").decode(Buffer.from(stdout))`（Node 18+ 自带 full-icu 可用）。
- 状态：已解决（电脑状态页四个计划名显示正常）。

## \[已解决·待用户日常复验] 本地 RP 会话频繁压缩 + LM Studio 同模型双实例 → 显存爆（2026-09-10）

- 症状：12GB 卡上 LM Studio 同时驻留两份 `rana-rp-14b`（第二份名 `rana-rp-14b:2`）加旧 `rana-rp-7b`，显存不够用、机器卡顿；RP 主会话每条消息背后 2-3 次本地模型调用；rana-web 里自己的消息弹两遍（见下一条）。
- 根因（三环叠加，各有独立成因）：
  1. **memoryFlush 指向旧模型**：`agents.defaults.compaction.memoryFlush.model` 仍是 `lmstudio-local/rana-rp-7b`（RP 换 14b 时漏改），每次压缩把 7b 拉进显存与 14b 并存。
  2. **压缩预算被 reserve 硬地板压死**：OpenClaw 压缩预算公式实为 `budget = contextWindow − min(20000, contextWindow − min(8000, contextWindow/2))`——reserve 有 20000 token 硬编码下限（`agent-settings` 里 `DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR=2e4`），**contextWindow 提到 24576 预算仍是 8000**，必须 ≥32768 预算才会涨。RP 提示词地板（SOUL+记忆注入）≈7-7.5k，接近预算上限 → 每 1-2 条消息就 compaction（摘要 14b + flush 7b + 回答 14b = 2-3 次调用）。
  3. **LM Studio 双实例**：`:2` 由不同加载来源/参数触发（GUI 固定聊天窗直连一份 + 网关 API JIT 一份，或 JIT 默认 ctx 与所需不一致时重复加载）。两份 14B Q4 各约 9GB，12GB 必爆。**查真实驻留用** **`curl localhost:1234/api/v0/models`（`/v1/models`** **会把未加载的也列出来，会骗人）**。
- 解决方案（2026-09-10 已全部实施并验证）：
  1. `memoryFlush.model` → `lmstudio-local/rana-rp-14b`（热重载生效）。
  2. `rana-rp-14b` 的 `contextWindow` → 32768、`params.maxTokens` → 8192（防 prompt+输出顶破物理槽位）。热重载后实测诊断行 `promptBudgetBeforeReserve=12768`（旧值 8000），压缩间隔从每 1-2 条消息拉长到约 15-20 条。
  3. LM Studio 经 `POST /api/v1/models/unload` 卸掉 `rana-rp-14b:2` 与 `rana-rp-7b`；`POST /api/v1/models/load` 以 `context_length=49152, parallel=2, flash_attention=true, offload_kv_cache_to_gpu=false` 加载唯一实例——总量 49152 双槽 = 每槽 24576（**parallel 槽会平分上下文，单请求最大 ≈ 预算 12.7k + 输出 8k ≈ 20.9k < 24576 安全**）；KV 缓存放系统内存（48GB RAM 充裕），GPU 只留权重（显存占用从双实例+7b 变为稳定 \~11.6/12.3GB、利用率低）。
  4. 驻留性：显式 load 无 TTL；且共享桥（\*/30）与私密桥（7,37）每 ≤30 分钟必打一次 14b，即使有 TTL 也永不到期。
  5. 验证：03:00/03:07 两桥 receipt ok 均打单实例；20.5k token 压缩摘要 + 回答端到端跑通；模型列表全程无 `:2`、无 7b。
- 遗留注意：LM Studio GUI 里直连模型聊天仍会另起一份实例——要直连测试时用完关掉，或先 `lms status` 看一眼；cron\_jobs 表有旧 store\_key（大写 `K:\OpenClaw`）重复行四条，receipts 验证未触发，留观。
- 状态：已解决（预算提升、单实例、无 7b 三项均有日志/接口实证）；用户日常聊天场景明早自然复验。

## \[已解决·待用户日常复验] rana-web 消息气泡弹两遍（2026-09-10）

- 症状：在 RP 主会话发消息，自己的消息在界面里出现两次；只发生在本地模型长会话。
- 根因：`rana-web/src/lib/gateway.ts` 落库消息事件（`sessions.messages` 订阅）的去重只比对消息列表**最后一条**的 role+text。compaction 插在用户消息与回复之间时，服务端补发的 user 消息事件到达时列表末尾已是 assistant 回复 → 去重失效 → 重复追加。云端会话预算大不触发压缩，所以只在本地 RP 会话复现。
- 解决方案：去重改为扫最近 8 条按 role+text 匹配（`list.slice(-8).some(...)`）；`npx tsc --noEmit` 通过，vite 热更后浏览器下次打开生效。压缩频率下降后该路径本身也更少触发。
- 状态：已解决（类型检查过、逻辑对齐根因）；待用户在 RP 会话日常复验。

## \[上游限制] 微信通道主动推送依赖 contextToken（2026-09-10）

- 症状：定时任务（心跳等）向微信投递汇报时报 `sendMessage ret=-3 errmsg=invalid arguments`；同一晚更早的心跳曾成功，间歇性出现。
- 根因：微信 ilink bot API **主动发消息必须携带 contextToken**（用户最近在该会话发言产生的回复凭证）。凭证缺失或过期时 API 直接拒绝，与本地配置无关。诊断方法：`%TEMP%\openclaw\openclaw-YYYY-MM-DD.log` 搜 `sendMessageWeixin`，失败前会有 `contextToken missing ... sending without context` 警告。
- 解决方案：无根治。用户在微信发任意一条消息后凭证恢复，之后主动推送即可送达（曾验证：token 存在时 356 字汇报正常送达）。可选缓解（未实施）：网关侧检测 contextToken 缺失时降级投递到 web 会话，避免汇报彻底丢失。
- 状态：上游限制，行为已确认，按上述方式规避。

## \[已解决] 大文件卷入 git 备份 → 推送永久挂死 → 心跳连环超时（2026-09-09）

- 症状：私有备份脚本 push 挂起无输出或报 `TLS ... unexpected eof while reading`；心跳 cron 每轮报 `cron: job execution timed out`（600s 上限）。
- 根因：备份脚本 robocopy 全量镜像 + `git add -A`，把 4.2GB 模型分卷（单块 280\~560MB）卷进提交，超 GitHub 单文件 100MB / 推送体积上限，**push 永远不可能成功**。心跳清单含"备份未推送则修复"，于是每轮救火直至超时。
- 解决方案：①对未推送提交 `git reset --soft <远端HEAD>` 重写剔除大文件后重新提交；②备份仓根加 `.gitignore`（robocopy 参数含 `/XF .gitignore`，该文件不会被源目录同步覆盖）；③`git reflog expire --expire=now --all && git gc --prune=now` 回收死对象（实测 .git 4.2GB→22MB）；④推送一次成功。
- 预防：模型/数据集等大文件永远不进 git；新增大目录时同步检查备份仓 ignore 规则。
- 状态：已解决。

## \[已解决·会复发] cron 会话删除失败 "did not finish stopping"（2026-09-09，两例）

- 症状：删除 cron 产生的会话报 `UNAVAILABLE: Session agent:<x>:cron:<uuid> did not finish stopping; retry the archive`，重试永远失败。
- 根因：state 主库（`<OPENCLAW_STATE_DIR>/state/openclaw.sqlite`）的 `worker_session_placements` 残留 run 级 placement（session\_key 带 `:run:` 后缀、state=local、terminal\_reason=null），归档 drain 的 placement identity 校验永远通不过。上游 bug。
- 解决方案：停 gateway → 备份两个 sqlite → `DELETE FROM worker_session_placements WHERE session_key LIKE '%cron:<jobid>%'`（注意该表 `session_id` 列存的是 run UUID 不含 cron UUID，**必须按 session\_key 搜**；此表在 state 主库，不在 agent 库）→ 重启 gateway → 依次调 `sessions.patch {key, archived:true}` 和 `sessions.delete {key, archivedOnly:true, deleteTranscript:true}`。
- 状态：已解决；升级版本前每次删 cron 会话都可能再遇到，同法手术。

## \[行为说明] 心跳超时后 turn 仍在后台运行（2026-09-10）

- 症状：心跳 job 标记 timeout 失败后，transcript 显示 agent 仍在继续干活数分钟甚至完成汇报送达；期间手动 `cron run` 报 already-running，下一班心跳可能报 agent-tool-failure。
- 根因：cron 的 600s 执行上限只把 job 记为失败，**不终止 agent turn**。
- 解决方案：无需处理；排障时以 transcript 为准而非只看 receipt。

## \[已解决] ownership=explicit 下系统级 cron 无归属 → 全部定时任务瘫痪（2026-09-09）

- 症状：所有 cron 不动，网关日志每秒 `cron: timer tick failed: Agent-less cron job has no resolvable owner`。
- 根因：memory-core 内置系统任务（做梦等）不带 agent\_id，ownership=explicit 时解析不了 owner。
- 解决方案：配置 `agents.defaults.systemAgent.agentId=main`（热重载生效）。**cron 全部不动时先查网关日志 timer tick**。

## \[缓解] qwen3.8 思考吃满输出上限 → 空 content → 后续轮工具授权丢失（2026-09-09）

- 症状：工具调用中途报 "Tool exec/write not found"。
- 根因：thinking 耗尽 8192 输出 token → stopReason=length 且 content 为空 → 重试轮工具授权丢失。上游 bug。
- 解决方案：该模型配置 `params.enable_thinking=false`。
- 状态：已缓解，可向上游报告。

## \[已解决] Windows 网关下 cron 任务命令 spawn ENOENT（2026-09-09）

- 根因：`--command` 形式会包成 `sh -lc`，Windows 网关下无 sh 可用。
- 解决方案：一律用 `--command-argv` JSON 数组形式，路径用正斜杠。

## \[已解决] 学习计划月历列宽被课程条撑爆（2026-09-12）

- 症状：月历 7 列宽窄悬殊（最窄 25px），周末列被挤没，日期数字挤成一团。
- 根因：`grid-template-columns: repeat(7, 1fr)` 的 `1fr` 最小尺寸默认是 `auto`，格子里 `.cal-course` 设了 `white-space: nowrap`，长标题把轨道顶宽。
- 解决方案：改 `repeat(7, minmax(0, 1fr))`，超长课程条走省略号 + `title` 悬停提示。修在 `src/styles.css` 的 `.cal-grid/.cal-week`。

## \[行为说明] IAB 自动化点击在本机 DPI 下静默失准（2026-09-12 复现）

- 症状：Playwright locator `click()`、`dom_cua.click()`、`locator.press("Enter")` 都"成功返回"但页面毫无反应（不是超时就是无效）；元素明明可点（elementFromPoint 命中自身）。
- 根因：IAB 输入注入层坐标与本机显示缩放（≈1.61）不匹配，注入点落到元素之外。
- 解决方案：用 `evaluate` 读 `getBoundingClientRect()` 拿 CSS 坐标，**中心点 ×1.61 后用** **`tab.cua.click({x,y})`**；DOM 断言与文件实况双重验证点击是否真的生效。截图管线也会偶发 30s 超时，重开标签页或稍等可恢复。

## \[行为说明] cron CLI 的 --announce 不接受 main 会话 system-event 任务（2026-09-12）

- 症状：`openclaw cron add --system-event ... --announce` 报错 "--announce/--no-deliver require a non-main agentTurn, command, or script session target"。
- 根因：system-event 载荷固定进 main 会话，CLI 不允许给它配 fallback 投递。
- 解决方案：不配 --announce——main 会话的回复本来就按最近活跃频道（微信）投递，git 日报一直是这么跑的；事件文本里写"绝对不许 NO\_REPLY"即可（同既有经验）。

## \[已解决] iztro 2.x 的 API 与官方文档不一致（2026-09-12）

- 症状：`astro.getBySolarDate()` 不存在；`astrolabe.soulIndex/bodyIndex/minAge/maxAge` 均为 undefined。
- 根因：npm 最新 2.6.1 已改名——排盘入口是 `astro.astrolabeBySolarDate(ymd, 时辰序号0-12, 性别)`；命宫/身宫用 `astrolabe.earthlyBranchOfSoulPalace/earthlyBranchOfBodyPalace`（或宫位 `name==='命宫'`、`isBodyPalace` 标记）；大限在 `palace.decadal.range`。
- 解决方案：见 `src/lib/fateCore.ts` 的 `ziwei()` 封装；接入前先用 node 探针实测（本次 `Object.keys()` 逐层摸的）。

## \[行为说明] IAB 输入注入会阶段性完全失灵（2026-09-12）

- 症状：同一会话内先还能用「×1.61 缩放坐标点击」，随后所有缩放系数（1.0/1.3/1.61）的 `cua.click` 全部静默无效；`cua.drag` 从未成功过；**页内** **`dispatchEvent`** **合成 PointerEvent/ MouseEvent 连 React 的委托监听都进不去**（按钮 onClick 完全不触发）。
- 根因：宿主输入管线把非可信事件过滤/丢弃，且会随会话时长退化；与 DPR 缩放是两回事。
- 解决方案：GUI 验证优先用 DOM 断言（snapshot/evaluate 读状态）+ 接口层 curl 直测；必须点按钮时先试真实缩放点击、失败就改为接口层等价验证；纯手势类（拖拽动效）直接留给用户上手验收，别在注入层死磕。

## \[已解决] nvidia-smi 在 Windows 查不到每进程显存（2026-09-12）

- 症状：`nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory` 列出几十个进程但 used\_memory 全是 `[N/A]`。
- 根因：Windows 显卡跑在 WDDM 模式，驱动不向 nvidia-smi 提供每进程显存（TCC 模式才有）。
- 解决方案：改用系统 GPU 性能计数器 `\GPU Process Memory(*)\Local Usage`（PowerShell `Get-Counter`），实例名正则抠 `pid_(\d+)` 按进程汇总，>50MB 才展示。见 `vite.config.ts` 的 `queryGpu`。

## \[已解决·要警惕] 状态接口返回形状与前端类型对不上 → React 整页白屏（2026-09-12）

- 症状：状态页一有真数据整站白屏（无错误边界，nav 一起没），window\.onerror 抓到 `services.map is not a function`。
- 根因：中间件返回 `{services: [...]}` 包了一层，前端 `StatusPayload` 手写的类型却当数组；TS 查不出来（JSON 过了 unknown）。
- 解决方案：中间件直接返回数组；**手写 payload 类型时形状必须和 buildStatus 返回逐字段核对**；排障时先 `window.addEventListener('error')` 抓原文再谈修复。

## \[已解决] SecretRef 迁移：gateway.auth.token 迁了会断掉全部旁路客户端（2026-09-12）

- 症状：`gateway.auth.token` 改成 SecretRef 对象后，rana-web（vite 读 token）、study-agent/fate-agent 桥、e2e 脚本全部读到 `{source:"store",...}` 对象当令牌用，连网关一律 1008 断连。
- 根因：这些客户端直读 openclaw\.json 的 token 字段，**不会解析 SecretRef**；只有网关自己会解析。
- 解决方案：**gateway.auth.token 保留明文**（本机回环 WS 令牌，风险可接受），只迁模型 provider 的 apiKey；旁路端点要自己解析时读 `state/openclaw.sqlite` 的 `secret_store_entries` 表（rana-web 的 `/__rana/model-test` 已内置 node:sqlite 解析）。迁移手法：`openclaw secrets store set 名字 --kind secret --value-file 临时文件`（值不过命令行）→ 写 plan.json → `secrets apply --dry-run` 核对 → apply → `secrets reload`。
- 遗留明文（有意保留）：gateway.auth.token、channels.qqbot.clientSecret（后者不在 SecretRef 支持的目标路径里）；一堆旧 `openclaw.json.bak*` 里还有历史明文 key，删不删用户定。

## \[行为说明] rana-qq-public 装上共享记忆后的边界（2026-09-12）

- 做了什么：工作区加 MEMORY.md（所有 QQ 群共享一份长期记忆）+ `memory_search/memory_get/message/skill_workshop` alsoAllow + `memory.search.rememberAcrossConversations: true`（开跨会话回忆：A 群的对话 B 群检索得到）。
- 边界：她仍无文件读写/命令/联网能力（09-15 起解锁萌娘百科查询，见文末「群聊接入萌娘百科」条目）；共享记忆只含群聊公开内容，不含主人私人档案（将来"群里认主人"= 往 MEMORY.md 写一份过滤过的主人摘要即可，无需改配置）。
- 注意：`rememberAcrossConversations` 的显式落点是 `agents.entries.<id>.memory.search.rememberAcrossConversations`（全局 `memory.search` 也行）；不设则默认看 dmScope——binding 带 `session.dmScope` 时默认关。

## \[已解决] doctor 密钥迁移(SecretRef)后 rana-web 云端模型面板变空（2026-09-12）

- 症状：左下角「☁ 云端模型」打开是空的；`GET /__rana/provider-config` 返回 `{"error":"key.slice is not a function"}`。
- 根因：OpenClaw doctor 维护把 provider 明文 apiKey 迁进密钥库，openclaw\.json 里 `apiKey` 从字符串变成 `{source,provider,id}` 引用对象；rana-web 的 provider 中间件是明文时代写的，maskKey 直接 `.slice()` 崩了。
- 解决方案：`vite.config.ts` 的 ProviderEntry.apiKey 类型放宽为 `string | Record<string,unknown>`；maskKey 对 SecretRef 显示 `🔒密钥库(id前8位…)`；`/provider-models` 代拉遇到 SecretRef 时明确报错（网页拿不到明文，模型 id 手填）。
- 教训：**凡是读 openclaw\.json 的 apiKey 的代码，都要兼容 SecretRef 对象**——密钥本体永远不在配置文件里。

## \[已解决] 云端面板「从接口拉取」全线失败 + 保存无 name 模型弄坏配置（2026-09-12）

- 症状：云端模型面板里每个 provider 点「⟳ 从接口拉取」都报错，一个都不通。
- 根因（三个叠加）：
  1. 密钥库（SecretRef）provider：网页侧拿不到明文 key，直连必败（见上一条目）；
  2. 本地 LM Studio：中间件无条件要求 key，而本机服务根本不需要；
  3. 面板同时上送 baseUrl+providerId，中间件"有 baseUrl 就不看 providerId"，导致配置里的 key 取不到。
- 附带事故：网页保存模型条目时不填 name 就不写 name，runtime 校验 name 必填 → 整个 openclaw\.json 被判 invalid（CLI 全挂）。已手工给 qwenanliang 补 name（备份 .bak-qwenanliang-fix）。
- 解决方案（vite.config.ts）：①模型条目 name 一律兜底=id；②拉取三路分发——本机地址免 key 直连 / 明文 key 直连 / SecretRef 走 `openclaw models list --all --provider X --json` 运行时目录（**目录行的模型标识在 key 字段**（"provider/model"），不是 id；目录为空先 `models refresh`）；③providerId 与 baseUrl 合并取缺省。实测：本地 6 个、aliyun 8 个、glm 2 个、qwenanliang 明文 249 个，全通。
- 教训：SecretRef 时代网页要做 provider 级操作，借运行时 CLI 是正路（它自己解析密钥库），别想着读明文。

## \[已解决] .env 方案：密钥库时代网页直连 provider 的正路（2026-09-12）

- 需求：密钥被 doctor 迁进密钥库（只写）后，网页「从接口拉取」拿不到明文，只能走运行时目录（仅返回已配置模型）。
- 方案：`rana-web/.env`（已 gitignore）可给 provider 配明文 key，键名 = provider id 转大写下划线 + `_API_KEY`（如 `BAILIAN_API_KEY=`）。中间件**每次现读 .env**（改完即生效，不用重启 vite；别用 loadEnv——它只在启动时读一次）。解析顺序：手填 key → 配置明文 → .env → SecretRef 走运行时目录。
- 两个实现坑：①追加 .env 前确认文件以换行结尾，否则 key 会粘到上一行注释上（踩过）；②面板走 runtime 兜底时会提示去 .env 填 key 可拉全量。
- 实测：bailian 配 .env 后直连拉到 249 个全量模型；aliyun 不配 .env 走运行时返回 8 个已配置模型。

## \[已解决] 记忆桥直读 apiKey 被 SecretRef 迁移打断 + glm 思考吃满 max\_tokens（2026-09-14）

- 症状：memory-bridge 的 main 侧提炼静默产出 0 条（不报错）；偶发群聊腿也 0 条。
- 根因一：桥脚本直读 `openclaw.json` 的 `aliyun-maas.apiKey`，SecretRef 迁移后读到 `{source:"store",...}` 对象当 Bearer 用。根因二：glm-5.3-flash 是思考型模型，推理就花几百 token，`max_tokens:500` 时正文经常被挤空（finish\_reason 还是 stop，更迷惑）。
- 解决方案：`resolveApiKey()` 兼容 SecretRef（读 state SQLite 的 secret\_store\_entries 表）；云端提炼统一走 glm 且 `max_tokens:1500`；云端腿产出 0 条时把被拒原文写进 .bridge.log 排障。旁路脚本凡直读 apiKey 都要过 resolveApiKey 这关。
- ⚠️ 第三处（2026-09-14 补刀）：`news-report.mjs` 同样直读 `p.apiKey` 当字符串，早报「乐奈的总结」自密钥迁移起静默失效（`Bearer [object Object]` → 401 被 catch 吞掉，页面只见总结卡空着）。已修：新建 `lib/rana-config.mjs` 共享模块统一 resolveApiKey，早报接入；report.json 新增 `summaryError` 字段、前端显式显示失败原因——同类静默失败不再藏。实测总结出字。

## \[缓解] IAB 自动化：window\.confirm 会同步阻塞 evaluate（2026-09-14 补充）

- 症状：`evaluate()` 里触发页面删除按钮（内部调 `window.confirm`）→ evaluate 挂到 32s 超时；且同一会话里 ×1.61 坐标点击时灵时不灵（9-12 能点中页签，9-14 同样打法失效）。
- 解决方案：导航/按钮一律优先 `evaluate(() => el.click())`（最稳）；带 confirm 的操作，让 evaluate 超时后**另起一个 js 调用** `tab.getJsDialog()` 取弹窗再 accept——弹窗会一直挂着等处理，数据操作在 accept 后正常完成。

## \[已落地] 群聊幻觉对症下药：接入萌娘百科 MCP + SOUL 防幻觉条款（2026-09-15）

- 症状：09-14 晚群聊连续幻觉——Love Live 趴趴玩偶硬认成《孤独摇滚》还无中生有"灰毛兜帽"；编造不存在的组合名"RSB"；有咲说成 Roselia 键盘手（实为 Poppin'Party）+ 编"养猫/去过她家"细节；编造群友没说过的旧话。群友当场抓包多次。
- 根因：SOUL.md 只禁"编记忆"、没禁"编原作知识"，且有句"聊原作自然接、像聊自己的生活"反而鼓励不懂装懂；她手上又没有任何查询工具，不知道只剩顺嘴编一条路。
- 方案四件套（备份均 `.bak-moegirl-20260915`）：
  1. 自建零依赖 stdio MCP server：`.openclaw/.openclaw/mcp-servers/moegirl.mjs`（照 bocha-web-search.mjs 骨架），工具 `moegirl_search`（opensearch 搜条目名）+ `moegirl_summary`（extracts 拉开头摘要）；只访问 `zh.moegirl.org.cn`、30 分钟内存缓存、10 秒超时、摘要截断 1200 字防爆上下文、免 key。
  2. `openclaw.json`：`mcp.servers` 挂 `moegirl`；`rana-qq-public.tools.alsoAllow` **只**追加 `"moegirl__*"`（不开 bundle-mcp 大门，隔离边界只开一条缝）。main（私聊/网页端）默认策略本就放行 MCP，自动获得。
  3. skill：`workspace-rana-qq-public/skills/moegirl-lookup/SKILL.md`——两步查法（search 确认条目名→summary 拿摘要）、查不到到此为止不许脑补、认图只对查到的特征。
  4. SOUL.md 追加「不懂别装」一节（原作知识/转述言行/自查口令三条），并修正"你没有网可上"旧句（否则她会拒绝用新工具）；AGENTS.md 工具边界条同步改写。
- 验证：`openclaw mcp doctor moegirl --probe` ok；CLI 端到端（`openclaw agent --agent rana-qq-public --session-key moegirl-e2e-… -m "有咲在哪个乐队"`）transcript 显示她先读 SKILL → `moegirl__moegirl_search` → `moegirl__moegirl_summary` → 答对"Poppin'Party 键盘手"（09-14 原题翻案）。
- 遗留观察点：没查到的外观细节仍会小脑补（实测答"银发"，有咲实为金发）——条款压制效果待真实群聊观察；JR 线路类现实交通幻觉不在本方案射程（萌娘百科管不着）。
- 排障抓手：MCP 手测 `printf '{"jsonrpc":"2.0",…,"method":"tools/call",…}' | node moegirl.mjs`；工具全名带双前缀（`moegirl__moegirl_search`）；`minimal` profile 的 agent 配了 MCP server 也不会自动可见，**必须 alsoAllow 加** **`服务器名__*`** **或具体工具名**；改 openclaw\.json 后要重启网关（taskkill PID + start-gateway.cmd）。

## \[已落地] 角色档案二次升级：禁脑补铁律 + 本地条目档案 + 关系网策略（2026-09-15）

- 背景：首轮实测发现她答对乐队位置但仍脑补没查到的外观细节（答"银发"，有咲实为金发且摘要没写发色）；用户要求"绝对百科事实，不能脑补"+ 查完建本地档案。
- 机制（全部落在 skill/SOUL 提示词层，moegirl.mjs 和配置零改动）：
  1. **先档案后上网**：`read memory/characters/<名>.md`（外号试 1-2 变体）→ 猜不中 `memory_search` 向量兜底（工作区文件本就在记忆索引内）→ 都没有才 `moegirl_search`+`moegirl_summary` → `write` 建档。档案超一个月且群里争论细节才重查。
  2. **禁脑补铁律**：百科和档案里写到的才能说；发色/身高/声优/关系深浅摘要没写就直说「百科简介里没写」——她连"没写"本身都会记进档案（"百科摘要未记载发色…"）。
  3. **关系网不预铺**：同团/同校/同企划由两条身份行对照即得（不用存）；「关系」行只记推不出且查证过的（前队友、跨团 CP）；亲疏排名题查到什么说什么，查不到明说；聚合问题（队内谁跟谁好）直接查乐队/作品条目建档复用。BanG Dream 自企划是她自己的生活不走百科（SOUL 原有边界）。
- 三轮实测全过：①问矢泽妮可+发色陷阱→查百科+建档+答"百科没写不乱说"；②新会话外号"妮可"→memory\_search 兜底翻档案，**零网络调用**；③"妮可和真姬什么关系"→读档案+补建真姬档+CP 专页搜不到如实说+拒绝评价亲疏。
- 检索选型结论（用户问过）：直读最快最准不可能认错人 > 向量兜底（现成 memory\_search，零新代码）> 中文正则（她无文件搜索权限，为它开新工具不值，弃用）。聊天场景检索速度不是瓶颈（一轮回答 10-20s，大头在模型）。
- **索引与去重（同日三次升级）**：`memory/characters/INDEX.md`（一行一个：`名字 | 别名 | 文件名`）是档案单一入口——查档先读索引把外号对到正式文件名，从源头杜绝"外号档"；建档/更新同步写索引；group-analyst 每日增量顺手维护（明显重复合并成正式名一份、被并文件留一行指路墓碑、死行删除、别名补齐，拿不准不动）。实测：星空凛建档自动写索引（且她自发区分了"百科直陈"与"对照企划条目推出"两种事实来源）；人工造重复档妮可.md 触发合并，别名并归+墓碑+要点并集全部正确。sed 改竖线分隔的索引文件会撞分隔符，用 Edit/python 改。
- **正文 detail 工具（同日四次升级，群友反馈"只能看一段"后）**：`moegirl.mjs` 新增第三个工具 `moegirl_detail(title, section?)`——extracts 全文纯文本自带 `== 章节名 ==` 标题行，脚本按标题切片：不带 section 返回章节目录（含各章字数，省上下文），带 section 返回该章正文（含小节，3000 字封顶）；错章节名返回现有章节列表提示。SKILL/SOUL 措辞同步从"百科简介里没写"升级为"简介和正文章节都查过才算没写"。实测问妮可发色/声优：她走 detail 拿到声优（德井青空）+发型设定，发色百科正文真没写（只写发型，信息框不在 extracts 里——已知边界），照实说"没写不编"，档案更新并记下"正文未记载发色"的查证结论。
- **转写型小错仍会出**：detail 实测 10 处细节 9 处与原文一致，1 处抄错人名（贫乳组写成花阳，原文是海未）——模型从正文向档案转写时的低频笔误，属"事实在但抄歪"型，与凭空脑补不同类；已修正档案并在行内标注原文防再错。治理手段=对照原文抽查，无法靠提示词根除。

## \[行为说明] 后台拉起的网关被手动重启替掉 → 会话后台任务报"failed exit 1"（2026-09-15）

- 症状：agent 会话里后台启动的网关（`cmd //c start-gateway.cmd > .gateway.log`）运行约 1 小时后报 failed exit 1，日志尾无崩溃堆栈。
- 根因（已实锤）：不是崩溃——是**另一会话做会话清理手术**（脚本删心跳等系统会话占用的会话窗口，需停网关），按"停旧→启新"流程替掉了 agent 会话拉起的实例。辨别特征：①旧进程"无声退出"（被杀，非崩溃）；②TEMP 日志出现 `Another gateway (pid …) already owns this state directory; refusing…`（重启者在杀旧实例前先跑了一次脚本，被占用保护拦下）；③随后新实例经 cmd 父进程正常接管，QQ/微信/webchat 全重连，且启动后紧跟着 `sessions.delete` WS 调用（=清理脚本收尾）。
- 处置：无需任何动作。看到"后台网关任务 failed"先查 `netstat :18789 LISTENING` + TEMP 日志的 owns-state-dir 记录再下结论——网关活着就别重复重启。

## \[经验] Windows 工作站下测本地接口/单测的三个坑（2026-09-19）

- **Git Bash 的 curl 发中文 JSON 会按 GBK 编码**，服务端按 UTF-8 解出来是乱码且不报错（看起来像服务端 bug 其实是测试端问题）。给 `localhost` 接口发中文 body 一律用 python 的 `urllib.request`（`.encode('utf-8')` + content-type 头），别用 curl -d。
- **`npx tsx -e "..."` 在 Windows 下静默失败**（不报错、无输出，import 语句带不进去）。要跑 TS 单测就先用 Write 工具写临时 `.ts` 文件再 `npx tsx file.ts`，跑完删。
- **Bash heredoc 写源码/配置文件会被 Mimosa 拦**（Hook 层 PreToolUse 拦截"绕过 Write/Edit 安全扫描"）。同内容改用 Write 工具提交即可放行——这是设计行为不是故障。

## \[已落地] Bangumi（bgm.tv）出网必须走 Clash 代理 + 网关 skill 扫描缓存两坑（2026-09-19）

- **bgm.tv 全域直连不通**（api 和图片 CDN lain.bgm.tv 实测超时），必须走 Clash `http://127.0.0.1:7897`。两套接法：
  1. **MCP（node 进程）**：node ≥24 给子进程注入 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=http://127.0.0.1:7897`（openclaw.json 的 mcp.servers.bangumi.env 已配），内置 fetch 自动走代理；
  2. **vite 中间件**：spawn `curl -x 7897`（项目里状态页探测同款先例，`ranaBangumiMiddleware`）。
- **bgm.tv v0 API（POST /v0/search/subjects、GET /v0/subjects）间歇 502**（nginx 网关抖动，重试可能好）：搜索用旧版 `GET /search/subject/{关键词}?type=2` 稳定；v0 详情在 bangumi.mjs 里做了 5xx 自动重试一次。旧接口封面给 `http://` 链接，转发时统一升 https。
- **网关的 workspace skill 扫描是启动时全量 + 内存缓存，之后新增的 skill 目录不会动态出现**（`openclaw skills check` 一直 Total 不涨）。job-match 当时"立即可见"是撞上了缓存过期窗口。**新建/改 skill 后想立刻生效：重启网关**（taskkill + start-gateway.cmd）。判定特征：CLI 能看到老 skill、看不到新 skill、目录里文件确实在。
- **teach 技能三态案例（09-20 收尾）**：①`.agents/skills/teach` 里装技能 + 往 `skills/` 里做 junction 想让它被扫到 → 每次扫描报 symlink-escape 被跳过（但 `.agents` 路径其实被 agents-skills-project 源原生扫到，junction 是画蛇添足）；②拆 junction 拷真目录进 `skills/` 后 → 两份同名，扫描报 precedence collision（winner=workspace，功能正常但会分叉）；③定版：技能规范位=workspace `skills/`，删除 `.agents/skills/teach` 原件去重（diff 确认一致后整棵 `.agents/` 移除），collision 消失。**结论：装技能直接放 `skills/`，别用链接、别用 `.agents/skills`。**

## \[已定案·并档] 心跳会话 exec 工具卡死 → 网关进程无声退出（2026-09-19 21:48 首发案）

- 症状：后台任务方式拉起的网关（`cmd //c start-gateway.cmd` 后台跑）运行约半小时后报 failed exit 1，18789 无监听。日志无崩溃堆栈，最后记录是两条 `stalled session: sessionKey=agent:main:main:heartbeat … reason=blocked_tool_call activeTool=exec`（exec 工具调用挂了 622 秒没动）。
- 已做：重启网关恢复（Channel stable）。**死因未定**——候选：①心跳 cron 里某条 exec 命令挂起（如需出网的命令在 Clash 环境下死等）把进程拖死；②被外部终止。
- 再遇到先看：`%TEMP%\openclaw\openclaw-当日.log` 尾部是否又是 `stalled session … activeTool=exec`。**若复现 2 次以上，去翻心跳/巡检 cron 里 exec 调的命令**（health-patrol.mjs / 问候 cron），给它们加超时。
- 附带模式（非故障）：Git Bash 后台任务跑 start-gateway.cmd 时，cmd 把脚本里的 UTF-8 中文注释按 GBK 拆碎报"不是内部或外部命令"且任务退出码 1——**gateway 子进程照常起来**。判活只认 `netstat :18789 LISTENING`，别信后台任务退出码。
- **09-20 19:12 第二起网关卡死（变体：进程活、服务死）**：18:39–19:12 之间发生，表现为 CLI/网页 WS 握手全部超时（`Opening handshake has timed out`）但 18789 端口仍在听、QQ 通道 18:25 前还健康；当期无任何任务运行、日志无任何异常（连 stalled 都没有）。19:14 标准重启恢复。与前晚 21:48 无声退出案是否同族未知。**若再现 2 次，考虑做网关健康看门狗（netstat+WS 握手探测→自动重启）。**
- **09-24 第 4 起且最重：凌晨卡死 6.5 小时**——03:40 后日志死寂至 10:17 苏醒，期间 04:30 画像正班与清晨记忆桥/巡检全错过（苏醒后自动补跑成功）；回溯 09-23 周一 09:00 时段同样死寂过 → **当天 Git 周报新链路首秀被吞**（无收据无报错，下次自动在下周一）。10:49 重启恢复。另注：卡死后 CLI 查大响应（如备份收据）偶发 WS 1006 断连，DB 直读可绕过。主程序 9.3+ 修了会话重连/更新恢复，**升级 9.5（QQ 插件 2.0.4 已发布，触发条件已满足）是候选根治路**；主人 09-24 拍板：暂不动、先观察，看门狗/升级/补跑周报三项均挂起待唤。
- **09-20 定案并档**：死因链条实锤 = exec 审批无受众挂起（审批历史 09-19 21:30/21:45 两发均 no-target → 挂起 → gateway-restart/run-aborted 收场），09-20 11:19–14:41 复发六轮，已按本条目预案处置——详见同日新条目「exec 审批在隔离会话送不到人」。"给 exec 加超时"的路没走：真正缺的是审批层的快速失败，提示词层禁 exec 已够用。

## \[已落地+已验证] 群聊幻觉二轮：评价类发言射程缺口 + 正面条款补丁与对照测试（2026-09-21）

- 症状：群聊答"某声优配过哪些角色"暴露两个 09-15 方案没盖住的新翻车形态——①评价声优真人（"角色的声音跟 TA 本人挺像"；声优真人的声音她根本听不到，只有角色内的声音是人设内真实的）；②列名单时瞎排名次、顺嘴下"纯XX专业户""出道早"式断言，被群友追问才承认"瞎排的"。被追问后认账（SOUL 里"顺嘴的，收回去"执行到位），但拦在了事后。
- 根因：09-15 那套条款全部针对"事实细节"（发色/声优归属/关系/记忆旧账），**评价性、比较性、总结性发言落在射程之外**——模型把这类话当聊天氛围而非知识点，"先查再答"流程根本不触发。当日会话日志证实名单本身确实查过萌百（有 moegirl 工具调用），翻的是查完之后的自由发挥。flash 级模型学得会行为规则（先查再答），学不会"说话前自省"式元认知——SOUL 里"说之前过一遍"写得到位但 flash 不执行。
- 落地：SOUL.md「不懂别装」节追加三条**正面行为指令**（按拍板意见用"给动作"不用禁令，避免"粉色大象"效应）：声优真人手里只有名字和角色表、"像不像 TA 本人"接不了直说「我只听过角色」；列名单照百科/档案顺序念、自己挑着说排的垫「我瞎印象的」；说印象评价先垫「我印象里」「我瞎说的」。备份 `SOUL.md.bak-eval-20260921`，改后重启网关生效。
- 对照测试（dashscope 端点，7 组 = qwen3.8-flash / qwen3.8-max / deepseek-v4-pro-0813 × 新旧提示词 × 温度档，测题为当日真实问答 5 轮连问；`qwenanliang` 的 key 上 qwen3.7-plus 与 glm-5.2 免费额度 403，store key 只写不可读，故砍掉这两列）：
  - **新条款可执行性成立**：flash 与 max 在对应场景均主动引用新条款（"我瞎印象的""我只听过角色"），正面动作指令 flash 也接得住。
  - **温度 0.3 明确伤人设**：同题回复复读机化、出现攻击性发言（"你记错了""你在套我的话"），验证了"低温压幻觉同时压死人设"的预判 → **不动温度**。
  - **换大模型不治幻觉**：无工具环境下 max（旧提示词）会伪造整套 `<tool_call>`+`<tool_result>` 查询记录撑场面（编造百科摘要，比 flash 的"没听过"闪避更激进）。真实环境有真工具、该形态不会原样出现，但足以否决"换强模型=少瞎说"的直觉；无工具时 flash/max/deepseek 被追问均不翻供。
  - 方法学局限：纯 API 无工具测试造不出"查到素材后自由发挥"的翻车链路（当日真实翻车发生在工具返回之后的附和阶段），名单发挥类翻车**只能靠真实群聊观察**。
- 决定：**保持 qwen3.8-flash 不换模型、不动温度**；验证靠真实群聊观察——观察点：声优/名单类问题是否垫「我瞎印象的」、是否还评价真人。测试脚本与逐字结果存 `.openclaw/.openclaw/tmp-eval/`（gitignore 区域，含人设提示词与群聊内容，不进公开仓库）。
- 附带发现：`qwenanliang` 明文 key 的免费额度已耗尽（qwen3.7-plus / glm-5.2 均 403），`bailian` 同 key 疑似同源——旁路任务若还在用这套额度会静默失败，待巡检确认。



## [已解决] 第三方插件安装四连坑：TS-only 链式装 / load.paths 残留 / ClawSec 双错位 / ClawBridge 全网卡（2026-09-27）

装 env-guard、snippet-store（awesome-openclaw-plugins）、ClawSec、ClawBridge 时踩的全套：

1. **awesome 仓库插件只有 TS 源码**（index.ts 无 dist）：包安装模式拒收（"requires compiled runtime output"）。**用链接模式 `plugins install -l ./<name> --force --accept-capabilities`**（开发路径允许 TS 直载）；--force 过未审计警告，--accept-capabilities 过能力授权。
2. **链接安装会往 `plugins.load.paths` 追加路径且不去重**：目录改名/重链后旧路径残留 → 整个 openclaw.json 判 invalid（CLI 全挂）。修法：手改 load.paths 去重（备份 .bak-plugins）+ `config validate`。**克隆目录别用 tmp-* 名再改名，一次放到位。**
3. **ClawSec（skills CLI）两处硬编码 HOME**：`INSTALL_ROOT` 实测不生效（照样装 ~/.openclaw/skills）；advisory hook 脚本把 HOOKS_ROOT 写死 ~/.openclaw/hooks 且 spawnSync 调 `openclaw` bash shim 必 ENOENT。修法：装完手动 `mv` skill 目录到 `<state>\skills\`、hook 目录手动 cp 到 `<state>\hooks\`、再 `openclaw hooks enable <名> --agent main`（多 agent 必须 --agent）。本机正确根：K:\OpenClaw\.openclaw\.openclaw\{skills,hooks}。
4. **ClawBridge 默认 listen(PORT, '::') 绑全网卡**，唯一鉴权是 URL ?key=。本机化：index.js 改 BIND env 默认 127.0.0.1；.env 配 OPENCLAW_STATE_DIR + OPENCLAW_WORKSPACE（否则 workspace 误指仓库根）；启动脚本 .openclaw\start-clawbridge.cmd，手动跑不开机自启。

通用教训：**凡是默认写 ~/.openclaw 的第三方安装器，在本机（OPENCLAW_STATE_DIR 覆盖）都会装错地方**——装完必查文件真落在哪，错了手动搬。

## [已落地] QQ 官方 bot 群消息撤回链路 + 邮件私密送达 + 算命档案（2026-09-30）

群聊算卦三件套（撤回/邮件/档案）落地过程中的坑与解法：

1. **撤回可行性与权限**：官方接口 `DELETE /v2/groups/{group_openid}/messages/{message_id}`（hidetip 参数控制小灰条）。前提：**bot 被设为群管理员**（群主在 QQ 客户端设置，官方 bot 可以当）。文档写"超 2 分钟不可撤"，**实测发出约 6 分钟仍 200 成功**，管理员身份窗口比文档宽。
2. **message_id 拿法**：qqbot 插件不把 msgId 落盘（内存 msgid-cache 只供被动回复）。可靠来源 = 该 agent 自己的 `agents/<id>/agent/openclaw-agent.sqlite` 表 `transcript_events`，字段路径 `event_json → message.__openclaw.transport.messageId`（同层还有 senderId/senderName 可做 --sender 精准过滤）。node:sqlite（node 24）只读打开在线库无锁问题（别碰 vec0 虚拟表即可）。
3. **官方 token 接口是 JSON 驼峰 body**：`POST https://bots.qq.com/app/getAppAccessToken` 用 `{"appId":...,"clientSecret":...}`；用 form 格式（grant_type/appid/secret）会报 `100007 appid invalid`，别被误导去查配置。
4. **agent 跑命令的安全收口**：exec 白名单模式（`tools.exec.mode=allowlist`）+ 每个脚本配 `.cmd` 启动器，allowlist 只放 `**/workspace-rana-qq-public/skills/*/*.cmd` 一条——node 本身不放行，公开群聊场景防诱导。深色细节：`openclaw approvals allowlist add --agent <id> "<glob>"`。
5. **cmd 传参 `\n` 坑**：SKILL.md 教 agent"换行写 \n"，但命令行传参 `\n` 是字面两字符，邮件正文全是 `\n`。修法在脚本侧兜底：`body.replace(/\n/g,'\n')`——agent 侧永远教不会，脚本必须自己转。
6. **官方 bot 未发布时的私聊限制**：除管理员 QQ 外无人能加 bot 好友 → C2C 私聊对普通群友不可用（40054004 无好友关系）；群里拿到的 member openid 与 c2c openid 不是一套体系。私密送达唯一现实通道 = 邮件（群友主动留邮箱）。卡片消息全员可见，无按人可见性，别试图用卡片做私密返回。

## [已落地] /helps 秒回帮助文档：qqbot 插件 dist 补丁 + 回滚法（2026-09-30）

**需求**：群里 `/helps` 直接回算命帮助文档，不过模型。

**终局方案（当前生效）**：qqbot 插件 dist 本地补丁——`npm/projects/tencent-connect-openclaw-qqbot-a7ec020d86/node_modules/@tencent-connect/openclaw-qqbot/dist/index.cjs` 的 `buildCommandList` 加 `suanHelpEcho()` 命令（name=`helps`，AI 队列前拦截）。**文案文件（改这里，热生效免重启）：`K:\OpenClaw\.openclaw\.openclaw\extensions-local\suan-help-echo\help.md`**。dist 备份：同目录 `index.cjs.bak-helps-20260930`。**插件升级会覆盖补丁，`/helps` 失效即重打**（插入函数+push 一行，见备份 diff）。

**回滚法（改走模型，免维护补丁）**：① 备份拷回 dist/index.cjs；② 面板第三项 PUT 改回 `/suan help`（POST/PUT /v2/panels，panel_id `p_Ywe8pHe8u40JDxBLqfpLGB`）；③ 重启网关。回滚后**文案源头换人：`workspace-rana-qq-public/skills/suan-help/SKILL.md`**（模型照它复述，改完即时生效但每次回复过模型 3~5 秒）。

**弯路存档（别再走）**：
- 网关不加载 `plugins.load.paths` 链接插件（启动日志 17 插件清单可验证；env-guard/snippet-store 同样不在内），`openclaw plugins install -l` 只有 CLI 进程能加载；
- `/help` 是宿主内置命令，AI 队列前就被吃，自定义钩子抢不到——用 `/helps` 避开；
- internal hooks 的 `message:received` 只能观察不能拦截直回。

**2026-09-30 补**：同款第二个命令 `/指北`（能力边界与 FAQ，文档 `extensions-local\suan-help-echo\zhinan.md`，同样热改生效）；面板 v5 四入口（命盘/摇卦/helps/指北）。升级插件两个补丁一起重打。

**2026-09-30 再补（防刷屏终版）**：helps/指北合并为腾讯文档（https://docs.qq.com/doc/DWk92bWVwTGNEb2p0，唯一权威版，改文档只改在线版）；面板 v6 收三项（命盘/摇卦/📖使用说明-link项直达文档，PanelItem type=link 可放 https 链接）；dist 两个命令（/helps、/指北）handler 都改读 short.md（三五行速览+文档链接）。本地 help.md/zhinan.md/merged-guide.md 均为历史稿。
## [已解决·有绕行] QQ 私聊长回复只收到最后一段——qqbot 分块流式（partial）中间块不落终稿（2026-10-03）

- 症状：轩瑜在 QQ 私聊里没看到我 11:01 那轮的过程直播和中间段落，只收到最后一段成稿；同一轮在网页端完整显示。
- 取证：当日网关日志 11:01–11:08 一串严格 ~50s 间隔的 `[qqbot:api] <<< Status: 200 OK`，无 errcode、无限流报错——出站 API 全部成功，不是网络丢包/频控丢包。插件源码 `npm/projects/tencent-connect-openclaw-qqbot-*`/dist/index.cjs：`defaults = { streaming: { mode: "partial" } }`——qqbot 通道未写 streaming 配置即默认分块流式；`src/outbound/streaming-controller.ts` 逻辑：流激活时中间块走 `stream_messages`（`streamOwnsText` 分支跳过静态发送，`deliveredTexts` 还会去重吞同文），只有 finalize 的终稿落成一条可见消息。QQ 客户端对 stream_messages 中途更新渲染不稳 → 中间过程段用户侧不可见，只看到终稿。
- 解决方案（不动上游，二选一/可并用）：① 在 QQ 私聊发 `/bot-streaming off`（通道内置命令，直接改该账号 streaming.mode=off，即时生效、免重启）→ 每段回复独立成一条完整消息，过程直播可见；② 约定：关键长结果由 agent 用 message 工具显式单条发送（核对 deliveryStatus=sent），自动回复只做收尾。
- 排障抓手：QQ「没收到/只收到一半」先查当日日志 `[qqbot:api]`——全 200 但用户看不到 = 分块流式只落终稿，不是丢包；有 errcode/频控码才是被 QQ 拒了。
- 状态：已定案（10-03 14:55 轩瑜拍板「就这样」：保持 partial 流式不改配置，关键结果由 agent 用 message 显式单发兑现送达；当次已补齐确认）。
## [已解决·会复发] 备份 push 代理半死连败10次自动禁用；心跳班内补推超时把裸报错投到了 QQ（2026-10-03）

- 症状：17:32「Daily Private Backup」连续 10 次失败被自动禁用（系统播报）；17:42 用户 QQ 收到心跳会话的原文报错「Request timed out before a response was generated... increase agents.defaults.timeoutSeconds」。
- 链路：备份 robocopy 与 dbs 快照（I:\rana.backup）一直成功，**死的只有 GitHub push**。运行日志分层：9/30 = connect refused via 127.0.0.1（Clash 7897 端口在听但拒连）、10/1-10/3 = TLS unexpected eof——同 9-11「Clash 半死」老形态。连败到 10 触发自动禁用护栏，系统唤醒 heartbeat 处置；heartbeat 在巡查班内 inline 干长活（重试 push ×4、对照连通测试、写补推循环），最后一个模型调用拖过 timeoutMs=600000 被 abort，错误原文经 reply 投递到 QQ。
- 善后（本次闭环）：①复核远端=本地 HEAD（05699d4，积压提交全部落 GitHub，ls-remote 实证）；②`automations enable f8b51148` 重新启用、连败清零，次日 17:30 正常排班；③删心跳遗留临时文件（workspace/_catchup_push.cmd、_tmp_job_meta.js、_tmp_cron_check.js、_tmp_diag_full.js）。
- 待决策（未闭环）：①heartbeat 定位=巡查，长恢复不该班内 inline（600s 超时是必然）——二选一：给该路径单独放宽 timeout，或规则化「连败只记录、留给主会话处置」；②裸报错原文不该直达 QQ（违反收尾汇报纪律），心跳提示词应加「超时/报错禁止原文外投递，用大白话+补救说明」。
- 排障抓手：备份失败看 `K:\openclaw-backup-run.log` 分层（robocopy 段 / db backup 段 / push 段）；仓库对齐核对 `git -C K:\openclaw-backup rev-list origin/main..HEAD --count`。
- 状态：已解决（当次同步完成、任务 ON；根因代理抖动会复发，连败自动禁用属预期护栏，禁用后系统播报是正常行为）。

## [已解决] /restart 在 Windows 无计划任务时只做进程内重启；连带破案：网关空转烧核=9.7 模型目录捕获死循环（2026-10-04）
- 症状/实测：00:23 主人网页端发 /restart，日志实锤收到 SIGUSR2、admission closed、通道重启 READY；但 restart mode 行明写 `in-process restart (win32: detached respawn unsupported without Scheduled Task markers)`——`openclaw gateway status` 同报 `Service: Scheduled Task (missing)`。重启后 PID 仍是原进程（10/03 03:41 起），空闲单核 100% 空转与 RSS 2.2G 原样保留。**进程内重启不能解决进程级退化（空转/内存堆积）**。
- 正解（要真换进程二选一）：①主人终端一行：`taskkill /PID <pid> /F; Start-Process "K:\OpenClaw\rana-web\start-gateway.cmd"`（会顺带拉起 embedding-watchdog 与 sse-fix-proxy，均有端口锁）；②长期：跑 `openclaw gateway install` 装成计划任务后 /restart 才是完整重启（属系统改动，需主人拍板）。
- 附带结论：agent 自身红线不变（禁 exec/后台杀宿主网关）；验收类一次性 cron 跑完自删正常（gateway-restart-verify 实证 DELETED）。
- owner 白名单多通道格式实证：`commands.ownerAllowFrom` 每条按 `<channel>:<id>` 前缀过滤到对应 provider（core command-auth 源码 resolveOwnerAllowFromList），qqbot 的 id 用用户 openid 原样（大小写照 allowFrom 里现值）；加 `qqbot:<openid>` 后热重载 applied，无需重启网关。
- **01:12-01:25 硬重启验收（主人 taskkill 成功）**：新进程 PID 97720（旧 84860 已死）、`[qqbot] gateway READY`、8 插件加载齐、数据库完整性校验过、RSS 30 秒采样稳定 1544→1557MB 无泄漏增长——**但空闲空转依旧**：新进程 01:17:50 就有 active=0 的 reasons=cpu 降级，线程级采样单线程（tid 97428，网关进程自身）烧满一核（6s 窗口 6000ms）。结论：**空转与进程寿命无关，重启不治愈**——不是「累着了」，是启动即存在的忙循环。待晨间：`node --cpu-prof` 或 Windows 侧 profile 定位热循环；同步处理启动迁移债（本轮 openclaw 工具报 `prepared model runtime plugin generation was superseded`，按 9-28 既有台账根治=doctor --fix+重启；夜间网关持状态库，doctor 进不了 maintenance，只能白天做）。
- **02:15-02:37 迁移债手术 + 空转复核（ZCode 会话，主人授权立即执行）**：①迁移债真身实锤——doctor 报 `EXDEV: cross-device link not permitted, rename C:\Users\Administrator\.openclaw\agent\bin → K:\...agents\main\agent\bin`；C 盘残留**不是 9-17 隔离的 .openclaw.old 复活**（那个仍在原处），是 **10-01 13:38 升级 9.7 时安装器踩出的空临时目录**（`agent\bin\install_tmp_…\extract`，递归零文件）——跨盘 rename 在 Windows 必败，每次启动都还不掉这笔债。②手术四步：C 盘 `agent` 改名隔离为 `agent.quarantine-20261004`（可逆，非删除）→ taskkill 97720 → 停机窗口跑 `doctor --fix --non-interactive`（带 STATE_DIR）→ 重启（新 PID 104684@02:21:46；QQ READY 5.5min、微信 running、8 插件、启动横幅干净：EXDEV/state-migration/superseded 全零）。③**空转未愈（重要结论：迁移债≠空转根因）**——READY 静置后双 6s 采样 0.995/1.01 核照烧；病理画像（本晚实证）：单线程满核 + eventLoopUtilization≈1%（CLI channels status 亦报 ELU 0.9%/cpuCoreRatio 0.966）→ **热点在 native 层不在 JS 事件循环**（且不产日志，每分钟仅 1-28 行），`node --cpu-prof` 大概率抓不到，下一步须 ETW/WPR 类 native 栈工具定位。④顺带：C 盘 `.openclaw` 仍余 media/qqbot/skills 三个旧目录（9-17/9-27 遗物，doctor 报"multiple state directories"信息级提醒），去留待主人拍板；09:30 一次性提醒 cron `spin-forensics-remind` 因手术提前完成已删除（`automations delete 3fc9c9db…` ok）。
- **02:39-03:05 现场取证续（ZCode）**：①排除 memory-core——10-03 全天 0 次 watch 报错但空转全天烧（11:00-24:00 每小时约 20 条 cpu 降级警告）；watch 报错（"database is not open"×17）只在 00:23 in-process restart 后出现，真重启自愈。②**翻案：烧核者非主线程**——线程普查（OpenThread+NtQueryInformationThread 查线程名/出生地址，脚本 `%TEMP%\spin-threadquery.ps1`）：MainThread state=Wait 安睡；烧核者=**worker_threads 工人线程**（name=WorkerThread, start=node.exe+0x2253564），两轮 10s 采样 98%/98% 连烧；且烧核 tid 会迁移（106680→106944，旧线程已亡）——烧核绑定"工人"角色而非特定线程。③工人名册（`worker startup state` 日志行）：新进程 6 工人=sqlite-store×1 / state-lease-heartbeat×1 / state-read×2 / session-transcript×2（compute 池 active=0）；老进程发病期另有 **prepared-model-catalog.worker.js**（堆 200-375MB 大块头，即 superseded 报错的子系统）。④租约心跳父侧模块全定时器睡眠、清白；openclaw 自带 worker-cpu 记账（worker.cpuUsage()）但**无 CLI/日志表面输出分账**（仅内存压力告警带 workerHeaps，健康进程不触发）。⑤wpr 内核采样被系统策略拦（0xc5583000，需重启系统解锁，未做）；cdb 未装。⑥**时间线吻合 9.7 回归**：CHANGELOG 9.7 亮点明言「transcript writes/projections/history preparation 等大量搬离主线程进 worker」——空转恰自 10-01 升 9.7 后出现，定性为 9.7 新增 worker 路径回归。⑦**npm 已发 2026.9.8**（status 提示 update available）。
- **04:00-04:50 完整破案+修复（ZCode 连夜执行，主人授权「修到完全修好」）**：①**指认凶手**——worker-cpu 记账模块加探针补丁（两版迭代；教训：`worker.cpuUsage()` 单位是**微秒**，v1 的单位启发式差点漏掉真凶）→ `prepared-model-catalog.worker.js`（模型目录准备工）连续 29.3~29.8s CPU/30s=98% 烧满一核，跨 4 次重启复现。②**活体取证**——工人文件临时自开 inspector（补丁已移除）+ CDP `Debugger.pause` 三次抓栈：热点全在 `plugin-generation-artifact` 捕获链（copyPackage/materialize/linkDependency ↔ hashPluginSourceFile/assertSourceCurrent/verifyPluginSourceInputs），纯同步文件系统苦役。③**物理证据**——`state/tmp/plugin-captures/` 捕获区 GB 级（当日 ~1GB + 10-01 遗留 599MB），60 秒内 ±99MB 打摆子（边拷边删），老进程曾连续 13h+ 烧核不收敛。④排除项：memory-core（10-03 全天零报错但空转全天烧）、租约心跳（父侧代码全定时器睡眠）、LM Studio（1234 健在 /v1/models 正常）、9.8 升级（CHANGELOG 判读=纯可靠性小修不对症）。⑤弯路记录：verify 的 `fs.realpathSync(source) !== source` 严格相等在 Windows 必败（正斜杠/大小写差异）——机制属实但非本循环触发点（放行日志零命中，补丁已回滚，保持最小补丁面）。⑥**终修**——`agents/prepared-model-catalog.worker.js` 的 `runCatalogRequest` 头部加 fail-fast（10s 延迟后返回 `status:"failed"`）。正当性：本机上该任务从来没成功过（一直以 180s 超时方式失败、无任何用户可见功能受损），秒败与超时失败对上层等价，唯一差别是不再白烧一核。功能验收：`openclaw models list` 走发布列表兜底全量可用（首行提示 "could not refresh all providers" 为预期代价）。⑦**效果**：重启后空闲 CPU 0.018~0.055 核（修复前恒定 1.01）、liveness 零新增、探针零烧核记录、QQ connected / 微信 running、启动横幅全绿（EXDEV/superseded/迁移债保持零）。⑧**补丁台账**：新增 2 个 dist 补丁——`worker-cpu-BnVPAXBa.mjs` 探针（**长期保留**：工人 CPU 看门狗，烧核>5s/30s 或问询失联 5s 即记 `%TEMP%\openclaw\worker-cpu-probe.log`）+ `prepared-model-catalog.worker.js` fail-fast（对症修复）；重打脚本 `state tmp/apply-20261004-catalog-patches.cjs`（幂等已验证），**升级 openclaw 后须重跑**（连同既有全套四补丁）。备份：`.bak-cpuprobe-20261004` / `.bak-inspect-20261004` / `.bak-verifyfix-20261004`。⑨清理：10-01 遗留 599MB + 当日捕获区已删（~1.7GB 释放）；残留一具骨架目录含被锁 `owner.sqlite`（进程持有，下次重启后手删）。⑩上游 issue 候选（证据链齐未发）：**Windows 上模型目录捕获永不收敛**——GB 级同步拷贝+逐文件哈希、无进度日志、180s 超时即弃即重试=烧核死循环；9.7 把目录发现搬进 worker 后引入。
- 状态：**已解决**（烧核根治：目录工人秒败补丁；迁移债前半夜已清。主人 10-04 晨间三路对话实测通过，私有仓 913023b / 公开仓 c8b82ce 均已推送；上游 issue 证据链备齐未发）。
