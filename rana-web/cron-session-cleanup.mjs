#!/usr/bin/env node
/**
 * cron-session-cleanup.mjs — 一键清理心跳/梦境等定时任务留下的"删不掉"会话
 *
 * 背景（KNOWN-ISSUES.md「Automation 会话删不掉」条目）：
 * - 心跳（isolatedSession:true）与 memory-dreaming 等 cron 任务每次执行开全新会话；
 * - run 级会话（key 含 ":run:"）网关删除接口不认（上游限制，只能靠 UI 隐藏兜底）；
 * - 父会话被 state 库 worker_session_placements 表的残留行（terminal_reason=NULL）
 *   卡住"安全停止"校验，sessions.delete 永远报 did not finish stopping。
 *
 * 手术流程（沿用 KNOWN-ISSUES 已人工验证过的步骤）：
 *   停网关 → 备份 SQLite → 清 placement 残留行 → 重启网关 → CLI 删 cron 父会话。
 * 手术面严格限定：state 库只 DELETE worker_session_placements 里 key 含 ":cron:" 的行；
 * 会话删除走官方 CLI（sessions delete --yes），不直接动 agent 库。
 *
 * 用法：
 *   node cron-session-cleanup.mjs            # 真跑（会停止并重启网关，约 30-60 秒）
 *   node cron-session-cleanup.mjs --dry-run  # 只盘点不动刀：列出将删的父会话与残留行数
 *
 * 进度落盘 %TEMP%\openclaw\cron-session-cleanup.json（running/step/log/result），
 * 界面入口（会话页左下角「🧹 清理系统会话」）经 /__rana/sessions-cleanup 读这份文件展示进度。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { STATE_HOME } from "./lib/rana-config.mjs";

/** openclaw CLI 入口（与 vite.config.ts / start-gateway.cmd 同源的绝对路径） */
const OPENCLAW_MJS = "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs";
const GATEWAY_PORT = 18789;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const START_GATEWAY = path.join(SCRIPT_DIR, "start-gateway.cmd");
const STATE_DB = path.join(STATE_HOME, "state", "openclaw.sqlite");
const AGENTS_DIR = path.join(STATE_HOME, "agents");
const STATUS_FILE = path.join(os.tmpdir(), "openclaw", "cron-session-cleanup.json");

const DRY_RUN = process.argv.includes("--dry-run");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 进度状态 ----------

let status = {
  running: true,
  dryRun: DRY_RUN,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  step: "init",
  log: [],
  result: null,
  error: null,
};

function writeStatus() {
  status.updatedAt = Date.now();
  const dir = path.dirname(STATUS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
  fs.renameSync(tmp, STATUS_FILE);
}

function logStep(step, msg) {
  status.step = step;
  if (msg) status.log.push({ t: new Date().toISOString().slice(11, 19), msg });
  writeStatus();
  console.log(`[${step}] ${msg ?? ""}`);
}

// 心跳保活：脚本卡在某一步时，中间件靠 updatedAt 判定"陈旧锁"而不是永远拒绝新任务
const keepalive = setInterval(() => {
  if (!status.running) return;
  writeStatus();
}, 10_000);

// ---------- 盘点（只读） ----------

/** 各 agent 库里 key 含 :cron: 的父会话（不含 :run: 子会话），外加 heartbeat 会话 */
function listParentSessions() {
  const out = [];
  let agents;
  try {
    agents = fs.readdirSync(AGENTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  for (const ent of agents) {
    const dbPath = path.join(AGENTS_DIR, ent.name, "agent", "openclaw-agent.sqlite");
    if (!fs.existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT session_key FROM session_nodes " +
            "WHERE (session_key LIKE '%:cron:%' OR session_key LIKE '%:heartbeat%') " +
            "AND session_key NOT LIKE '%:run:%'",
        )
        .all();
      for (const r of rows) out.push({ agentId: ent.name, key: r.session_key });
    } finally {
      db.close();
    }
  }
  return out;
}

function countPlacementResidue() {
  const db = new DatabaseSync(STATE_DB, { readOnly: true });
  try {
    return db
      .prepare("SELECT COUNT(*) n FROM worker_session_placements WHERE session_key LIKE '%:cron:%'")
      .get().n;
  } finally {
    db.close();
  }
}

// ---------- 网关进程控制 ----------

/** 找监听 18789 的 PID（netstat 解析；找不到返回空数组） */
async function findGatewayPids() {
  const { stdout } = await execFileP("netstat", ["-ano"]);
  // 注意：正则字面量不做变量插值，端口必须拼进 RegExp
  const portRe = new RegExp(`:${GATEWAY_PORT}\\s`);
  const pids = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!portRe.test(line) || !/LISTENING/i.test(line)) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid)) pids.add(pid);
  }
  return [...pids];
}

async function isGatewayUp() {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: GATEWAY_PORT });
    let settled = false;
    const finish = (up) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(up);
    };
    s.setTimeout(1500, () => finish(false));
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
  });
}

