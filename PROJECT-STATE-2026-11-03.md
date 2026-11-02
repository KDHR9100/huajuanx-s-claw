# Rana · OpenClaw 项目真实状态快照（2026-11-03 实查核验版）

> **用途**：交给下一位施工者（AI 或人）的**权威现状基线**。
> **可信度**：本文数字/状态于 2026-11-03 凌晨实查核验（cron 库只读、openclaw.json、NAV_TABS、技能目录、中间件文件数、vitest 实跑、git），非转抄旧文档。旧版 [PROJECT-STATE-2026-10-17.md](PROJECT-STATE-2026-10-17.md) 已归档，留作时间线参考。
> **铁律**：本项目的 KNOWN-ISSUES.md、README.md 数字都可能滞后——对齐状态以本文为准，或按**附录 B 的方法自己实查**。文档会骗人，实查配方见附录 B。
>
> 分析对象：`K:\OpenClaw` 公开镜像 + `.openclaw/.openclaw/` 运行时状态（本文含运行时真相，公开仓不含）。

---

## 0. 一分钟速览

- **体量**：12 个页签（11-02 起 🐧QQ 陪伴）· 24 组中间件 · vitest 138 用例 8 文件全绿 · GitHub Actions CI（push/PR）。
- **11-01 ~ 11-02 大施工**：canon 工程收官（43E+4G+5N 证据版清单）、人物图谱 v1+v2、网关冷启动 310s→45s、记忆桥机制收拢、main/QQ 公众号转正 glm-5.3-flash（deepseek/token-plan 全线退役）、qq-sidecar QQ 个人号陪伴链路上线、备份仓 push 积压案定案（SSH 443）。
- **当前误差班 6 项**（11-03 实查 cron 库，待分诊）：Daily Private Backup、Git 月报·QQ 推送、主人画像周报、skill-scout 月度觅食、群画像每日增量（已停用）、skill-collection-review×2（系统任务连坐）。
- **最大可靠性风险不变**：agent 库（main 约 120MB+）**无异地副本**，仅 backup-dbs.cmd 每日拷到本地另一块盘兜底。
- **别碰的资产**：`gateway.ts` 乐观更新与去重、记忆桥隐私分层、KNOWN-ISSUES 台账制度。

---

## 1. 已完成（别再推荐这些当"改进空间"）

| 项 | 证据 |
|---|---|
| 测试 + CI 从零到一（10-17 四批次收官） | vitest 138 用例全绿；`.github/workflows/ci.yml` push/PR build+test |
| 可观测性（🔍过程页） | `trajectory.ts` + TracePage，导出瘦身 2137KB→212KB |
| 群算卦全家桶 + fate MCP | rana-qq-public 9 技能；`mcp-servers/fate.mjs` 八工具 |
| Rana 原作 canon 锚工程（10-31~11-03） | canon-rag 插件（1068 块）、43E+4G+5N 证据版清单、SOUL 删无实据句 |
| 人物图谱 v1+v2（11-01） | 记忆页🕸页签、graph.md 三表即数据源、连线表+节点卡片+原文编辑（ADR-0001+GLOSSARY） |
| 网关启动提速（11-01） | 砍 github+acpx 插件，冷启动 310s→45s（timeline 埋点待冷启数据点后删） |
| 记忆桥机制收拢（11-01） | 两腿共用 `lib/memory-bridge-core.mjs`（13 用例），根治「修一边漏一边」 |
| 模型转正（11-01） | main/QQ 公众号 glm-5.3-flash（备份 bak-mainmodel/bak-qqmodel-glm-*） |
| qq-sidecar（11-02） | SnowLuma 个人号→自研边车→rana-qq-public CLI 单轮 46s/轮；🐧QQ 陪伴页；单轮端到端实测通 |
| 备份仓 push 积压案（11-02） | migration-sync 摘除+SSH 443 定案，积压清零（台账 11-02 条目） |
| 腾讯云迁移回滚（10-28） | 云端只留 gjzx 网站，服务器别再动 |

---

## 2. 真实挂账（未闭环，按优先级）

### Tier 0 — 等结果验证 / 待分诊（11-03 实查，不要重复改）
- **cron 误差班 6 项**：上表（速览）。分诊线索：群画像每日增量是 10-17 曾自愈又停的老病号；skill-collection-review×2 是 doctor 案的老连坐（内核升级后重打补丁时一并看）；主人画像周报 10-17 起长期状态待看；**Daily Private Backup error 但 backup-check-run 判 ok，双口径矛盾待看**。
- **RP 通道 403 membership_required**：中转站给 rp-nsfw 钥匙上了 VIP1 门槛，三模型全 403；RP 通道 10-23 19:01 后零流量。**待主人拍板**（升级 VIP1 / 换平台 / 歇），没拍板前不动。

