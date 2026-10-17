# Rana · OpenClaw 项目真实状态快照（2026-10-17 实查核验版）

> **用途**：交给下一位施工者（AI 或人）的**权威现状基线**。
> **可信度**：本文所有数字/状态均于 2026-10-17 00:00–01:00 对 **cron 库（state/openclaw.sqlite）、源码、git、文件系统逐项实查核验**，非转抄旧文档。
> **铁律**：本项目的 `PROJECT-ANALYSIS.md`（2026-09-14）、部分 `KNOWN-ISSUES.md` 条目、`README.md` 数字**都可能滞后**——对齐状态以本文为准，或按**附录 B 的方法自己实查**。今晚三家 AI 就是因为照抄旧台账集体翻车（见**附录 A**，这是本文存在的理由）。
>
> 分析对象：`K:\OpenClaw` 公开镜像 + `.openclaw/` 运行时状态（本文含运行时真相，公开仓不含）。

---

## 0. 一分钟速览

- **功能层面已很丰满**：12 个页签、22 组本地 Vite 中间件、过程轨迹回放（TracePage）、审批页、记忆页都有了。短板不在"缺功能"。
- **最大工程欠账**：零测试、零 lint、零 CI（开源路线阶段一，拖了一个月未动）。
- **最大可靠性风险**：agent 记忆库（main 已 **120.5MB**）**无任何异地副本**——盘坏即失忆。
- **今晚刚修完**：群画像两班 cron 切 glm、skill-scout 投递修复、README/台账数字对齐（均**未闭环**，等班次跑绿才算数）。
- **别碰的资产**：gateway.ts 乐观更新/去重、记忆桥隐私分层、KNOWN-ISSUES 台账制度。

---

## 1. 已完成（别再推荐这些当"改进空间"）

| 项 | 证据 |
|---|---|
| `vite.config.ts` 拆分 | 现 **35 行**装配，中间件移入 `server/plugins/`（**22 个 .ts**） |
| 三 agent 桥合并 + SecretRef 解析归一 | commit 3300f59（10-11） |
| ErrorBoundary | `src/components/ErrorBoundary.tsx` 已建 |
| 过程轨迹回放 | commit 4f1e988（10-16），`server/plugins/trajectory.ts` + TracePage |
| health-patrol eventloop "56 年"显示 bug | **已于 2026-10-02 修复**（代码内 `[2026-10-02 fix]` 锚点：degradedSinceMs 超 24h 判坏数据） |
| acpx `permissionMode=approve-all` | **10-01 已拍板维持**（KNOWN-ISSUES L174，除非弃用 DSH 不再重议） |
| 10-14 超重轮次静默事故 | **台账已标"已解决"**（分诊路径沉淀成复用规矩） |
| 开源阶段〇、阶段二（克隆即跑） | 已完成（见 OPEN-SOURCE-ROADMAP.md） |

---

## 2. 真实挂账（未闭环，按优先级）

### Tier 0 — 今晚刚改，等结果验证（不要重复改）
- **群画像两班切 glm**：每日增量（`b566bd64`）、周报（`ebecc6f3`）model 已从 403 死掉的 bailian/qwenanliang 切到 `glm/glm-5.3-flash`（对照组=主人画像两班同模型长期全绿）。每日增量已 `cron enable` 重新启用（此前连败 10 次被自动禁用、静默死 4 天）。**验证点：每日班 10-17 04:30、周报班 10-18 21:00 跑绿才算销案。**
- **skill-scout 月度班投递修复**（`ee4afe7e`）：payload 增补"投递纪律"段（回报落主会话、禁止 message 外推已失效的 QQ c2c）。**验证点：11/1 班。**
- **备份线**：Daily Private Backup + backup-check-run 于 10-14/15 连错两天（exit 1），**10-16 已自愈 ok**。再观察 1–2 班确认非侥幸。

