# OpenClaw 系统维护规划书（2026-09-17）

> 本文件是 2026-09-17 系统维护的**唯一权威规划**：诊断结论、已拍板方向、分阶段任务与状态、
> 定时任务总账、瘦身清单都在这里，随执行更新。执行 agent 以本文件为准，不凭会话记忆。
>
> 关联文档：[KNOWN-ISSUES.md](KNOWN-ISSUES.md)（排障台账）、[OPEN-SOURCE-ROADMAP.md](OPEN-SOURCE-ROADMAP.md)（开源路线）。

## 一、本次维护的起因（2026-09-17 诊断）

1. **QQ 断线**：当天 03:08–12:27 主机外网中断（时间上与迁移 WSL 吻合），QQ 插件长连接
   04:46 重连耗尽后**静默装死**，网络恢复也不自愈；重启网关即恢复。密钥/补丁/配置全好。
2. **「本地信息丢失」三件事叠加**：
   - `.life/` 目录（人生目标+内容库）消失。经查**人生目标从未录入过**（9-16 会话上下文均
     写着「还没建人生目标」）；内容库 16 条搜集候选已从被删会话的 zst 归档里完整捞回；
   - 前端「挂载时单次取数、失败静默、不自动重试」——定时任务页最严重（WS 未握上手秒拒），
     技能面板/课表同款弱点，表现为「刷新后有、有时没有」；
   - 会话页因多路自动刷新幸免，属对照组。
3. **每日私有备份 9-12 起停摆**：robocopy 报错后未再成功；且备份范围不含 rana-web 数据文件，
   本次数据无法从备份恢复就是它。
4. **系统臃肿**：cron 表 25 条中 8 条重复/僵尸；40+ 配置备份；旧工作区与第二状态目录残留；
   vite.config.ts 单文件 3740 行装 14 个中间件；心跳与主人画像同患 qwen「干完活不落笔」病
   （画像连错 5 次停更于 9-13）。

## 二、已拍板方向（用户 2026-09-17 确认）

- **心跳拆开**：零成本脚本自检（每 30 分钟，异常立刻 QQ 私聊+状态页亮红，深夜只记不扰）
  + Rana 早晚问候（10:00 / 21:00）；系统心跳降频为兜底。
- **画像都留**：主人画像 cron 换 glm 修稳；群画像运行正常不动。
- **瘦身四项全干**：定时任务大扫除、修好每日备份、文件目录瘦身（删前给清单）、代码瘦身。
- 规划书落仓库文件，批准后执行。

## 三、分阶段任务与状态

### 阶段 0：止血 ✅（2026-09-17 完成）

- [x] 重启网关恢复 QQ：14:07 `[qqbot] gateway READY`，channels status 双通道 running。
- [x] 重建 `.life/`：从 `agents/main/sessions/b8ecc360-*.zst` 归档解压，捞回 16 条内容库
      候选写入 `rana-web/.life/library.json`（三次搜集：五年规划 6 + AI 游戏 6 + 独立游戏 4），
      接口回读 16 条可见。人生目标本就未录入，由用户日后在规划页重建。
- [x] 前端加载修复（`npx tsc --noEmit` 通过）：
      `gateway.ts` request() 在 WS 握手中改为排队等待；新增 `onConnected()` 广播；
      CronPage 挂载+重连双路重拉、错误可点击重试；新增 `lib/fetchRetry.ts`，
      AgentKitCard / StudyPage 改用带重试取数、错误可点击重试。

### 阶段 1：修好每日备份 ✅（2026-09-17 完成）

- [x] 根因（比预想深，共三层）：①任务挂在**小写路径死 store** 里，9-12 傍晚网关切换后成孤儿
      （同病还有 git 日报×3、学习日报×2——静默停摆 5 天，见 KNOWN-ISSUES 9-17 条目）；
      ②9-12 当天 push 撞上 Clash 7897 半死（TLS 全断），重启 Verge 后恢复；
      ③脚本重试用 `timeout` 在 cron 无控制台环境秒失败，已改 `ping -n 61`
