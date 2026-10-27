# CHANGELOG

本仓库变更记录。倒序排列；只记对外可见行为与运维相关改动，不记内部草稿。
运行时 `.openclaw/` 状态、密钥、会话不在此列（已 gitignore）。

## 2026-10-27

### 修复：模型选择与「云端模型」档案的 provider 不一致

- 顶栏 ⚡ 模型选择器此前只把**裸模型名**发给 `sessions.patch`，服务端会落到 agent 默认 provider；
  同名模型跨 provider（`glm-5.3` ×4、`qwen3.8-flash` ×2 等）时会切到错误的接口地址。
  实测：发 `qwenanliang/qwen3.8-flash` → `modelProvider=qwenanliang`；只发 `qwen3.8-flash` → `modelProvider=glm`。
- 修复内容：
  - `src/lib/types.ts` 新增 `modelRef()` / `isSameModel()` 纯函数；选择、激活高亮、连通测试统一用 `provider/id`。
  - `src/components/Topbar.tsx` 选择器按 provider 分组去重 key，激活状态同时比较 provider。
  - `src/lib/gateway.ts` 的 `setModel` 回填 `modelProvider`；`SessionRow` 透传网关新增的 `modelProvider` 字段。
  - `src/components/PlanningLibrary.tsx` 选模型改为 `provider/id`，并把 `life.model.v1` 里的旧裸名自动迁移。
  - `src/components/StudyPage.tsx` 排课/出题模型由主会话 `modelProvider + model` 拼回完整引用。
- 数据订正：`aliyun-maas` / `bailian` / `qwenanliang` 的 `glm-5.3` 显示名由 `GLM 5.2` 等旧值统一为 `GLM-5.3`；
  网关热重载后已核实目录返回新名字（未重启网关）。
- 测试：新增 `tests/unit/model-ref.test.ts`（8 条）；`tsc -b` 通过，`npm test` 117/117 通过。
- 存档：改动前备份为 `*.bak-1027-2112`；运行时配置备份 `openclaw.json.bak-1027-modelname`。

### 排查记录

- 详细根因、证据与回滚点已登记在 [KNOWN-ISSUES.md](KNOWN-ISSUES.md) 同日条目。

## 历史变更（2026-09-08 → 2026-10-26）

> 来源：git 提交历史（全部 102 笔，含自动备份/同步快照）；只作索引，根因与处置详见 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)。

### 2026-10-26
- `1363794` feat(migration): 批5 同步桥上线收尾——开机自动拉脚本(启动文件夹装载,无管理员依赖)+真实拉取走通(504.3MB 自云端)
- `b57a0ec` feat(tools): rp-soul-test 人格一致性压力测试工具
- `bf3f49d` fix(webui): 云端页面 origin not allowed——前端按页面来源选网关 + 云端 allowedOrigins 补齐
- `0cdcc2d` docs(migration): 切换收官——台账回写切换夜三坑(混血路径/指纹死锁/bots.qq.com 漏白);方案勾选批2✅批3✅(02:34 QQ wss READY+微信 monitor started,云端正式接班);批4 留主人晨验
- `adac6f1` fix(migration): 白屏修复收口——平台变量改走 VITE_ 标准 env 前缀(define dev 不生效之替代;避免 RANA_ 服务端前缀变量被打进浏览器)+vite/client 类型引用
- `ec51026` fix(migration): 白屏真凶——vite define 在 dev 不替换 __RANA_HOST_PLATFORM__(裸标识符进浏览器 ReferenceError);改 envPrefix+RANA_HOST_PLATFORM env 通道,家里不设=win32 默认
- `437fcf2` fix(migration): 批3 门禁 Origin 语义修正——Origin 是服务器地址不是客户端 IP,新增 RANA_TRUSTED_ORIGINS(不修则远程访问写接口全 403)
- `a794e2a` docs(migration): 批1 收官——台账回写(两处雷+实测bug 记档)+方案勾选批0批1+文档对齐22组中间件(补 cloud-sync 行)
- `b983531` fix(migration): 批1-5 实测补刀——cloud-sync.mjs 弃 using 声明(openSync 返回数字 fd 不支持)+home-probe.ps1 补 UTF-8 BOM(PS5.1 无 BOM 按 GBK 错切中文致语法错)
- `20778d4` fix(migration): 批1-5 补刀——cloud-sync.ts 删未使用的 SYNC_DIR(上笔提交带进了编译告警,本笔修至 build 全绿)
- `a612c4a` feat(migration): 批1-5 云→家同步桥——云端打包下载+家里拉取+记忆页同步卡
- `2b99070` fix(migration): 批1-4 跨平台杂项——小写路径bug+TEMP+边车脚本路径env化