async function stopGateway() {
  const pids = await findGatewayPids();
  if (pids.length === 0) {
    status.log.push({ t: new Date().toISOString().slice(11, 19), msg: "  ↳ netstat 未找到监听 PID（端口可能没开）" });
    writeStatus();
    return false;
  }
  for (const pid of pids) {
    try {
      await execFileP("taskkill", ["/PID", pid, "/F", "/T"]);
    } catch (e) {
      const msg = String(e.stderr || e.message || "").trim().split(/\r?\n/)[0];
      status.log.push({ t: new Date().toISOString().slice(11, 19), msg: `  ↳ taskkill ${pid} 失败：${msg}` });
      writeStatus();
    }
  }
  for (let i = 0; i < 40; i++) {
    if (!(await isGatewayUp())) break;
    await sleep(500);
  }
  await sleep(1500); // 文件句柄释放的余量
  return true;
}

/** 最小化窗口里重跑 start-gateway.cmd（与人工运维动作一致，用户仍可在任务栏看到并管理它） */
function restartGateway() {
  spawn("cmd.exe", ["/c", "start", "", "/MIN", START_GATEWAY], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

async function waitGatewayReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isGatewayUp()) return true;
    await sleep(1000);
  }
  return false;
}

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout, stderr });
    });
  });
}

// ---------- 备份 ----------

/** 连同 -wal/-shm 一起拷（硬杀后的 WAL 只有配套拷贝才完整） */
function backupFile(file, backups) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = file + suffix;
    if (!fs.existsSync(src)) continue;
    const dst = `${src}.bak-cleanup-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
    fs.copyFileSync(src, dst);
    backups.push(dst);
  }
}

// ---------- 主流程 ----------

async function main() {
  if (!fs.existsSync(STATE_DB)) throw new Error(`找不到状态库：${STATE_DB}`);

  logStep("scan", "盘点 cron 父会话与 placement 残留…");
  const parents = listParentSessions();
  const placementRows = countPlacementResidue();
  const gatewayWasRunning = await isGatewayUp();
  const plan = {
    parents,
    placementRows,
    gatewayWasRunning,
    parentCount: parents.length,
  };
  status.result = { ...plan };
  writeStatus();

  if (DRY_RUN) {
    logStep(
      "dry-run",
      `预览：待删父会话 ${parents.length} 个（心跳/梦境等定时任务的会话），placement 残留 ${placementRows} 行。未做任何改动。`,
    );
    status.running = false;
    writeStatus();
    return;
  }
  if (parents.length === 0 && placementRows === 0) {
    logStep("noop", "没有需要清理的对象，收工。");
    status.running = false;
    writeStatus();
    return;
  }

  const backups = [];
  const failedParents = [];
  let placementDeleted = 0;
  let gatewayRestarted = false;

  logStep("stop-gateway", gatewayWasRunning ? "停止网关…" : "网关未在运行，跳过停止。");
  if (gatewayWasRunning) await stopGateway();

  logStep("backup", "备份 SQLite（state 库 + 涉及的 agent 库）…");
  backupFile(STATE_DB, backups);
  const touchedAgents = new Set(parents.map((p) => p.agentId));
  for (const agentId of touchedAgents) {
    backupFile(path.join(AGENTS_DIR, agentId, "agent", "openclaw-agent.sqlite"), backups);
  }

  if (placementRows > 0) {
    logStep("surgery", `清除 worker_session_placements 残留 ${placementRows} 行…`);
    const db = new DatabaseSync(STATE_DB); // 读写打开，触发 WAL 恢复
    try {
      // 参数绑定；DatabaseSync 没有顶层 run()，必须 prepare().run()
      const r = db.prepare("DELETE FROM worker_session_placements WHERE session_key LIKE ?").run("%:cron:%");
      placementDeleted = Number(r.changes ?? 0);
    } finally {
      db.close();
    }
  }

  logStep("restart-gateway", "重启网关（最小化窗口）…");
  restartGateway();
  gatewayRestarted = await waitGatewayReady(90_000);
  if (!gatewayRestarted) {
    throw new Error("网关 90 秒内未在 18789 端口就绪；数据库手术已完成，请手动运行 start-gateway.cmd 后再试一次（会话删除可安全重跑）");
  }
  await sleep(3000); // 端口通了再给网关 3 秒初始化

  let deleted = 0;
  for (const [i, p] of parents.entries()) {
    logStep("delete", `[${i + 1}/${parents.length}] 删除 ${p.key}`);
    try {
      await execFileP(process.execPath, [OPENCLAW_MJS, "sessions", "delete", p.key, "--agent", p.agentId, "--yes"], {
        timeout: 90_000,
        env: { ...process.env, OPENCLAW_STATE_DIR: STATE_HOME },
      });
      deleted++;
    } catch (e) {
      const msg = String(e.stderr || e.message || "").trim().split(/\r?\n/).slice(-1)[0];
      failedParents.push({ key: p.key, error: msg });
      status.log.push({ t: new Date().toISOString().slice(11, 19), msg: `  ↳ 失败：${msg}` });
      writeStatus();
    }
  }

  status.result = {
    ...plan,
    placementDeleted,
    parentsDeleted: deleted,
    parentsFailed: failedParents,
    backups,
    gatewayRestarted,
  };
  logStep("done", `完成：清残留 ${placementDeleted} 行，删父会话 ${deleted}/${parents.length} 个${failedParents.length ? `，失败 ${failedParents.length} 个` : ""}。run 级残留会话属上游限制，界面默认已隐藏。`);
  status.running = false;
  writeStatus();
}

main()
  .catch((e) => {
    status.error = String(e?.message ?? e);
    status.log.push({ t: new Date().toISOString().slice(11, 19), msg: `✗ 出错：${status.error}` });
    status.running = false;
    writeStatus();
    console.error(status.error);
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepalive));
