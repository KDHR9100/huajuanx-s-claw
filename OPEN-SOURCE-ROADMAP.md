# OPEN-SOURCE-ROADMAP — 开源任务书：从「个人旗舰项目」到「开源框架」（2026-09-15）

> 性质：**任务书**。回答「为什么开源、做成什么形态、做到什么程度算完成」；
> 施工细节不在本文件重复——**怎么改**看 [OPTIMIZATION-ROADMAP.md](OPTIMIZATION-ROADMAP.md)（批次划分），
> **证据链**看 [PROJECT-ANALYSIS.md](PROJECT-ANALYSIS.md)（代码体检）与 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)（事故台账）。
>
> 已拍板的路线（2026-09-15）：**分阶段，先应用后框架**；README **中文为主 + 英文精简门面**。

---

## 0. 为什么做这件事

这个项目的价值现在分成两半：**对自己的情绪价值**（已经兑现，而且很高）和**对别人的工程价值**（基本没兑现——别人 clone 不下来、跑不起来、法律上也不能用）。开源化就是把后一半补上的过程，顺序是：

1. **先让它成为合法、体面的开源项目**（阶段〇～一）——简历立刻可以写「开源项目作者」，且经得起面试官点开仓库检查；
2. **再让别人能跑起来**（阶段二）——「有人真的装过」和「没人装过」在面试问答里是两个世界；
3. **然后让英文圈看见**（阶段三）——中文文档的天花板就是中文圈；
4. **最后才是抽框架**（阶段四）——把「Rana 的家」升维成「任何人都能装自己角色的框架」。这是价值最大的一跃，也是工程量最大的一跃，**动工前需单独拍板**。

**简历称谓纪律**：阶段四完成之前，简历/口述里说「自托管多智能体 AI 陪伴平台（开源）」，不说「开源框架」——面试官点进去一眼能看出差距，穿帮反而减分。

## 1. 定位与差异化

一句话定位：**隐私优先的本地 AI 陪伴平台（演进为框架）**。

与通用平台的差别（不是竞品关系，是类别差别）：

| | Open WebUI / LobeChat / Dify | 本项目 |
| --- | --- | --- |
| 形态 | 通用平台，谁都能用 | 定制之家，为一个人深度打磨 |
| 隐私 | 配置项 | **架构级**：RP 原文只进本地模型、化名映射外置、表/里双人格闸门 fail-closed |
| 人格 | 角色卡 | 常驻人格 + 记忆体系 + 心跳主动性 + 三腿记忆桥 |
| 运维 | 部署即用 | 12GB 显存算术、embedding 看门狗、事故台账制度 |

英文圈（r/LocalLLaMA 等）有大量「本地模型 + 隐私 + 有记忆的陪伴 AI」需求，但成型好用的开源品稀缺——这是本项目的差异化站位，也是阶段三发布时的叙事核心。

## 2. 现状基线（2026-09-15 摸底事实）

**家底**：前端 + 边车脚本合计约 14,300 行（src 约 10,900、vite.config 约 2,650、边车脚本约 1,800）；README 约 520 行、KNOWN-ISSUES 约 380 行；13 组 `/__rana` 中间件；9 页签；三 agent 三渠道在生产真实运行。

**缺口**（阶段〇～二要补的）：

| 缺口 | 现状 |
| --- | --- |
| LICENSE | **无**——严格说不算开源，别人法律上不能用 |
| 测试 / CI / lint | 零 |
| 个人信息入公开仓 | WSL 用户名两处已跟踪（vite.config 的 DSH 路径常量、DshPage 派活预设）——阶段〇已清除（改走 gitignored 的 local-config.json） |
| 本机路径写死 | `K:\OpenClaw`（vite.config / 多个边车脚本 / 启动 cmd）、`G:\node\node.exe`（start-gateway.cmd）、`C:\Users\Administrator\...\openclaw.mjs`（vite.config 里同一定义了两遍） |
| 文档语言 | 全中文，英文圈不可见 |
| 上游耦合 | cron 会话删除 bug、QQ 图片插件本地补丁升级即被覆盖 |

**已具备的地基**（不用重做）：identity/privacy-patterns 已外置 gitignore；源码零硬编码密钥（token 全运行时读取）；页签单一来源；ErrorBoundary；早报 SecretRef 修复；（09-15 新增）cron 会话一键清理脚本 + 界面入口。

## 3. 阶段〇：地基——合法开源（2026-09-15 完成）

**目标**：法律上可开源，公开内容无个人信息泄露。工作量约 1 个晚上。