### Tier 1 — 可靠性
- **agent 库无异地副本**：main 约 120MB+，GitHub 100MB 硬限导致 sqlite 退出 git 备份（10-02 起）；backup-dbs.cmd 每日本地另一盘快照是唯一兜底。修法候选：sqlite 压缩转储（zstd）后入库或对象存储。
- **cron 误差班随班次恶化风险**：6 项误差班如果长期不修，会连坐自动禁用（连败 10 次自动停），群画像每日增量就是前车之鉴。

### Tier 2 — 体验/维护性
- **dist 补丁清单收拢**：openclaw dist 上多组本机补丁（env-clone-fix/scope-closed-fallback/pmgate/creation-pub/qqbot 三补丁…），升级需重打、散在 `state tmp/apply-*.cjs`；建议收拢单一 apply-all-patches + 升级前置检查。
- **巨型文件**（拆分后别再往里塞新功能）：`server/plugins/study.ts` 1068 行、`StudyPage.tsx` 1122 行、`styles.css` 2489 行/105KB。
- **记忆桥观测面板**：三腿桥健康可视化缺位（10-03 曾连挂 10 次静默大半天）。
- **会话搜索与导出 / 长会话分页**：沿用 10-17 判断（未复验）。
- **qq-sidecar 改进空间**（均已在台账留档，非缺陷）：CLI 单轮 46s 无流式是设计取舍；SnowLuma 换号后旧 `onebot_<QQ>.json` 401 坑；`.cmd` 必须 ASCII+CRLF。

### Tier 3 — 长期
- **英文门面**（开源阶段三）、**框架化**（阶段四）、**zod schema 契约**（根治接口形状对不上→白屏）。

---

## 3. 硬约束 / 红线（施工前必读）

- **exec 审批闸门**：隔离会话（cron/isolated）**禁 exec**；exec 白名单只放 git.exe，解释器（node/python）永不放行。
- **隐私分层**：`[RP]` 条目与 heart-context 是最高机密，永不进群聊/公开仓；公开镜像 `git add -A` 全量——**任何入库文件默认公开**；probe 脚本（`probe*.mjs`）、qq-sidecar 的 config.json/state/、私密记忆桥必须 gitignore 点名封禁。
- **.cmd 文件必须 ASCII-only + CRLF**（GBK 控制台逐字节解析，UTF-8 中文+LF 会被拆碎；写完 `nonAscii=0` 校验）。
- **改配置/定时任务**：补丁式只传要动的字段，改完**回读 sqlite/配置核验**；长文本走 UTF-8 临时文件，别信命令行引号。
- **模型端点**：main/QQ 公众号=glm-5.3-flash；RP=rp-nsfw 中转（经本地 sse-fix-proxy :18801）；GitHub 下载走代理 `127.0.0.1:7897`，**推送走 SSH 443**（HTTPS+代理上传死锁实锤，见台账 11-02）。
- **别动的资产**：`gateway.ts` 乐观更新与去重、记忆桥隐私分层、KNOWN-ISSUES 台账制度。

---

## 附录 A：历次对账翻车记录

- **2026-10-16 三家 AI 案**（本文制度的起源）：三家 AI 照抄旧文档集体翻车，实查才知真相——完整记录见 [PROJECT-STATE-2026-10-17.md](PROJECT-STATE-2026-10-17.md) 附录 A（归档版）。
- **教训固化**：文档会骗人，台账条目解决后若不当场改状态，下一个读它的人都会拿旧病因当现状。**对齐项目状态必须实查权威源（cron 库/代码/git），文档只做线索。**

## 附录 B：如何自己实查状态（11-03 实用配方）

**读 cron 任务真相**（唯一权威，别信 `automations` 工具）：
```js
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('K:/OpenClaw/.openclaw/.openclaw/state/openclaw.sqlite',{readOnly:true});
for(const r of db.prepare('select job_id,name,enabled,job_json,state_json from cron_jobs').all()){
  const j=JSON.parse(r.job_json), s=JSON.parse(r.state_json||'{}');
  console.log((r.enabled?'[开]':'[停]')+r.name, r.job_id.slice(0,8),
    'model='+(j.payload?.model??'-'), 'status='+(s.lastRunStatus||'-'),
    'errs='+(s.consecutiveErrors??'-'),
    'next='+(s.nextRunAtMs?new Date(Number(s.nextRunAtMs)).toISOString():'-'));
}
```
**核对代码硬指标**（11-03 实查值）：中间件 24（`ls rana-web/server/plugins/*.ts | wc -l`）；页签 12（`src/lib/types.ts` NAV_TABS）；测试 138（`cd rana-web && npm test`）；技能 main 12 / rana-qq-public 9（`ls <状态目录>/workspace-*/skills`）；模型（openclaw.json `agents.entries`：main/rana-qq-public=glm/glm-5.3-flash，rana-rp=rp-nsfw/nalang-turbo-1115）。

**改完 cron 必做**：改后回读 job_json 核验（新值在、旧值消失、schedule/delivery 原样）；控制台回显乱码不可信。

---

_本文由 ZCode 于 2026-11-03 凌晨实查后落盘。发现本文与真相不符时，以真相为准并回来改本文——别让它变成下一份骗人的旧文档。_
