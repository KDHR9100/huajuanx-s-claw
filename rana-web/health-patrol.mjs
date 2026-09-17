#!/usr/bin/env node
// health-patrol.mjs — 零成本系统巡检（心跳改造·阶段2，见 SYSTEM-MAINTENANCE-PLAN.md）
// 由 cron 每 30 分钟拉起（--command-argv 直跑本文件），也可手动：node health-patrol.mjs [--dry]
//
// 检查项（一次全跑，零模型调用）：
//   gateway   网关端口 18789 是否在听
//   vite      前端 5173 是否在听
//   channels  经 openclaw CLI 拿通道状态：QQ running/connected、网关事件循环是否降级
//   backup    私有备份仓最后一次提交距今是否超过 26 小时（cron 每天 17:30 跑）
//
// 异常处理：
//   - 结果写 rana-web/.health/patrol.json（状态页巡检卡读它；历史保留 96 条≈2 天）
//   - 08:00–22:59 且某异常 3 小时内没报过 → 经 QQ Bot REST 直发主人私聊一条聚合消息；
//     鉴权（appId/clientSecret/主人 openid）运行时从 openclaw.json 读，本文件不含任何密钥。
//   - 23:00–07:59 只记不发（深夜不扰）。--dry 只记不发。
// 退出码恒为 0：异常状态本身记在 patrol.json 里，不污染 cron 收据。

import { execFile } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "K:/OpenClaw/.openclaw/.openclaw";
const CONFIG_FILE = path.join(STATE_DIR, "openclaw.json");
const HEALTH_FILE = path.join(HERE, ".health", "patrol.json");
const BACKUP_REPO = "K:/openclaw-backup"; // robocopy 目标（盘根，与 backup-private.cmd 一致）
const OPENCLAW_MJS = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs";
const GATEWAY_PORT = 18789;
const VITE_PORT = 5173;
const BACKUP_STALE_HOURS = 26;
const RE_ALERT_MS = 3 * 60 * 60 * 1000; // 同一异常 3 小时内不重发
const HISTORY_CAP = 96;
const DRY = process.argv.includes("--dry");

const readPatrol = () => {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, "utf8"));
  } catch {
    return { version: 1, updatedAt: 0, checks: [], anomalies: [], lastAlerts: {}, history: [] };
  }
};

const tcpOk = (port, ms = 4000) =>
  new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: ms });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });

const fmtAge = (ms) => {
  const h = Math.floor(ms / 3600000);
  return h >= 1 ? `${h} 小时` : `${Math.max(1, Math.round(ms / 60000))} 分钟`;
};

async function checkChannels() {
  // 经 CLI 拿网关视角的通道状态（CLI 自带 WS 鉴权；30s 上限，网关忙时偶尔超时不算病）
  try {
    const { stdout } = await execFileP(process.execPath, [OPENCLAW_MJS, "channels", "status", "--json"], {
      timeout: 30000,
      windowsHide: true,
      env: { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR },
    });
    const j = JSON.parse(stdout.slice(stdout.indexOf("{")));
    return { ok: true, json: j };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 160) };
  }
}