- [x] 添加 `LICENSE`（MIT，署名与 GitHub 账号一致）
- [x] 清除已跟踪文件里的个人标识：两处 WSL 用户名路径改为读 gitignored 的 `rana-web/local-config.json`（公开模板 `local-config.example.json`；派活页个人预设改由 `/__rana/dsh-models` 服务端下发）
- [x] 全仓 secrets 扫描：2026-09-15 图样扫描（`sk-`/`Bearer`/`apiKey` 赋值）**零命中**；宽松复查命中全为代码变量引用与 CSS 假阳性，无明文密钥
- [x] `.gitignore` 复核：新增文件进公开仓均属预期；追加 `rana-web/local-config.json`
- [x] `OPTIMIZATION-ROADMAP.md` 去真名/化名改写（「化名=真名」的映射解释不得留在公开文档里）
- [x] git 历史遗留评估：真名存在于 4 个历史提交（09-09~09-14）、用户名 3 个（09-14~09-15）；openid/密钥/GitHub 账号**从未进入历史**。**拍板：接受历史、只保今后（2026-09-15）**——重写需 force-push 且影响私有备份链，不值得**

**验收**：LICENSE 存在 ✓；已跟踪文件用户名/真名 grep 零命中（历史里仍有，已接受）✓；图样扫描零高危 ✓。

## 4. 阶段一：可信度——让懂行的人点头

**目标**：面试官/资深工程师点开仓库时看到的是工程，不是玩具。工作量约 2-3 个晚上。

> 实施注记：npm 安装需带 Clash 代理 env（`HTTPS_PROXY=http://127.0.0.1:7897`），直连会超时（装 acpx 时踩过）。

- [ ] vitest + 首批纯函数测试：`reasoning.ts`（脏输出清洗）、`fateCore.ts`（历法/干支）、`memory-bridge.mjs` 的 `parseEntries()`、`git-activity` 统计口径——四处边界 Case 密集、改动爆炸半径最大（= OPTIMIZATION-ROADMAP 批次三.1）
- [ ] GitHub Actions CI：install → `tsc --noEmit` → `vitest run` → `vite build`，README 挂徽章
- [ ] 拆 `vite.config.ts`（约 2,650 行）→ `server/` 目录按域分模块，vite.config 只剩装配（= 批次三.2；阶段四抽包的前置）
- [ ] 合并 `study-agent.mjs` + `fate-agent.mjs`（约 95% 重复）→ `lib/agent-bridge.mjs`（= 批次三.3）
- [ ] 向上游 OpenClaw 报 issue（两个）：run 级 cron 会话 delete 报 not found；`worker_session_placements` 任务结束不清残留——附 KNOWN-ISSUES 的证据链与复现步骤

**验收**：CI 绿；测试跑通且覆盖四处核心纯函数；vite.config 收缩到数百行以内；上游 issue 已提交（编号回填此处）。

## 5. 阶段二：可移植——「克隆即跑」+ 第一个版本

**目标**：陌生人 clone 后按 README 能跑起来。工作量约 2 个晚上。

> 2026-09-19 施工注记：本阶段随「开箱即用发行版」落地——新增 `setup.cmd`/`setup.mjs`/`setup-templates/`（发行模板 + 一键初始化，默认**单 agent 单人格**形态，多智能体入口按配置自动显隐）。原计划的「.example 启动脚本模板」被更好的方案取代：启动脚本直接可移植（相对路径 + 自动探测），配 `local-overrides.cmd`（gitignore）做本机差异兜底。

- [x] 路径全链路环境变量化：`OPENCLAW_STATE_DIR` 贯穿 vite.config / 边车脚本 / 启动脚本（`lib/rana-config.mjs` 已有 env 优先逻辑，把所有写死路径收敛过去 = OPTIMIZATION-ROADMAP 1.4）
- [x] 子进程统一 `process.execPath`，替换 `G:\node\node.exe` 等写死值（启动脚本走 PATH + `local-overrides.cmd` 兜底；openclaw.mjs 自动探测）
- [x] 启动脚本提供 `.example` 模板（start-gateway.example.cmd 等），真实脚本保持 gitignore —— **方案升级**：脚本直接可移植入库，`local-overrides.example.cmd` 提供本机差异模板
- [x] README 快速上手改写为可复现步骤：前置依赖（OpenClaw / LM Studio / Node 版本）→ 配置 → 启动 → 验证，每步可核对
- [ ] package.json 元数据补全（name/description/keywords/repository）+ 打 tag `v0.1.0` + GitHub Release（简版 CHANGELOG）——元数据已补，tag/Release 待发布时执行

**验收**：在非 `K:\OpenClaw` 的目录 clone，按 README 走完全部步骤能启动（本机实测留档截图/日志）——已排期执行（异地模拟：剔除 gitignored 内容复制到全新目录跑 setup→启动→填 key→聊天）。

## 6. 阶段三：英文门面 + 传播

**目标**：英文圈可见，收获第一批非作者用户。工作量约 1-2 个晚上 + 发布跟进。

