#!/usr/bin/env node
// owner-status.mjs — 主人状态哨兵（深夜催睡链路的眼睛+扳机）
// 由 cron 每分钟直跑（command 直跑模式，同 health-patrol，零模型调用；也可手动：node owner-status.mjs [--test|--dry-run]）
//
// 数据流：采集（前台窗口标题/进程清单/键鼠空闲）→ 快照落 .health/owner-status.json（她随时可读）
//         → 规则引擎判定 → 命中「深夜+游戏连续在跑」→ 先记账后拉人：
//         CLI 拉起 main 一轮（qq-sidecar runner.mjs 同款命令），提示词带全部事实，她用 message 工具 QQ 直发主人。
// 账本与冷却在脚本侧记账（最多 maxNags 次/间隔 nagGapMinutes，物理防唠叨）；她只负责把话说好。
//
// 文件契约：
//   rana-web/owner-status.config.json          公开配置（游戏关键词/阈值，改完即时生效）
//   {STATE_DIR}/owner-watch.json               私有配置（QQ 目标/会话键，绝不进仓）
//   rana-web/.health/owner-status.json         快照（她与早晚问候读这个；.health/ 已 gitignore）
//   rana-web/.health/owner-watch-state.json    哨兵内部状态（连跑计时/账本/昨日摘要）
//
// 无密钥声明：本文件不含任何 QQ ID/token；QQ 目标从状态目录私有配置读，缺失则只记档不开口。
// 退出码恒为 0，异常记进 state.lastError（不污染 cron 收据）。

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.resolve(HERE, "..", ".openclaw", ".openclaw");
const CONFIG_FILE = path.join(HERE, "owner-status.config.json");
const PRIVATE_FILE = path.join(STATE_DIR, "owner-watch.json");
const HEALTH_DIR = path.join(HERE, ".health");
const SNAPSHOT_FILE = path.join(HEALTH_DIR, "owner-status.json");
const STATE_FILE = path.join(HEALTH_DIR, "owner-watch-state.json");
const NIGHT_START_DEFAULT = "23:00";
const NIGHT_END_DEFAULT = "03:00";
const PS_TIMEOUT_MS = 20000;

/** 读 JSON，坏/缺返回 null（快照与状态都允许缺省）。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 原子写：写临时件再改名，防半截文件被下一个进程读到。 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

// ---------- 规则引擎（纯函数，供 vitest 直测） ----------

/**
 * 游戏识别：关键词对「前台窗口标题/前台进程名/全进程清单」做不区分大小写包含匹配。
 * 进程清单兜底了"游戏最小化挂在后台"的场景——挂机也是挂着。
 */
export function matchGame(games, input) {
  const fgTitle = String(input?.fgTitle ?? "");
  const fgProc = String(input?.fgProc ?? "");
  const procs = Array.isArray(input?.procs) ? input.procs.map(String) : [];
  const hay = [fgTitle, fgProc, ...procs].map((s) => s.toLowerCase());
  for (const game of Array.isArray(games) ? games : []) {
    if (!game?.name || !Array.isArray(game.keywords)) continue;
    if (game.keywords.some((kw) => hay.some((h) => h.includes(String(kw).toLowerCase())))) {
      return game.name;
    }
  }
  return null;
}