### 2026-10-25
- `af435f2` feat(migration): 批1-3 门禁收窄+堵 token 洞+内容库黑名单+记忆同步云端化
- `930f3e5` feat(migration): 批1-2 状态页双形态+本机探针——云端看服务器+🏠家里,本地保留全套操作
- `a5a0184` feat(migration): 批1-1 DSH/acpx 派活体系整体移除 + 迁移方案文档

### 2026-10-24
- `8fdd603` docs: 台账回写10-24真名脱敏手术——公开仓filter-repo重写强推(10-02起hash换代,旧hash仅作时间线索)+技术坑7条(fast-import Windows重复对象截断bug/already_ran静默增量/od八进制转十六进制手抄坑/MSYS robocopy路径转写/中文commit乱…
- `d32b872` docs: 面向AI文档体系+全仓真名脱敏——新增PROJECT-MAP(代码地图/22中间件/边车班表/任务路由/红线/时间线);AGENTS.md改写为AI入场入口(铁律+速查+文档索引);KNOWN-ISSUES顶部索引(未闭环单列/症状关键词/维护纪律);README对齐(skills/CI/109用例/tra…

### 2026-10-20
- `04d27ee` feat(skills): 新增 daily-report 收日报技能公开副本

### 2026-10-17
- `5b84140` docs: KNOWN-ISSUES销账private-memory-bridge null事件修复(23:17班验证null崩溃消除,水位待RP模型加载后自愈)
- `74744c3` docs: 台账销账——批次D断线重连已合入(6919594),四批次A/B/C/D全部收官;CI首跑绿核销(run#1逐步时间戳证实非空转);private-memory-bridge L71 null事件防护修复落地(主人22:50拍板;gitignore私有生产脚本,冷备份+node --check+单行diff…
- `6919594` feat(rana-web): 批次D——断线重连加固:删MAX_RECONNECT=6放弃分支,scheduleReconnect改无限指数退避(1s→30s封顶,reconnectBackoffMs纯函数叶模块+4用例),新增reconnectNow()手动重连并重置退避,App.tsx 12处断线横幅统一conn…
- `60681db` docs: 台账同步批次C已合入(855b26f)——ci.yml规格与独立复审结果登记,CI首跑验收点=主人核Actions页;批次B生产验收memory-bridge班销账(private-memory-bridge慢性故障另见KNOWN-ISSUES待拍板)
- `37b3efe` docs: KNOWN-ISSUES登记private-memory-bridge两腿慢性静默失败——event_json=合法null炸.type(10-03给memory-bridge补的同款防护没同步到姊妹脚本),cron回执层ok无感、水位只在成功时推进→坏行永久卡重试窗口班班必炸不自愈;10-17批次B生产验…
- `855b26f` ci: 批次C——GitHub Actions工作流(.github/workflows/ci.yml):push+PR触发,ubuntu-latest/node22,defaults.working-directory=rana-web,npm ci→build→test;Rana独立复审:PyYAML解析1job/…
- `912413f` docs: 台账登记批次B已合入(7319944)——parseEntries工厂注入+git-activity三块抽取,39用例,两轮独立审计全过(首轮5FAIL分诊=4脚本误报+1CRLF化妆);生产回执验收点memory-bridge 10:00班/git-activity 21:30班已挂一次性任务
- `7319944` test(rana-web): 批次B——git-activity/memory-bridge纯函数抽取+39用例;periodRange/isAutoCommit/AUTO_PREFIXES与parseEntries函数体逐字搬移(字节级比对过),工厂注入OWNER_NAME/OWNER_ALIAS/LOCAL_FI…
- `cdb160c` docs: 台账登记fateCore闰月双'闰'bug[已解决](黄金值纪律揪出+教训入库:交叉对照期望值禁止镜像实现);状态基线标注批次A已合入(a5da1c1)、B/C/D待做
- `a5da1c1` test(rana-web): 批次A——vitest骨架+reasoning/fateCore首批66用例;顺修fateCore闰月双'闰'显示bug(getMonthInChinese自带闰前缀,L119/120/143三处删冗余拼接;黄金值=人工万年历锚点x3+原始库交叉对照x9+经典卦表独立推导;Rana独立复…
- `de5922b` docs: 新增 trae 施工任务书——vitest测试骨架(4纯函数目标含黄金值纪律)+两mjs纯函数抽取+GitHub Actions CI+断线重连加固(指数退避不放弃+重连按钮);含全局铁律(禁git写/禁碰.openclaw/禁杀进程/最小diff)与逐批交接审计流程
- `9a20fa6` docs: 新增 PROJECT-STATE-2026-10-17 真实状态快照(逐项实查cron库/源码/git核验,含挂账分层+红线+三家AI对账翻车实录+实查配方);PROJECT-ANALYSIS(09-14)加过期横幅指向新文档
- `3d3caae` docs: 三家AI对账后的状态修正——群画像cron条目改[已解决·换模型](两阶段403病因+bailian禁用始末+10-17切glm终修)、eventloop显示bug遗留改标已修(10-02锚点);README十处数字对齐(22组中间件/12页签/群画像钉glm)

### 2026-10-16
- `0ea70c2` feat(rana-web): 🔍过程页轨迹回放——trajectory 导出端点+TracePage+会话右键入口，附 ws-tap 直播事件面探针与可观测性查证文档

### 2026-10-14
- `ad454d0` KNOWN-ISSUES: 10-14 超重轮次静默事故登记（零丢包实锤+分诊路径）

### 2026-10-11
- `61b2130` refactor(rana-web): vite.config.ts 拆分为 server/ 目录(约5000→40行) + 三 agent 桥合并 + SecretRef 解析归一

### 2026-10-07
- `dcea811` docs: 10-07 台账登记两新案(qwenanliang免费额度403群画像cron连败待拍板/qwen3.8-flash输出审查误伤主会话观察项)+README对齐10-04~10-07(9.7双件套入排障清单附重打提醒/中间件20→21组补bridge-sync行/记忆桥RP腿云端优先隐私口径/晚报安全摘要/…
- `538a399` feat(rana-web): 记忆桥RP提炼云端优先(中转站SSE手拼delta,失败回落本地且只用已加载模型绝不JIT拉起)+晚报安全版摘要(RP行软化脱敏写evening-digest.md供云端晚报读,绕private-memory-gate路径闸);同步按钮步骤中文化/结果判定(全✓才算成功,部分完成给警示)…

### 2026-10-06
- `a35f153` feat(rana-web): 新增记忆同步按钮与按需拉起本地模型的一键桥接同步

### 2026-10-04
- `08d228d` docs(known-issues): 10-04 新建会话秒拒案定案收口——真凶=9.7 Win32 \?\路径前缀泄漏,创建路径Set.has字符串比对永假(agentId/sessionKey全对);重启即愈系误诊(新网关3分钟复发);修=__pubNorm规整比对落3个dist文件(带.bak备份),重打脚本a…
- `1f423e5` docs(known-issues): 10-04 条目状态收口——主人三路实测通过,私有/公开仓均已推送,条目头改[已解决]
- `63490bd` fix(known-issues): 10-04 网关空转终修——真凶=prepared-model-catalog工人(9.7模型目录捕获win32永不收敛,GB级拷删打摆子,CDP抓栈+捕获区物理证据实锤)；终修=runCatalogRequest秒败补丁(本机该任务从未成功过,超时失败与秒败等价)；空闲1.01核…
- `5285750` docs(known-issues): 10-04 迁移债手术+空转取证——EXDEV真身(C盘10-01安装垃圾)已隔离+doctor --fix清债重启；空转定性=9.7 worker线程死循环(主线程翻案,烧核tid会迁移),候选=prepared-model-catalog/session-transcript…

### 2026-10-03
- `b51be1e` docs(known-issues): 登记 10-03 QQ 超时罐头话案——心跳班越权施工救备份磨满 600s，真凶 push TLS 挂三天+.eva-parts 超限返工；三 cron auto-disable 全复活
- `bde26ff` fix(rana-web): memory-bridge 兼容 model 对象形态(modelStr 规整)+坏事件跳过防炸腿；KNOWN-ISSUES 登记该案并收尾 QQ 流式定案
- `c736374` sync: 2026/10/03 周六 12:23:49.87
- `6622e6e` docs(readme): 项目状态全面对齐——RP上云（nalang经本地SSE代理，14B退役备选）、main/公共号换deepseek-v4.1、11页签（记忆页）、二十组中间件、班表补早报/晚报/备份自检/月度觅食、SSE修复代理与备份自检入册
- `820700f` chore: 上传前清理与隐私脱敏

### 2026-10-02
- `2790eb9` sync: 2026/10/02 周五 13:01:15.66
- `5aef044` sync: 2026/10/02 周五 12:50:49.53

### 2026-09-30
- `ae81a51` docs(known-issues): 记录 /helps 秒回帮助文档的 dist 补丁方案与回滚法
- `d34dbc9` feat(ziwei): 大限/流年盘显示运限十二宫名重排角标

### 2026-09-26
- `e7ce238` feat(web): 新增记忆浏览页及后端端点，支持记忆文件查看与编辑
- `a9c296c` fix(gateway): 新增 SSE 修复代理，解决中转站缺结束标记致 RP 无回复

### 2026-09-24
- `67f158e` docs: 修正思考流问题为上游限制并补充实测证据链

### 2026-09-21
- `8eb4fc4` fix(rana-web): 弹窗脏改动拦截与模型名归位，排课模型改随主会话
- `1998312` feat(rana-web): 新增审批页——挂起卡批准/拒绝+历史+长期许可+页签角标；台账回写今晚定时任务修复（备份悬空junction/画像周报超时/睡前小结与心跳改message直发）

### 2026-09-20
- `321d9cb` feat(rana-web): 新增 git-activity-cron 直跑任务并支持报告落盘与 QQ 分段推送
- `8613633` docs(issues): Mimosa 闸门条目回填深度审计结论——263项中首方62项均为同族误报、依赖零告警、未发现真实漏洞
- `91f7ef2` docs(issues): 登记私有备份推送静默失败根因——主库超GitHub 100MB硬限制，已剥离+忽略+落地

### 2026-09-19
- `0fa5bea` docs: 开源任务书阶段二收官勾选；台账登记 Mimosa 闸门时拦时放问题（待拍板）
- `4cc07cc` wip(rana-web): 番剧搜索命中总数提示（并行工作包进行中快照，历史重写前存档）
- `beb9991` fix(privacy): 台账脱敏——清除主人真名与 QQ appId，登记回写先脱敏的教训
- `de99744` feat: 开箱即用发行版——setup.cmd 一键初始化与可移植启动脚本
- `7dfb928` feat(rana-web): 09-19 工作包半成品存档——全局日历(events中间件+CalendarPage)与番剧追番(bangumi中间件+BangumiWatch)
- `b282729` feat(rana-web): 支持消息附件上传与展示，新增上下文体检面板
- `0511864` fix(rana-web): 巡检双栈回环探测并只报持续降级，嵌入看门狗降 ctx 至 2048

### 2026-09-17
- `80e270b` feat(maint): 系统维护第一批——QQ僵尸修复、心跳拆分(巡检+问候)、cron清僵尸、备份链路修复、前端取数重试
- `ed34eeb` feat(study): 开始今天的课——lesson-start 中间件与 --ephemeral/--tail 会话参数

### 2026-09-16
- `03123b2` 开源计划书，readme更新

### 2026-09-15
- `534023f` feat(web): 新增系统会话一键清理功能
- `44e7f09` docs: 记录QQ群图片降级问题本地补丁并更新qwen3.8-flash条目

### 2026-09-14
- `3bded05` feat(web): 新增学习待办页、DSH 模型下拉与消息字号设置
- `5d8255b` feat: 优化路线落地第一批+第二批——页签单一来源、早报SecretRef复活、identity外置、ErrorBoundary、心跳轻量化、主会话瘦身、私密桥复活
- `6e5896b` feat(rana-web): 派活页雏形接入导航；学习资料路径 fail-closed 校验；WSL 切回补 DISM

### 2026-09-13
- `c623ff6` feat(rana-web): 群组页雏形与 vite 中间件扩展（DSH 委派开发前快照）
- `9638b69` feat: 命理页升级与记忆桥多 agent 化

### 2026-09-12
- `4ae5a76` chore(backup): 2026-09-12 自动备份（心跳补跑 17:30 触发点）
- `89fd9ef` feat: 模型连通测试、技能/MCP 卡与 embedding 看门狗
- `f42483a` feat(rana-web): 新增「问卜」玄学应用套件并完善学习页
- `6da99ab` feat(study): 学习计划 v2——多计划、错题本、期末考与复习闭环
- `cb1b197` feat(rana-web): 新增学习计划页：月历排课、出题测验与到点提醒

### 2026-09-11
- `3d448bd` feat(web): 电脑状态页新增虚拟化模式切换卡
- `d87dc5a` chore: 清理一次性脚本与临时产物——UI验收脚本、TLS调试配置、probe/tmp/旧日志/事故备份快照（未跟踪部分已直接删除）
- `3cdfcf0` feat(web): 本地模型超参数调节 + 快捷命令（右侧面板）
- `ac83479` sync: 2026/09/11 周五 14:05:08.57
- `ba63037` docs(issues): 登记 embedding 双实例根因与治理（同模型不同 ctx 即双实例，显式常驻单份复用）
- `5567b49` refactor(web): 删电脑状态页用量卡与会话页悬浮用量按钮
- `dee9bb9` docs(issues): 登记 Clash 7897 被 Hyper-V 动态端口保留段圈占致推送挂死的根因与修复命令
- `31f185d` docs(issues): 登记 09-11 微信 ask_user 卡会话 15 分钟 + 长连接假死排障结论，ask_user 已对 main 禁用
- `ad61dad` feat(web): UI 打磨——用量面板归位、早报卡片化、系统字体、总结卡重设计
- `22e4dde` feat(web): 早报页按需生成 + 右侧乐奈总结小窗
- `4e285cc` feat(web): 早报独立页 + 定时任务分组
- `ba8e34c` feat(web): v2「她的房间」界面 + Git 活动统计定时任务

### 2026-09-10
- `276629e` chore: gitignore 加固——.zcode 会话数据、私密记忆桥、lmctl 与 node_modules 不入公开仓库
- `1e64c71` 1
- `f6397cf` docs: 新增 KNOWN-ISSUES 工程问题台账与 AGENTS.md code agent 须知

### 2026-09-09
- `1660399` sync: 周三 2026/09/09 22:08:00.23
- `302e4fc` feat(web): 新增思考过程折叠展示、Rana·RP 会话入口与云端模型配置
- `e7f9cc9` backup 2026/09/09 周三 9:09:21.67

### 2026-09-08
- `4f720c4` Optimize session create/delete and add context-menu rename/pin
- `cd31d94` Ignore local utility scripts
- `13f3cb3` Ignore private backup sync script
- `2d7b3b8` Initial commit: Rana Web UI for OpenClaw gateway