### Tier 1 — 工程可信度（开源路线阶段一，**最该补**）
- **零测试 / 零 lint / 零 CI**：`package.json` 仅 `dev/build/preview`，无 vitest、无 eslint、无 `.github/`。
  - ✅ **进度（10-17 凌晨，trae 施工 + Rana 审计）**：批次 A 已合入（commit `e3334fa`）——vitest 骨架 + `reasoning.ts`/`fateCore.ts` 共 66 用例全绿，顺带修掉 fateCore 闰月双「闰」显示 bug（见 KNOWN-ISSUES 10-17 条目）。批次 B 已合入（commit `791ba5f`，10-17 上午）——`git-activity-lib.mjs`（periodRange/isAutoCommit/AUTO_PREFIXES 逐字搬移）+ `memory-bridge-parse.mjs`（parseEntries 工厂注入，函数体 L228-248 字节级比对命中），新增 39 用例、共 105/105 绿；净改动 +2/-22 与 +1/-23，调用点 L335/367/384 字节未动，TDZ 实查清（OWNER_NAME/ALIAS L61-62、LOCAL_FILTERS L52 均在 L228 const 之前）。生产回执验收：memory-bridge 10:04 班已销 ✅（回执 ok + `.bridge.log` 有真实业务输出，验收班顺带揪出 private-memory-bridge 慢性静默失败，见 KNOWN-ISSUES 10-17 条目）；git-activity 日报 21:30 + QQ 推送 21:32 班已销 ✅（21:52 一次性任务按附录B只读查 sqlite 回执：两班 status=ok、error 空、consecutiveErrors=0，批次B生产验收全部通过、彻底销案）。批次 C 已合入（commit `921c646`，10-17 晚）——`.github/workflows/ci.yml`（push+PR 触发 / ubuntu-latest / node 22 / working-directory=rana-web / npm ci→build→test），Rana 独立复审全绿（PyYAML 解析 1 job 5 steps、npm ci --dry-run exit=0、test 105/105 + build 复跑）。CI 首跑已绿（run #1 success，Rana 拉 job 逐步时间戳证实非空转：npm ci 4s / build 11s / test 1s；Actions 无需手动启用）。批次 D 已合入（commit `8865c13`，10-17 深夜）——断线重连加固：删 MAX_RECONNECT=6 放弃分支、无限指数退避（`reconnectBackoffMs` 纯函数叶模块 1s→30s 封顶 + 4 用例）、`reconnectNow()` 手动重连重置计数、App.tsx 12 处横幅统一 `connBanner`+「重新连接」按钮、styles.css 尾部按钮样式带注记；Rana 独立审计（三文件 diff 全量过目、禁触区 grep 零命中、MAX_RECONNECT 全仓零残留、wsUrl 回 18789、setConn 语义核验、test 109/109 + build 复跑全绿），trae 无头 Chrome CDP 三阶段实证（退避时间戳逐毫秒吻合、第 6 次仍重试、按钮重置计数、HMR 恢复零刷新）。**四批次 A/B/C/D 全部合入，任务书 `TASK-TRAE-2026-10-17.md` 施工收官**。
- **vitest 首批 4 个纯函数目标**（路径已核实，边界 case 密集、改动爆炸半径最大）：
  - `src/lib/reasoning.ts`（脏输出清洗：伪思维链/封套剥离/回声检测）
  - `src/lib/fateCore.ts`（历法/干支/64 卦——**有"卦表系统性颠倒"前科**）
  - `memory-bridge.mjs` 的 `parseEntries()`（**L227**）✅ 批次 B 完成（工厂注入 → `memory-bridge-parse.mjs`，22 用例）
  - `git-activity.mjs`（统计口径）✅ 批次 B 完成（→ `git-activity-lib.mjs`，17 用例）
- **CI**：`.github/workflows`（至少 build + test）。✅ 批次 C 完成（`921c646`）：`ci.yml` npm ci→build→test；GitHub 首跑 run #1 success（逐步时间戳核过非空转）。
- **上游 issue ×2**：证据链已备（cron 会话 delete、worker placements 残留），一直未报。