- [x] 备份范围核实：robocopy 本就全量镜像 K:\openclaw（含 rana-web/.study/.life/.news 等），
      无需扩范围——此前"范围不含 rana-web"是误判
- [x] 备份任务重建进活 store（新 id f8b51148，每日 17:30）；手动实跑验证：robocopy 同步
      5 天增量 + 提交 + 推送成功（备份仓与 origin 齐平）
- [x] 职责矛盾清理：过期心跳小抄（"备份由本清单接管"）已删；备份唯一归 cron，巡检盯新鲜度

### 阶段 2：心跳改造 ✅（2026-09-17 完成）

- [x] `rana-web/health-patrol.mjs` 上线 + cron `*/30`（id 9fe23401）：查网关端口/vite/通道状态
      （QQ 僵尸 30 分钟内必被发现）/备份新鲜度（>26h）；异常写 `.health/patrol.json` 并经
      QQ Bot REST 直发主人私聊（鉴权运行时读 openclaw.json，08:00–22:59 报警、3 小时去重、
      深夜只记）；首班 15:00 实跑全绿
- [x] 系统心跳降频收权：every 60m→**24h** 兜底（网关热重载确认 intervalMs=86400000），
      prompt 改为「读 memory/patrol-status.md（巡检脚本每 30 分钟重写的快照）：异常或快照
      超 90 分钟未更新（巡检自身停摆）才报告，否则 NO_REPLY」
- [x] 早晚问候 cron（id 3b50935f，`0 10,21 * * *`，隔离+轻上下文，glm-5.3-flash，
      announce→last 通道）：读最近日记+巡检异常，必须中文收尾
- [x] 状态页新增「🩺 巡检」卡：sys/status 接口带 patrol 数据，四项检查红绿灯+异常明细
      +「90 分钟没更新」自警

### 阶段 3：画像修稳 + cron 大扫除 ✅（2026-09-17 完成）

- [x] 主人画像两条 cron（854405fc 每日 / 15aadbf0 周报）已切 `glm/glm-5.3-flash`
      （cron edit 即时生效）；⏳ 次日 04:30 验证 portrait-master.md 恢复更新
- [x] cron 库手术（停网关→备份 `backups/cron-surgery-20260917-145423/`→SQL 清 13 条
      小写 store 行→复活 5 个被孤儿化的保留任务→重启）：25 条 → **19 条无重复**；
      doctor --fix 不再需要（小写行已物理清除，等价完成规范化）
- [x] 清理明细：僵尸心跳 8bd6d022+过期小抄、记忆桥重复 2e686e8f、私密桥旧档 3a00b653、
      旧备份 1c5b6bd4、morning-report 残留 c4d2dc88、lesson4-wakeup、技能回顾小写半边×3；
      复活：git-activity×3、study 睡前/周报（job_id 原样保留，收据历史连续）
- [x] 定时任务总账已更新（见下节）

### 阶段 4：文件目录瘦身（⚠️ 每项删前给用户过目）

候选清单（执行时逐项列「路径+大小+为什么能删」请用户确认）：