/** 深夜窗口判定（"HH:MM"）：支持跨零点（23:00–03:00），start==end 视为永不。 */
export function withinNightWindow(now, nightStart, nightEnd) {
  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = toMin(nightStart);
  const end = toMin(nightEnd);
  if (start === null || end === null || start === end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return start > end ? t >= start || t < end : t >= start && t < end;
}

/**
 * 深夜催睡判定。全部条件与门：
 * 有游戏 + 在深夜窗口 + 连跑够分钟数 + 人还在（键鼠空闲没超豁免线） + 账本没到上限 + 距上次开口够间隔。
 */
export function decideNightNag({ now, matchedGame, streakMinutes, idleSec, ledger, config }) {
  const cfg = config ?? {};
  if (!matchedGame) return { fire: false, reason: "no-game" };
  if (!withinNightWindow(now, cfg.nightStart ?? NIGHT_START_DEFAULT, cfg.nightEnd ?? NIGHT_END_DEFAULT)) {
    return { fire: false, reason: "not-night" };
  }
  if (!(streakMinutes >= (cfg.minRunMinutes ?? 20))) return { fire: false, reason: "streak-short" };
  if (idleSec >= (cfg.idleExemptMinutes ?? 40) * 60) return { fire: false, reason: "idle-exempt" };
  const nags = Array.isArray(ledger?.nags) ? ledger.nags : [];
  if (nags.length >= (cfg.maxNags ?? 2)) return { fire: false, reason: "max-nags" };
  const last = ledger?.lastNagAt ? new Date(ledger.lastNagAt).getTime() : 0;
  if (last && now.getTime() - last < (cfg.nagGapMinutes ?? 30) * 60000) return { fire: false, reason: "gap-wait" };
  return { fire: true, reason: "night-nag", count: nags.length + 1 };
}

/** 组她开口用的提示词：事实全带上，纪律写死（一次 message、发完只回「已催」、禁 exec）。 */
export function buildNagPrompt({ count, game, minutes, title, idleSec, qqTarget, channel, isTest }) {
  const head = isTest ? "【催睡链路验收】" : `【深夜催睡·第${count}次】`;
  return [
    `${head}现在是 ${new Date().toLocaleString("zh-CN", { hour12: false })}。哨兵看到主人（轩瑜）电脑上《${game}》已经连续开着约 ${minutes} 分钟，前台窗口是「${title}」，键鼠空闲 ${idleSec} 秒。`,
    `请用你自己的语气，用 message 工具发一条 QQ 催主人去睡觉：target='${qqTarget}'，channel='${channel}'。口吻：心疼他熬这么晚，带点娇嗔，像对象深夜查房——温柔里带认真，该催还是催。分寸：最多两句，温度点到为止，别说教、不吃醋、别腻。${count >= 2 ? "这是第2次催了，可以更不客气一点，但凶里还是带着心疼。" : ""}`,
    "发送成功收到工具结果后，最终回复只写：已催。纪律：message 只许调用一次；禁止 exec；禁止复述正文。",
  ].join("\n");
}

// ---------- 采集与快照 ----------

/**
 * 一次 PowerShell 拿全部采集项：前台窗口标题/前台进程/键鼠空闲秒数/全进程名清单。
 * 全部走 execFile 数组参数（不经 shell、无字符串拼接）；空闲用 [Environment]::TickCount 防 Get-Date 无此属性。
 */
async function probe() {
  const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$sig = @"
using System;using System.Runtime.InteropServices;using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
}
"@
Add-Type -TypeDefinition $sig
$h = [W]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[W]::GetWindowText($h, $sb, 512) | Out-Null
$pidOut = 0
[W]::GetWindowThreadProcessId($h, [ref]$pidOut) | Out-Null
$fgProc = ""
try { $fgProc = (Get-Process -Id $pidOut -ErrorAction Stop).ProcessName } catch {}
$lii = New-Object W+LASTINPUTINFO
$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
[W]::GetLastInputInfo([ref]$lii) | Out-Null
$idleSec = [math]::Round(([Environment]::TickCount - [int64]$lii.dwTime) / 1000)
if ($idleSec -lt 0) { $idleSec = 0 }
$procs = @(Get-Process | Select-Object -ExpandProperty ProcessName -Unique)
[pscustomobject]@{ fgTitle=$sb.ToString(); fgProc=$fgProc; fgPid=$pidOut; idleSec=$idleSec; procs=$procs } | ConvertTo-Json -Compress -Depth 3`;
  const { stdout } = await execFileP(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { timeout: PS_TIMEOUT_MS, windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim());
}

/** 快照写盘（.health/ 已 gitignore，窗口标题不出机器）。 */
function saveSnapshot({ fg, idleSec, procs, gameWatch, lastNight, error }) {
  fs.mkdirSync(HEALTH_DIR, { recursive: true });
  writeJsonAtomic(SNAPSHOT_FILE, {
    version: 1,
    at: new Date().toISOString(),
    atLocal: new Date().toLocaleString("zh-CN", { hour12: false }),
    foreground: fg ? { title: String(fg.fgTitle ?? ""), process: String(fg.fgProc ?? "") } : null,
    processes: procs,
    idleSeconds: idleSec,
    gameWatch: gameWatch ?? null,
    lastNight: lastNight ?? null,
    error: error ?? null,
  });
}

// ---------- 状态与账本 ----------

function loadState() {
  return (
    readJson(STATE_FILE) ?? {
      dateKey: "",
      streaks: {},
      ledger: { dateKey: "", nags: [], lastNagAt: null },
      lastNight: null,
      lastWake: null,
      lastError: null,
    }
  );
}

/** 状态写盘（原子写，先建目录）。 */
function saveState(state) {
  fs.mkdirSync(HEALTH_DIR, { recursive: true });
  writeJsonAtomic(STATE_FILE, state);
}

/** 本地日期键 "YYYY-MM-DD"。 */
function localDateKey(now) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 日切：跨天时昨日账本封账进 lastNight（供早晚问候「记仇线」读），账本清零。
 * 游戏连跑计时跨天保留——游戏没关就继续算。
 */
function rolloverIfNeeded(state, now) {
  const key = localDateKey(now);
  if (state.dateKey === key) return false;
  const nags = Array.isArray(state.ledger?.nags) ? state.ledger.nags : [];
  state.lastNight = nags.length > 0 ? { date: state.ledger.dateKey, nagCount: nags.length, games: [...new Set(nags.map((n) => n.game))] } : null;
  state.ledger = { dateKey: key, nags: [] };
  state.ledger.lastNagAt = null;
  state.dateKey = key;
  return true;
}

/** 游戏连跑计时：命中→无计时则从现在起算；未命中→清该游戏计时（进程消失=真关了）。 */
function updateStreaks(state, matched, now) {
  for (const name of Object.keys(state.streaks)) {
    if (name !== matched) delete state.streaks[name];
  }
  if (matched && !state.streaks[matched]) state.streaks[matched] = now.toISOString();
}

/** 记账（开口前先落账，物理防下一分钟重复触发）。 */
function recordNag(state, { game, at }) {
  state.ledger.nags.push({ at: at.toISOString(), game });
  state.ledger.lastNagAt = at.toISOString();
}

// ---------- 开口（拉起 main 一轮） ----------

/**
 * 拉人：读私有配置组提示词，detached 拉起 CLI 一轮（不等结果、立即返回，主流程不阻塞）。
 * 账本已由调用方先落账——本函数即使失败也不重试，下一分钟规则判定自然兜底。
 */
function wakeMain({ game, minutes, title, idleSec, count, isTest }) {
  const priv = readJson(PRIVATE_FILE);
  if (!priv?.qqTarget || !priv?.channel) {
    return { ok: false, error: "私有配置缺失或没有 qqTarget/channel（owner-watch.json），只记档不开口" };
  }
  const prompt = buildNagPrompt({ count, game, minutes, title, idleSec, qqTarget: priv.qqTarget, channel: priv.channel, isTest });
  const mjs = process.env.OPENCLAW_MJS || "C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs";
  const timeout = priv.timeoutSeconds ?? 240;
  const child = spawn(
    process.execPath,
    [mjs, "agent", "--agent", priv.agent ?? "main", "--session-key", priv.sessionKey ?? "main:owner-watch", "--message", prompt, "--json", "--timeout", String(timeout)],
    { env: { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR }, detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  return { ok: true };
}

// ---------- 主流程 ----------

async function main() {
  const args = new Set(process.argv.slice(2));
  const isTest = args.has("--test");
  const isDry = args.has("--dry-run");
  const now = new Date();

  const config = readJson(CONFIG_FILE);
  const state = loadState();
  rolloverIfNeeded(state, now);

  let probeData = null;
  let probeError = null;
  try {
    probeData = await probe();
  } catch (e) {
    probeError = String(e?.message ?? e);
  }

  const matched = probeData ? matchGame(config?.games ?? [], probeData) : null;
  if (probeData) updateStreaks(state, matched, now);

  const since = matched ? state.streaks[matched] : null;
  const minutes = since ? Math.max(1, Math.round((Date.now() - new Date(since).getTime()) / 60000)) : 0;

  let decision;
  if (!config) decision = { fire: false, reason: "no-config" };
  else if (!probeData) decision = { fire: false, reason: "probe-failed" };
  else {
    decision = decideNightNag({ now, matchedGame: matched, streakMinutes: minutes, idleSec: probeData.idleSec, ledger: state.ledger, config });
  }
  if (isTest) decision = { fire: true, reason: "test", count: (state.ledger?.nags?.length ?? 0) + 1 };

  if (decision.fire && !isDry) {
    const at = new Date();
    if (!isTest) {
      recordNag(state, { game: matched ?? "(未知游戏)", at });
      state.lastWake = { at: at.toISOString(), game: matched ?? "(未知游戏)", count: decision.count, mode: "live" };
      saveState(state);
    } else {
      state.lastWake = { at: at.toISOString(), game: matched ?? "(样例)", count: decision.count, mode: "test" };
      saveState(state);
    }
    const woken = wakeMain({
      game: matched ?? "(样例)",
      minutes: minutes || 999,
      title: probeData?.fgTitle || "(未知)",
      idleSec: probeData?.idleSec ?? 0,
      count: decision.count,
      isTest,
    });
    if (!woken.ok) {
      state.lastError = { at: at.toISOString(), where: "wakeMain", message: woken.error };
      saveState(state);
    }
  } else if (isDry) {
    console.log("[owner-status] dry-run 判定：", JSON.stringify({ ...decision, matched, minutes, idleSec: probeData?.idleSec ?? null }));
  }

  saveSnapshot({
    fg: probeData,
    idleSec: probeData?.idleSec ?? null,
    procs: probeData?.procs ?? [],
    gameWatch: matched ? { name: matched, since, runningMinutes: minutes } : null,
    lastNight: state.lastNight,
    error: probeError,
  });
  console.log(`[owner-status] ${new Date().toLocaleString("zh-CN", { hour12: false })} 判定=${decision.reason} 游戏=${matched ?? "无"} 连跑=${minutes}分 空闲=${probeData?.idleSec ?? "?"}秒`);
}

const isMain = process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  main().catch((e) => {
    console.error("[owner-status] 本轮失败：", e?.message ?? e);
  });
}