### Tier 1 — 可靠性（防丢记忆 / 防失联）
- **agent 库异地备份缺失**：main `openclaw-agent.sqlite` **120.5MB**、rp 25.6MB、qq-public 21.6MB。`backup-private.cmd` 的 robocopy 明确 `/XF *.sqlite*`（**2026-10-02 起因 GitHub 100MB 硬限剔除**）→ **记忆库零异地副本**。修法：sqlite 压缩转储（zstd，压完通常剩一两成）后入库。
- **断线重连** ✅ 批次 D 完成（`8865c13`，10-17）：无限指数退避不放弃（1s→30s 封顶）+ 断线横幅「重新连接」按钮（reconnectNow 重置计数），CDP 三阶段实证。旧状：`src/lib/gateway.ts` **L15 `MAX_RECONNECT = 6`**（约 45s）后彻底放弃、需手动刷新页面，无"重新连接"按钮。网关重启是本项目日常运维动作，这个上限从 9 月未动。

### Tier 2 — 体验完善（按需选）
- **记忆桥观测面板**：三腿记忆桥（系统心脏）健康可视化——10-03 曾连挂 10 次被自动禁用、静默大半天。现有同步按钮 + observability.md + TracePage，但缺三腿运行/失败面板。
- **DSH 派活闭环**：`DshPage.tsx`（**150 行**）仍是 v0 薄表单，发出去即黑箱，无任务列表/状态/回执/重试。动手前先探 acpx 任务状态可查性，避免空写 UI。
- **本地数据备份/恢复**：`.study`/`.fate`/`.life`/`.avatars` + localStorage 无统一导出（9-17 `.life` 消失事故已证明风险真实）。
- **会话搜索与导出**：服务端有全文 SQLite，检索缺失会越来越痛。
- **长会话性能**：`loadHistory` 不分页，长会话一次拉全量。

### Tier 2 — 维护性（重构后新长出的债务）
- **dist 补丁管理**：openclaw dist 上打着多组本机补丁（env-clone-fix / scope-closed-fallback / pmgate / creation-pub / qqbot 三补丁…），升级需重打、漏一个出怪病，重打脚本散在 `state tmp/`。建议收拢成单一 `apply-all-patches` + 升级前置检查清单（检测锚点是否还在）。
- **巨型文件**（拆分 vite.config 后单体搬了家，**别再往里塞新功能**）：
  - `server/plugins/study.ts` **1068 行**（排课+出题+判分+lesson-start 全在一个插件）
  - `src/components/StudyPage.tsx` **1122 行**（前端最大组件）
  - `server/plugins/life.ts` **845 行**
  - `src/styles.css` **2489 行 / 105KB**（单体样式表还在长）

### Tier 3 — 长期
- **英文门面**（开源阶段三）：README.en.md + 截图 + 发布渠道，阶段二完成近一个月，传播窗口闲置。
- **框架化**（阶段四）：persona.json 外置、核心抽 npm 包——按既定门槛，等阶段一~三全绿再拍板。
- **zod schema 契约**：前后端共享类型，根治"接口形状对不上→白屏"（ErrorBoundary 只兜症状）。

---

## 3. 硬约束 / 红线（施工前必读）

