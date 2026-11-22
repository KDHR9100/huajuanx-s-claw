# 交接书：RanaPet 桌宠全线收官——复刻路线C + 陪伴感 + 并入5173 + 无痕自主

更新：2026-11-22 14:40 · 分支：main · 最新提交：cb743b9（自言自语系统行渲染，503 用例绿 + 远端 CI 绿） · 工作树干净

## 当前目标

11-21~11-22 主人下载 Coopanion 摸底后拍板「复刻一套达成路线C效果」：给 Rana 造一具桌面身体（桌宠=OpenClaw 的又一个客户端通道，不是第二只宠物），并把与 Coopanion 的差距清单逐项抹平。本阶段全部落地并上传 GitHub，桌宠线宣告收官。

## 已完成

- **Coopanion 摸底**：Electron 壳 + Cortico 内核（四层 Core/Persona/Memory/World），37 个程序化表情/动作词表 + rig 骨骼，启发后续全部思路。
- **K:\RanaPet 桌宠本体**（独立目录，**不入任何 git 仓**）：Electron 33 透明置顶窗 + 一期 CLI 桥 → 二期网关 WS 流式（Ed25519 设备配对，`@openclaw/gateway-client` 签名）→ 三期本地语音（sherpa-onnx SenseVoice int8，239MB 模型在 `data/asr-model/`）→ 四期操作电脑（回环 :47690 的 /cua/* + koffi Win32 注入 + 审批门弹窗 + MCP 壳 `K:\OpenClaw\.openclaw\.openclaw\mcp-servers\pet_cua.mjs` 11 工具）。
- **陪伴感四件套**：换装（figures 目录 + 控制台选）/ 待机自主（60s 心跳：打盹 Zzz、30% 溜达滑窗、45min 冷却冒一句走 sayToBrain）/ `*动作*` 灰字斜体解析 / 网页控制台 `http://127.0.0.1:47690`（config.cjs 底座 data/config.json）。
- **并入 5173**（e0ab931）：🐾桌宠页签 + `server/plugins/pet-console.ts` 前缀代理转发 47690（防 SSRF 白名单 + 宠物未启动优雅降级），插件数断言 26→27，远端 CI 绿。
- **冒一句无痕化**（cb743b9）：协议实验实锤 `chat.send` 带 `systemInputProvenance={kind:'internal_system', sourceTool:'rana_pet_idle'}` 被接受且 chat.history 透传标签（`progress_card_refresh` 是保留字必拒）；rana-web 会话页把这类消息渲染成居中淡字「—— 她自言自语了一下 ——」（systemNote 结构识别 + 旧消息前缀兜底双路），粉色假主人气泡消灭。
- **测试基线**：rana-web 34 文件 503 用例 + tsc 全绿，两次提交远端 CI 均 success。

## 进行中

无未提交改动。宠物此刻带正式节奏在岗（闲置 5 分钟打盹、冒一句冷却 45 分钟、白球形象、会话键 pet:desktop）。

## 下一步

1. **网关重启后验证 pet_cua 工具挂载**：MCP 壳文件已就位，等网关下次重启扫描（`openclaw` CLI 打 `pet_cua__screenshot` 试一把即可确认）。⚠️ 网关重启 = taskkill 连坐 SnowLuma（主人拍板弃修），**必须主人亲自重启或明确点头**。
2. **真机全链测「让她看屏幕干活」**：网关重启挂载后，在任意通道对 main 说「看看我屏幕上是什么」→ 截屏 → qwenanliang 视觉转述 → 审批门弹窗 → 动作执行，一次全链走通即桌宠线彻底闭环。
3. **要乐奈正式形象**：素材（透明背景 PNG，1~3 张）丢 `K:\RanaPet\figures\` → 5173 🐾桌宠页签刷新选用。表情差分生图通道的免费额度拍板在并行会话挂账（三选项见记忆 `rana-pet-image-diff-20261122`）。
4. **（远期候选，未拍板）球体 rig 表情**：照 Coopanion 思路给白球装参数化眼睛/嘴，37 词表映射（19 表情 + 18 动作），`*开心*` 类标记自动触发脸部变化 + 球滚动步态，估一天。

## 关键决策

- **复刻不改造**：Coopanion 是 AGPL + 自动更新会覆盖定制，且大脑锁死在它家框架里；自建身体 + OpenClaw 大脑（记忆桥/SOUL/工具生态全保留）。
- **大脑绑 main**（glm-5.3-flash，恋人化 SOUL，记忆桥现成）：宠物闲聊进 main 会话库 `pet:desktop`；不新建 agent（记忆桥接腿会碰红线资产）。
- **WS 设备配对**：纯 token 连接 scopes 恒空，本机回环 + 合法 token + Ed25519 签名 = 网关自动配对（首次连 NEEDS_PAIRING、第二次起全权限）；权限字段在 `hello.auth.scopes`（顶层 scopes/grantedScopes 恒 null）；会话键会被规范成 `agent:main:pet:desktop`，事件匹配认后缀。
- **CUA 审批门比 Coopanion 严一档**：每个动作（含 move）必过宠物弹窗，120 秒不答自动拒；截图/视觉转述不过门（只读）。
- **视觉通道用 qwenanliang 直连 key**（DashScope）：aliyun-maas 的 key 是 store 引用（`{source:'store'}`，密钥库实体位置至今未查明），宠物解不开。
- **零配置改动**：main 工具白名单为空=全放行，MCP 目录自动发现，openclaw.json 一行没动。

## 坑与注意

- **宠物进程会无声死亡**（端口消失、日志无崩溃痕迹，疑似外部 taskkill/手关）——排障先 `curl 127.0.0.1:47690/health` 再谈触发。
- `config.cjs` 进程内缓存：独立 node 进程 `config.set()` 写完**必须重启宠物**，热改不生效。
- vite 改 `server/plugins/*.ts` 要重启 vite（src 前端按需编译不用）；网关 18789 与 vite 5173 是两个进程，别 taskkill 误伤。
- Electron 主进程 spawn node 必须 `ELECTRON_RUN_AS_NODE=1`。
- PowerShell .ps1 无 BOM 时中文字符串炸解析（按 ANSI 读）——脚本要么纯 ASCII 要么带 BOM。
- 长中文写文件/长参数掺坏字（本阶段反复应验）——代码委托子代理 + 自己短锚点修补 + grep 验收；Git Bash heredoc 长中文必坏，改用文件。
- `ws` 包是依赖树捎带的，已正式 pin 进 RanaPet package.json。
- 看门狗式等待要用正确条件（日志行数基线增长），日志跨重启 append，grep 全量计数会误判。

## 相关工件

- 会话记忆（5 篇）：`coopanion-analysis-20261121` / `rana-pet-phase1-20261121` / `rana-pet-full-chain-20261121` / `rana-pet-companion-layer-20261122` / `rana-pet-idle-provenance-20261122`
- MCP 壳：`K:\OpenClaw\.openclaw\.openclaw\mcp-servers\pet_cua.mjs`（协议骨架照抄 fate.mjs）
- 桌宠设置页：`http://127.0.0.1:47690` 或 5173 🐾页签；形象目录 `K:\RanaPet\figures\`
- 旧阶段交接书：`docs/handoffs/2026-11-17-观察日哨兵手术与卡4卡5收官.md`

## 建议

- 建议技能：无强制；如继续桌宠线，准备好 computer-use（截图验收）。
- 验证命令：`cd rana-web && npm test`（503 绿即环境正常）；宠物在岗 `curl http://127.0.0.1:47690/health`。
