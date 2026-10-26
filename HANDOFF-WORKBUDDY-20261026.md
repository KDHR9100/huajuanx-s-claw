# 交接书：云端前端 5173 打不开（Tailscale 数据面不通）

> **[已解决 2026-10-26 20:30]** 施工完成并验收（家→云 5173 三连 200），全案详见 KNOWN-ISSUES 台账「云端 5173 打不开三重案」条目。
> 两处与本文推断不同：①「DERP 域名解析为空」实为**域名本身不存在**（derp-hkg 等按城市命名是错的，真实命名 derp<RegionID><字母>，服务器 DNS 是好的，无需 /etc/hosts 写死）；②除了白名单+3478，还差第三刀——**家里节点 home DERP 实测在 lax(region 17)**，不在白名单，导致修完前两刀仍只剩 disco 半通（WireGuard 握手完不成）。

> 交接时间：2026-10-26 晚　|　交接人：ZCode（家里 Windows 会话）　|　接收人：workbuddy（云服务器侧）
> 背景：腾讯云香港迁移（MIGRATION-PLAN-2026-10.md），批0-3 已收官，QQ/微信/网关/前端三服务全部在云上活了，卡在最后一步——主人浏览器打不开网页。

## 一、症状

主人浏览器访问 `http://100.69.115.62:5173`（Tailscale IP）打不开。家里 Windows 侧 ping 该 IP 100% 丢包；`tailscale status` 里云端节点显示 `active; relay "hkg", tx 5772 rx 0`——**只发不收**。

## 二、已排除的嫌疑（都实测过，不用重查）

| 嫌疑 | 实测结果 |
| --- | --- |
| 前端进程 | ✅ 活着，`0.0.0.0:5173` 在监听，服务器本机 `curl 127.0.0.1:5173` 返回 200 |
| 网关 | ✅ `openclaw-gateway.service` active running（QQ/微信都通就是证明） |
| 入站防火墙 | ✅ nftables input 链有 `iifname "tailscale0" accept`，放行无误 |
| Tailscale 注册状态 | ✅ 两台机器都在线、控制面正常（能互相看到 active） |
| 腾讯云镜 YJ-FIREWALL 表 | ✅ 只有几条封 22 的旧规则，不背锅 |

## 三、真凶（确诊）

**云服务器的出站防火墙把 Tailscale 的 DERP 中继掐死了。**

机制：家里↔云端两台 Tailscale 节点直连打洞不通时，靠 Tailscale 官方的 DERP 中继服务器传数据。这个服务器 nftables 的 **output 链是「默认拒绝 + IP 白名单」**（当初为了安全只放行少数域名）。结果是：

- Tailscale 控制面走 `controlplane.tailscale.com`（碰巧能解析）还活着 → 节点显示"在线"
- 数据面的 DERP 域名（`derp-hkg.tailscale.com` 等）**DNS 解析为空**、STUN/探活全灭

服务器上实锤证据（`sudo tailscale netcheck`）：

```
* UDP: false
* IPv4: (no addr found)
* Nearest DERP: unknown (no response to latency probes)
```

且 `getent hosts derp-hkg.tailscale.com derp-lax.tailscale.com` 返回空。双向 `tailscale ping` 均超时。

## 四、修法（给 workbuddy 的施工单）

目标：让服务器出站能到达 Tailscale DERP 中继，同时**不许放松整体出站白名单策略**。

1. **先拿到 DERP 中继的真实 IP**（域名当前解析不出来，可能走了被污染/被白名单挡的 DNS）：
   ```bash
   # 换公共 DNS 手动解析（服务器 DNS 只放行了指定解析器，可临时用DoH或本机验证）
   curl -s "https://1.1.1.1/dns-query?name=derp-hkg.tailscale.com&type=A" -H "accept: application/dns-json"
   ```
   ⚠️ 注意 1.1.1.1 若不在出站白名单里也会被挡，可从家里 Windows 解析后把 IP 抄过来（家里 `nslookup derp-hkg.tailscale.com` 即可）。
2. **把解析到的 DERP IPv4 加进 nftables 出站白名单**：编辑 input/output 链所在的规则文件（家里留档在 `~/.ssh/nftables-rana-v2.conf`，服务器上确认实际加载的是哪份），在 `wan_allow_v4` 集合追加 DERP IP，并确认 443/UDP-3478 端口段放行覆盖（Tailscale 需要 UDP 3478 打洞 + TCP 443 到 DERP）。
3. **顺手补 DNS**：DERP 域名解析失败说明指定解析器没接管 `*.tailscale.com`，确认 `udp/tcp dport 53` 出站到哪个解析器、该解析器为何不答，或直接在 `/etc/hosts` 写死 DERP IP（中继 IP 很少变，可接受）。
4. **重载防火墙**：`sudo nft -f <规则文件>`。⚠️ 施工时**必须留一个已连上的 SSH 会话别断**——output 链改错一条就会把自己锁在门外（SSH 是公网 22 进来的，input 链没事，但 output 把回程挡了照样断）。
5. **验证**（按顺序）：
   ```bash
   sudo tailscale netcheck        # 期望: UDP: true, Nearest DERP 出现具体节点
   sudo tailscale ping 100.86.244.98   # 期望: pong via DERP/直连
   ```
   然后主人在家里浏览器刷新 `http://100.69.115.62:5173` 应秒开。

## 五、禁区（老规矩）

- 出站链的 `policy drop` 和黑名单集合（gjzx 族/neon/CF API）**不许动**，只做加法。
- 改 nftables 前先备份现行 ruleset：`sudo nft list ruleset > ~/nft-backup-$(date +%m%d).conf`。
- 不修完不要重启 tailscaled 试图"碰运气"，现状下重启只会更糊涂。
- 修完回写 KNOWN-ISSUES 台账（症状关键词：5173 / Tailscale rx 0 / DERP）。

## 六、给主人：workbuddy 用哪家模型（推荐）

- **首选：智谱 GLM**（你们现役生态）：这个项目本身就是 GLM 顶班跑的，工具链熟、`ZHIPU_API_KEY` 已配好；干这种防火墙+shell 施工用 **glm-5.3-flash** 档就够，便宜还快。10-30 额度重置后 main 可以换回原班。
- **备选：DeepSeek**：性价比高，适合纯读文档/改配置类活；但你们 QQ 公众号那边还挂着 deepseek 待拍板，别一鱼两吃搞混额度。
- 不推荐给 workbuddy 用本地 LM Studio 的模型：网络排障要长上下文+稳定工具调用，本地小模型容易在关键施工步骤上抽风，这台 2 核 2G 的云服务器也不适合再驮推理。