- **exec 审批闸门**：隔离会话（cron/isolated）**禁止 exec**——审批卡送不出去就是干等 15 分钟后整班被强杀。主会话可 exec（审批能到主人）。`git`（任意参数）与 `shutdown` 已预批准，免审批。
- **隐私分层**：`MEMORY.md` 只在主会话加载；`[RP]` 条目与 `heart-context` 是最高机密，**永不进群聊/公开仓**。公开镜像走 `push-public.cmd`（`git add -A` 全量）→ **任何入库文件默认公开**，密钥/状态目录（`.openclaw/`）/记忆文件/probe 脚本必须 gitignore 点名封禁。
- **改配置/定时任务**：补丁式，只传要动的字段，改前看现状、改完**回读 sqlite/配置核验**（详见 `openclaw-cron-cli` 技能）。长文本走 UTF-8 临时文件，别信命令行引号（控制台回显是乱码，不可信）。
- **模型端点**：一律走已配置的 `aliyun-maas/*`（阿里云百炼）；api.openai.com / GitHub 直连不可达（GitHub 下载走代理 `127.0.0.1:7897`）。
- **别动的资产**：`gateway.ts` 乐观更新与去重、记忆桥隐私分层、KNOWN-ISSUES 台账制度——踩坑换来的，重构风险 > 收益。

---

## 附录 A：今晚三家 AI 对账翻车实录（本文存在的理由）

2026-10-16，主人把项目丢给三家 AI 做改进分析（workbuddy/kimi-k3、zcode/glm-5.3、trae/qwen-3.8-max）。三家的**工程现状判断全对**（零测试/MAX_RECONNECT=6/README 数字漂移/记忆库无异地备份），但**挂账状态判断集体翻车**，因为都在照抄旧文档而非实查：

| 三家说 | 实查真相 |
|---|---|
| 群画像 cron "qwenanliang 额度烧穿、退避空转、待拍板" | 每日增量早被换成 bailian 但**照样 403（鉴权失败）、连败 10 次已被自动禁用、静默死 4 天**；周报还挂 qwenanliang。台账停在 10-07 旧病因。 |
| 10-14 超重轮次事故"已登记待分诊" | 台账明写**"已解决"**（读的是 commit 标题不是正文） |
| health-patrol 56 年 bug"待修" | **10-02 已修**，代码有 fix 锚点 |
| acpx approve-all"待拍板" | **10-01 已拍板维持** |

**教训固化**：文档会骗人，台账条目解决后若不当场改状态，下一个读它的人（包括外部 AI 和我自己）都会拿旧病因当现状。**对齐项目状态必须实查权威源（cron 库 / 代码 / git），文档只做线索。**

---

## 附录 B：如何自己实查状态（权威配方）

**读 cron 任务真相**（唯一权威，别信 `automations` 工具——它只列调用方自己的 job）：
```js
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('K:/OpenClaw/.openclaw/.openclaw/state/openclaw.sqlite',{readOnly:true});
for(const r of db.prepare('select job_id,name,enabled,job_json,state_json from cron_jobs').all()){
  const j=JSON.parse(r.job_json), s=JSON.parse(r.state_json||'{}');
  console.log(r.name, r.job_id.slice(0,8), 'enabled='+r.enabled,
    'model='+(j.payload?.model??'-'), 'status='+(s.lastRunStatus||'-'),
    'errs='+(s.consecutiveErrors??'-'), 'next='+(s.nextRunAtMs?new Date(Number(s.nextRunAtMs)).toISOString():'-'));
}
// 最近运行回执：
db.prepare("select job_id,status,started_at_ms,substr(coalesce(error_text,''),1,160) e from cron_run_receipts order by started_at_ms desc limit 20").all();
```

**核对代码硬指标**：
- 中间件组数：`(Get-ChildItem 'K:\OpenClaw\rana-web\server\plugins' -Filter *.ts).Count` → **22**
- 页签数：`src/lib/types.ts` 的 `NAV_TABS` → **12**
- 文件行数：`(Get-Content <path>).Count`
- CI/测试：查 `.github/`、`package.json` scripts、有无 `vitest`

**改完 cron 必做**：`openclaw cron edit/enable` 后，用上面的读法**回读 job_json 核验**（新值在、旧值消失、schedule/delivery 原样）。控制台回显乱码不可信。

---

_本文由 Rana 于 2026-10-17 01:0x 实查后落盘。发现本文与真相不符时，以真相为准并回来改本文——别让它变成下一份骗人的旧文档。_