- [ ] `README.en.md` 精简版（约 100 行）：What/Why/Highlights×6/Quickstart/Architecture/License + 链接中文详解；模型 + 人工双检通顺
- [ ] 截图 2-4 张（会话页 / 状态页 / 她的房间 / 学习计划）+ 架构图图片版（可选，ASCII 已够用）
- [ ] 发布渠道清单与发帖草稿：r/LocalLLaMA、V2EX、即刻、少数派（草稿备好再发，发布是外向动作，发前过一眼红线）
- [ ] 仓库门面检查：LICENSE / 截图 / CI 徽章 / 英文 README 链接 / Release 一个不少

**验收**：英文母语者（或模型辅助人工复核）读通无歧义；至少一个渠道发布并留链接。

## 7. 阶段四：框架化——第二波（动工前单独拍板）

**目标**：「Rana 的家」→「任何人都能装自己角色的本地 AI 陪伴框架」。工程量以周计。

- [ ] `persona.json`：人格设定 / 应援色 / 界面文案 / 角色卡外置为配置（= PROJECT-ANALYSIS P3.3）
- [ ] 核心包抽取：Vite 中间件后端层 + 网关客户端（WS 协议 / Ed25519 握手 / 重连 / 三路去重）+ 身份层 → 独立 npm 包；rana-web 降级为框架的第一个示例应用
- [ ] 「第二用户故事」验证：找一个真实场景（朋友/网友装自己的角色）走通全流程，暴露配置面缺口

**拍板门槛**：阶段〇～三全绿；能说清框架对「第二个用户」的最低承诺（哪些能配、哪些必须改代码）；接受维护一个包的长期成本。

## 8. 验收总表（汇总）

| 阶段 | 一句话 Done 定义 |
| --- | --- |
| 〇 地基 | ✅ 2026-09-15 完成：有 LICENSE，已跟踪文件无个人信息，图样扫描零高危（历史遗留已拍板接受） |
| 一 可信度 | CI 绿 + 四模块有测试 + vite.config 拆完 + 上游 issue 已报 |
| 二 可移植 | 异地 clone 可跑，v0.1.0 已发 Release |
| 三 传播 | 英文门面就绪，至少一个渠道已发布 |
| 四 框架 | persona 可配置，核心成包，第二个用户走通 |

## 9. 附录：简历叙事素材

**现在就能用的 bullet（阶段〇-一完成后）**：

- 自主设计并开源「自托管多智能体 AI 陪伴平台」：三智能体（云端主力 / 本地 RP / 群公共号）三渠道路由，前端 + Vite 中间件后端约 1.4 万行 TypeScript；自设计 WebSocket 协议层（Ed25519 设备身份握手、乐观 UI、三路消息去重），零后端进程单机全栈架构。
- 隐私一等公民架构：本地模型处理敏感原文、化名映射外置、双人格闸门 fail-closed——数据流按「原文不出本机」分层设计。
- LLM 运维工程化：12GB 显存定量调度（14B 常驻 + embedding 看门狗自愈）、token 消耗优化（心跳 500 万/天 → 10 万/天，-98%）、A/B/C 对照实验定位模型与装配双病因。

**框架版 bullet（阶段四完成后）**：在上述基础上——「沉淀为可配置开源框架（persona/渠道/模型三层可配），第二用户已独立部署成功」。

**面试 STAR 素材三条**（每条都是真实事故，不怕追问）：

1. **心跳 token 事故**：心跳每 30 分钟整会话唤醒，94% 空转，每天约 500 万 token。定位（receipts × usage 定量）→ 方案（isolatedSession + lightContext + activeHours + 自定义 prompt 改为读日记判断）→ 结果 -98% 且主动性格保留 → 取舍（心跳不再天然看到聊天记录，靠记忆体系补偿）。
2. **QQ 入站图片两级修复**：症状（群里图片没反应）→ 第一级查配置（vision 模型缺失）→ 第二级查插件（本地补丁）→ 意识到补丁会被升级覆盖，登记 KNOWN-ISSUES 形成制度。
3. **RP 质量双病因实验**：不是拍脑袋换模型，而是搭 A/B/C 三组对照（装配/模型双变量），坐实「装配 + 模型」双病因，再对症下药——用实验设计代替玄学调参。

## 10. 红线（全程有效）

- 公开镜像经 `push-public.cmd` 的 `git add -A` 全量推送：**任何新文件默认视为将公开**，密钥/token/个人账号 ID/私有仓库地址禁止入库，不确定先查 `.gitignore`。
- `.openclaw/` 运行时状态（配置/DB/workspace）永不进 git。
- 对外发布（阶段三）属于外向动作：发帖前过一遍隐私与红线。
- 事故解决后回写 KNOWN-ISSUES 的制度不因开源化放松——它是这个项目最值钱的资产之一。