async function backupAge() {
  try {
    const { stdout } = await execFileP("git", ["-C", path.resolve(BACKUP_REPO), "log", "-1", "--format=%ct"], {
      timeout: 15000,
      windowsHide: true,
    });
    const ts = Number(stdout.trim()) * 1000;
    if (!ts) return { ok: false, ageMs: Infinity, detail: "备份仓无提交" };
    return { ok: true, ageMs: Date.now() - ts, ts };
  } catch (e) {
    return { ok: false, ageMs: Infinity, detail: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
  }
}

async function sendQq(content, cfg) {
  // 直发 QQ 私聊：token 接口与消息接口照抄 @tencent-connect/openclaw-qqbot 插件同款
  const qq = cfg?.channels?.qqbot;
  const owner = (cfg?.bindings ?? []).find(
    (b) => b?.type === "route" && b?.agentId === "main" && b?.match?.channel === "qqbot" && b?.match?.peer?.kind === "direct",
  )?.match?.peer?.id;
  if (!qq?.appId || !qq?.clientSecret || !owner) throw new Error("QQ 配置/主人 openid 不齐，跳过发送");
  const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: qq.appId, clientSecret: qq.clientSecret }),
  });
  if (!tokenRes.ok) throw new Error(`access_token HTTP ${tokenRes.status}`);
  const { access_token: token } = await tokenRes.json();
  if (!token) throw new Error("access_token 为空");
  const msgRes = await fetch(`https://api.sgroup.qq.com/v2/users/${encodeURIComponent(owner)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
    body: JSON.stringify({ content, msg_type: 0, msg_seq: Date.now() % 1000000 }),
  });
  if (!msgRes.ok) throw new Error(`发送 HTTP ${msgRes.status}: ${(await msgRes.text().catch(() => "")).slice(0, 120)}`);
}

const main = async () => {
  const prev = readPatrol();
  const checks = [];
  const anomalies = [];
  const addCheck = (id, label, ok, detail) => checks.push({ id, label, ok, detail });
  const addAnomaly = (id, label, detail) => {
    const before = prev.anomalies?.find((a) => a.id === id);
    anomalies.push({ id, label, detail, since: before?.since ?? Date.now() });
  };

  // 1. 网关端口
  const gwOk = await tcpOk(GATEWAY_PORT);
  addCheck("gateway", "网关端口", gwOk, `${GATEWAY_PORT} ${gwOk ? "在听" : "没在听"}`);
  if (!gwOk) addAnomaly("gateway", "网关", `网关端口 ${GATEWAY_PORT} 没有监听——网页/微信/QQ 全会失联，重启 start-gateway.cmd`);

  // 2. vite 端口
  const viteOk = await tcpOk(VITE_PORT);
  addCheck("vite", "前端页面", viteOk, `${VITE_PORT} ${viteOk ? "在听" : "没在听"}`);
  if (!viteOk) addAnomaly("vite", "前端页面", `vite ${VITE_PORT} 没有监听——网页打不开，重跑 start-rana.cmd`);

  // 3. 通道状态（网关都挂了就不重复查）
  let channelsDetail = "未查";
  if (gwOk) {
    const ch = await checkChannels();
    if (ch.ok) {
      const j = ch.json;
      const qq = j?.channels?.qqbot;
      const degraded = j?.eventLoop?.degraded === true;
      const qqDown = !qq || qq.running !== true || qq.connected !== true;
      channelsDetail = `QQ ${qq?.running ? "running" : "停"} / ${qq?.connected ? "connected" : "断连"}；事件循环 ${degraded ? "降级" : "正常"}`;
      addCheck("channels", "通道状态", !qqDown && !degraded, channelsDetail);
      if (qqDown)
        addAnomaly(
          "qq-channel",
          "QQ 通道",
          `QQ 通道不在健康态（${qq ? `running=${qq.running} connected=${qq.connected}` : "状态里没有 qqbot"}）——若是断网后起的僵尸，重启网关即恢复`,
        );
      if (degraded) addAnomaly("eventloop", "网关事件循环", "网关事件循环降级（卡顿/内存压力），盯一眼日志");
    } else {
      channelsDetail = `查不到：${ch.error}`;
      addCheck("channels", "通道状态", false, channelsDetail);
      // CLI 超时多半是网关忙，单独不算病；连续两班查不到才报
      if (prev.checks?.find((c) => c.id === "channels")?.ok === false) {
        addAnomaly("channels-unknown", "通道状态", `连续两班查不到通道状态（${ch.error}）`);
      }
    }
  } else {
    addCheck("channels", "通道状态", false, "网关挂了，跳过");
  }

  // 4. 备份新鲜度
  const bk = await backupAge();
  const bkOk = bk.ok && bk.ageMs < BACKUP_STALE_HOURS * 3600000;
  addCheck("backup", "私有备份", bkOk, bk.ok ? `最后提交 ${fmtAge(bk.ageMs)} 前` : bk.detail);
  if (!bkOk) addAnomaly("backup", "私有备份", bk.ok ? `备份已 ${fmtAge(bk.ageMs)} 没推送（超过 ${BACKUP_STALE_HOURS}h）` : `备份仓读不到：${bk.detail}`);

  // 落盘
  const now = Date.now();
  const hour = new Date(now).getHours();
  const quiet = hour >= 23 || hour < 8;
  const patrol = {
    version: 1,
    updatedAt: now,
    checks,
    anomalies,
    lastAlerts: prev.lastAlerts ?? {},
    history: [...(prev.history ?? []), { at: now, ids: anomalies.map((a) => a.id) }].slice(-HISTORY_CAP),
  };

  // 报警：非深夜、非 --dry、有异常、异常 3 小时内没报过
  let sendError = null;
  const toAlert = anomalies.filter((a) => (patrol.lastAlerts[a.id] ?? 0) < now - RE_ALERT_MS);
  if (!DRY && !quiet && toAlert.length > 0) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      const lines = toAlert.map((a) => `· ${a.label}：${a.detail}`);
      await sendQq(`🩺 巡检发现异常：\n${lines.join("\n")}\n（零成本巡检脚本，不用回复我）`, cfg);
      for (const a of toAlert) patrol.lastAlerts[a.id] = now;
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
    }
  }
  if (sendError) patrol.sendError = sendError;
  else delete patrol.sendError;

  fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(patrol, null, 2), "utf8");

  // 同步一份到 workspace-main/memory/patrol-status.md：兜底心跳（每 24h）从这里读；
  // 「更新时间超过 90 分钟」即代表本脚本自身停摆，由兜底心跳报警
  const pad = (n) => String(n).padStart(2, "0");
  const t = new Date(now);
  const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const statusMd = [
    "# patrol status（health-patrol.mjs 每 30 分钟重写，勿手编）",
    `- 更新：${stamp}`,
    anomalies.length === 0 ? "- 异常：无" : "- 异常：",
    ...anomalies.map((a) => `  - ${a.label}：${a.detail}`),
  ].join("\n");
  try {
    const wsStatus = path.join(STATE_DIR, "workspace-main", "memory", "patrol-status.md");
    fs.mkdirSync(path.dirname(wsStatus), { recursive: true });
    fs.writeFileSync(wsStatus, statusMd + "\n", "utf8");
  } catch {
    /* workspace 写不进不影响主流程 */
  }

  console.log(
    JSON.stringify({
      ok: true,
      dry: DRY,
      quiet,
      anomalies: anomalies.map((a) => a.id),
      alerted: !DRY && !quiet ? toAlert.map((a) => a.id) : [],
      sendError,
    }),
  );
};

main().catch((e) => {
  // 巡检自身崩了也写盘留痕（这本身就是异常）
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    fs.writeFileSync(
      HEALTH_FILE,
      JSON.stringify({ version: 1, updatedAt: Date.now(), patrolError: String(e?.message ?? e).slice(0, 300) }, null, 2),
      "utf8",
    );
  } catch {}
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 300) }));
});
