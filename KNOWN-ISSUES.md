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

## \[已解决] 微信通道静默死亡——网关进程丢 OPENCLAW\_STATE\_DIR，微信插件回落主目录找不到账号（2026-09-14）

- 症状：微信发消息无回复（RP 侧），但网页端聊天正常、QQ 正常。`openclaw channels status` 的列表里**微信整个消失**（只剩 QQ），`status --json` 显示 `openclaw-weixin: {configured:false}` 且 `channelAccounts` 为空数组；网关日志里微信插件除 `[compat] OK` 外零输出（无 `starting weixin provider`、无报错）。微信插件的真实活动停在出事那次网关重启（同步游标文件 `openclaw-weixin/accounts/*sync.json` 的 mtime）。
- 根因：微信插件的凭据不在 openclaw\.json（那里只有 `channelConfigUpdatedAt` 一个字段，属常态），而在 **state 目录** `openclaw-weixin/accounts/` 下。插件找 state 目录的顺序是 `OPENCLAW_STATE_DIR` → `CLAWDBOT_STATE_DIR` → `~/主目录/.openclaw`，**不认** **`OPENCLAW_HOME`**；而网关核心只认 `OPENCLAW_HOME`（用户级变量，指向 `K:\OpenClaw\.openclaw`）。网关进程的 `OPENCLAW_STATE_DIR` 丢失（启动脚本 `start-gateway.cmd` 里明明 `set` 了，但进程环境块里没有——openclaw 启动器/agent-exec 有多处「保存-恢复该变量」的代码，存在弄丢路径；用 psutil 读进程环境实证缺失），插件于是回落到 `C:\Users\Administrator\.openclaw` 找账号 → 空列表 → 通道从不启动且不报任何错。QQ 无恙是因为其凭据直接写在 openclaw\.json。诊断时的迷惑点：CLI 侧 `channels list` 说「configured」（CLI 进程里有变量），网关侧说没配置——同一文件两个进程结论相反即此病。
- 解决方案（2026-09-14 落地）：①`setx OPENCLAW_STATE_DIR K:\OpenClaw\.openclaw\.openclaw` 写成**用户级永久环境变量**（与 OPENCLAW\_HOME 同址，以后任何方式启动网关都带）；②按标准流程重启网关（taskkill + start-gateway.cmd，启动时再在父进程显式注入一次双保险）。验证：`channels status` 出现 `openclaw-weixin ... running, in:1m ago`，日志出现 inbound + `outbound: text sent OK`，微信实测收发全通。
- 排障抓手：①`channels status --json` 看 `channelAccounts.<通道>` 是否为空数组（空=插件没找到账号）；②对比 `channels list`（CLI 本地视角）与 `channels status`（网关视角）对同一通道的结论；③`python -c "import psutil; print(psutil.Process(<网关PID>).environ().get('OPENCLAW_STATE_DIR'))"` 直接验尸进程环境；④微信插件代码在 `.openclaw/.openclaw/npm/projects/tencent-weixin-openclaw-weixin-*/`，其 `src/storage/state-dir.js` 即目录解析逻辑。
- 状态：已解决（setx 永久变量 + 重启后全链路实测通）。

## \[已解决·部分上游限制] "Automation" 会话删不掉——run 会话 gateway 不认 + 父会话被 placement 残留卡死（2026-09-14）

- 症状：会话列表里一批 cron 产生的会话（前端显示 Automation 开头）删不掉；点 ✕ 或 CLI `sessions delete` 报错。两类症状：①`agent:main:cron:<jobId>:run:<runId>` 的 **run 级会话** → `Session not found`（gateway 的 delete 接口不认 run 级 key，哪怕 `sessions list` 能列出来）；②`agent:main:cron:<jobId>` 的**父会话** → `could not safely stop ... cloud worker placement identity changed`（state 主库 `worker_session_placements` 里 13 行 run 级残留 `terminal_reason=NULL`，"删除前安全停止"校验永远不过）。`sessions cleanup` 只是常规维护，不清这些。
- 根因：cron 每次执行产生 run 会话；run 的 placement 在任务结束后不清（残留），父/子删除路径都被它卡死或排除。多数涉事 job id 已不在现役 cron 表（死任务遗骸）。
- 解决方案（09-09 手术法的 2026 复用+扩展）：①停网关 → 备份 `state/openclaw.sqlite` 与 `agents/main/agent/openclaw-agent.sqlite` → `DELETE FROM worker_session_placements WHERE session_key LIKE '%:cron:%'`（**只删 cron 类，main/群聊等活跃 placement 别动**）→ 重启网关；②父会话 `openclaw sessions delete <key> --agent main --yes` 逐个删（会级联归档；删除确认必须 --yes，且**全局 key 必须带 --agent**，否则误报 Session not found）；③**run 级会话 delete 依旧 not found（gateway 不认，上游限制）**——placement 已清、不再占用，列表残留交给前端「系统会话」隐藏开关（Sidebar 默认隐藏 `:cron:`）。残留小写 store\_key 行（09-14 已登记）留给 doctor --fix。
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

- 症状：网关日志每 60s 刷 `[qqbot:<appId已移除>] Connection failed: ... {"code":100016,"message":"invalid appid or secret"}`，attempt 一直涨；QQ 私聊/群聊全部离线。
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
- 状态：上游限制，UI 已标注；全局开关与 doctor --fix 待用户安排。

## \[已解决] Mimosa 安全钩子一刀切拦截 cron trigger-script 文件（2026-09-11）

- 症状：写任何包含 `exec({ command: "..." })`（OpenClaw cron 无头 DSL 官方形态）的触发脚本文件，即使纯常量命令串，都被 Mimosa PreToolUse 以"命令注入·高危"拦截写入（连 argv 数组形式也不放行）。
- 根因：Mimosa 的静态规则对"exec + 命令"模式直接判高危，无法区分有无用户输入拼接；属误报但不可绕（也不应绕安全钩子）。
- 解决方案：放弃 trigger-script 方案，改用 `--session main --system-event`（纯文本走 CLI 参数，不经文件写入）让 main 会话的 Rana 自己跑统计脚本（实测 main 有 exec 权限且能产出人话汇报）。system-event 触发的回复默认可能 `NO_REPLY` 静默，事件文本里写明"必须汇报、不许 NO\_REPLY"即可。同日另注：vite.config.ts 中间件用 `execFile(file, args[])` 数组参数形式（powercfg/nvidia-smi/powershell），未触发 Mimosa。
- 状态：已解决（Git 活动日报/周报/月报三个任务均跑通）。

## \[已解决] Git 活动统计口径（自动同步提交灌水）（2026-09-11）

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