| 候选 | 位置 | 说明 |
| --- | --- | --- |
| 默认骨架 workspace | `.openclaw/.openclaw/workspace/` | 09-07 初始库，无 agent 引用 |
| Tifa 残留 workspace | `workspace-tifa` + 路径别名 | agent 已删，别名还指向拼写错误旧路径 |
| 误建状态目录 | `rana-web/openclaw.openclaw.openclaw/` | 9-13 错误 STATE_DIR 的产物，仅 state/tmp |
| 第二状态目录 | `C:\Users\Administrator\.openclaw\` | 默认 HOME 遗留，先确认无引用 |
| 配置备份堆 | 40+ 个 `openclaw.json.bak-*` | 保留最近 3 个关键的，其余删 |
| 旧归档 | `backups/*-archive` 等 | 已废弃的 workspace 归档 |

### 阶段 5：代码瘦身

- [ ] 先提交工作区现有的「开始今天的课」未提交改动（此前会话成果）
- [ ] vite.config.ts（3740 行）按中间件拆成 `rana-web/server/` 下模块 + 装配入口；
      桥脚本按「数据桥/会话桥/工具」归拢；**页面功能与路由零变化**
- [ ] `npx tsc --noEmit` + 全页签手动冒烟（重点：早报、规划、定时任务、清理弹窗）

## 四、定时任务总账（2026-09-17 手术后，19 条，唯一权威清单）

| 任务（id 前8） | 计划 | agent | 花模型钱 | 说明 |
| --- | --- | --- | --- | --- |
| Heartbeat main（af8f6f0e） | every 24h | main | 是（兜底班） | 读 patrol-status.md，异常/巡检停摆才报告 |
| 巡检（9fe23401） | */30 * * * * | 脚本 | **否** | health-patrol.mjs；异常 QQ 直报+状态页红灯 |
| 早晚问候（3b50935f） | 0 10,21 * * * | main | 是（glm，2次/天） | announce→last；读日记+巡检异常 |
| Daily Private Backup（f8b51148） | 30 17 * * * | 脚本 | 否 | robocopy+git push（3 次重试）；巡检盯新鲜度 |
| memory-bridge（1960c470） | 0 * * * * | 脚本 | 否 | 共享记忆桥三腿 |
| private-memory-bridge（d09b5239） | 17 * * * * | 脚本 | 否 | 私密记忆桥 |
| Memory Dreaming（6a32d471） | 0 3 * * * | 系统 | 是 | memory-core 内置 |
| 主人画像每日（854405fc） | 30 4 * * * | main | 是（**glm**） | ⏳ 观察收尾病是否根治 |
| 主人画像周报（15aadbf0） | 周日 21:00 | main | 是（**glm**） | 同上 |
| 群画像每日（b566bd64） | 30 4 * * * | rana-qq-public | 是（qwenanliang） | 正常不动 |
| 群画像周报（ebecc6f3） | 周日 21:00 | rana-qq-public | 是 | 正常不动 |
| Git 活动日报（e56a515f） | 30 21 * * * | main | 是 | 9-17 从死 store 复活 |
| Git 活动周报（5eee3566） | 周一 9:00 | main | 是 | 同上 |
| Git 活动月报（a0d08bc5） | 每月 1 日 9:00 | main | 是 | 同上 |
| 学习睡前小结（94f0079f） | 30 22 * * * | main | 是 | 9-17 从死 store 复活 |
| 学习周报（173ec710） | 周日 21:00 | main | 是 | 同上 |
| Skill review main（b323f358） | every 7d | main | 是 | 系统 |
| Skill review rana-rp（acf885b5） | every 7d | rana-rp | 是 | 系统 |
| Skill review rana-qq-public（c587d68c） | every 7d | rana-qq-public | 是 | 系统 |

> 模型钱粗账：巡检/备份/两桥 4 条零成本；问候 2 班/天 + 兜底心跳 1 班/天 + 画像 2 条/天——
> 比改造前（心跳 24 班/天）省约 95% 的心跳开销。

## 五、KNOWN-ISSUES 回写 ✅（2026-09-17）

已登记 4 条：①QQ 断网僵尸（含巡检防复发）；②cron 小写 store 孤儿大面积发作（备份+git×3+study×2
停摆 5 天的真相与手术实录）；③前端单次取数不重试模式与修复约定；④.life 目录消失之谜（数据已捞回，
删除者未定案）。

## 六、风险与回退

- cron 手术前备份 `openclaw.sqlite`；系统级任务拒删不强攻，登记上游限制。
- vite 拆分是纯搬家不改逻辑，出问题 git 还原；动手前先提交现状。
- 心跳/问候/画像全换 glm 后若 glm 端点异常，回退配置在 `openclaw.json.bak-unpin-hb` 系列。

## 七、明确不做

不加未提的功能；不动 push-public/backup 推送凭据；不做开机自启；密钥不进任何新文件与 git。
