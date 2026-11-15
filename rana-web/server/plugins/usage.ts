// 「📊 用量」页后端：/__rana/usage —— 跨会话 token 用量账本。
// 数据源：各 agent 库（agents/<id>/agent/openclaw-agent.sqlite）的 trajectory_runtime_events，
// 每轮 run 恰一条 model.completed 事件带 usage；模型名按 runId 关联同 run 的 prompt.submitted 等事件。
// 账本（.health/usage-ledger.json）负责把用量历史留在自家地盘——会话被清理/归档后历史不蒸发。
// 纯聚合规则在 ../lib/usage-aggregate.ts（配单测），本文件只留 I/O、路由与账本调度。

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { STATE_HOME, OPENCLAW_CONFIG, RANA_WEB } from "../lib/paths";
import { json, isLoopback } from "../lib/http";
import { readJson, writeJsonAtomic } from "../lib/fs-json";
import { readLedger, writeLedger, emptyLedger } from "../lib/usage-ledger";
import { defineRanaPlugin } from "../lib/rana-plugin";
import type { UsageLedger } from "../lib/usage-ledger";
import {
  parseRuntimeEvents,
  aggregateParsedEvents,
  mergeDayBuckets,
  mergeSessionBuckets,
} from "../lib/usage-aggregate";
import type { ParsedUsageEvent, RuntimeEventRow } from "../lib/usage-aggregate";

// ===== 常量 =====
/** 模型归属宽限窗：增量补账时回看这么久的事件来补 runId→模型映射（run 最长约 15 分钟） */
const MODEL_GRACE_MS = 30 * 60 * 1000;
/** 增量补账节流：页面开着时最勤也 30 秒摸一次库 */
const CATCHUP_THROTTLE_MS = 30_000;
/** 会话卡片上限（超出按 total token 保留头部，防账本无限膨胀） */
const SESSION_CAP = 300;
/** 重建进度落盘位置（.health/ 已 gitignore） */
const PROGRESS_FILE = path.join(RANA_WEB, ".health", "usage-rebuild.json");

// ===== agent 库清单与扫描 =====

interface AgentDbRef {
  id: string;
  name: string;
  dbPath: string;
}

/** 列出有 agent 库的 agent：扫 STATE_HOME/agents 目录 + 从 openclaw.json 取显示名（agents.ts 同款） */
function listAgentDbs(): AgentDbRef[] {
  const agentsDir = path.join(STATE_HOME, "agents");
  let cfg: { agents?: { entries?: Record<string, { name?: string }> } } = {};
  try {
    cfg = readJson(OPENCLAW_CONFIG, {} as typeof cfg);
  } catch {
    // 配置读不到就用目录名当显示名
  }
  const out: AgentDbRef[] = [];
  try {
    for (const id of readdirSync(agentsDir)) {
      const dbPath = path.join(agentsDir, id, "agent", "openclaw-agent.sqlite");
      if (!existsSync(dbPath)) continue;
      out.push({ id, name: cfg.agents?.entries?.[id]?.name ?? id, dbPath });
    }
  } catch {
    // agents 目录不存在（发行版首次启动）→ 空清单
  }
  return out;
}

/** 读会话名映射（session_key → label ?? display_name），会话卡显示用 */
function loadSessionLabels(db: DatabaseSync): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const rows = db
      .prepare("SELECT session_key, label, display_name FROM session_nodes")
      .all() as Array<{ session_key: string; label: string | null; display_name: string | null }>;
    for (const r of rows) {
      const label = r.label || r.display_name || "";
      if (r.session_key && label) out[r.session_key] = label;
    }
  } catch {
    // 标签刷不动不致命
  }
  return out;
}

/** 单库扫描：sinceMs=0 全量（建账用），否则只取 created_at > sinceMs 的行（增量补账用）。
 *  返回解析后的事件 + 会话名映射；只读连接，库被网关占用也安全（approvals.ts 同款）。 */
function scanAgentDb(
  agentId: string,
  dbPath: string,
  sinceMs: number,
): { events: ParsedUsageEvent[]; labels: Record<string, string> } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sql = sinceMs > 0
      ? "SELECT run_id, event_json, created_at FROM trajectory_runtime_events WHERE created_at > ? ORDER BY created_at ASC"
      : "SELECT run_id, event_json, created_at FROM trajectory_runtime_events ORDER BY created_at ASC";
    const rows = sinceMs > 0
      ? db.prepare(sql).all(sinceMs)
      : db.prepare(sql).all();
    const events = parseRuntimeEvents(agentId, rows as RuntimeEventRow[]);
    return { events, labels: loadSessionLabels(db) };
  } finally {
    db.close();
  }
}

// ===== 重建与增量补账（中间件进程内调度） =====

/** 重建状态（进程内存活；进度同步落盘 .health/usage-rebuild.json 留痕） */
let rebuilding = false;
let progress: { phase: string; agentId: string; rowsDone: number; rowsTotal: number; startedAt: string; error?: string } | null = null;
let lastCatchupAt = 0;

function writeProgressFile(): void {
  try {
    writeJsonAtomic(PROGRESS_FILE, progress ?? { phase: "idle", agentId: "", rowsDone: 0, rowsTotal: 0, startedAt: "" });
  } catch {
    // 进度留痕失败不致命
  }
}

/** applyLabels：把标签映射刷进账本里该 agent 的会话桶 */
function applyLabels(ledger: UsageLedger, agentId: string, labels: Record<string, string>): void {
  for (const [key, s] of Object.entries(ledger.sessions)) {
    if (s.agentId !== agentId) continue;
    const l = labels[key];
    if (l && l !== s.label) s.label = l;
  }
}

/** 全量建账：清空重扫三个 agent 库，重写账本（后台异步，进度落盘） */
function startRebuild(): void {
  if (rebuilding) return;
  rebuilding = true;
  progress = { phase: "listing", agentId: "", rowsDone: 0, rowsTotal: 0, startedAt: new Date().toISOString() };
  writeProgressFile();
  void (async () => {
    try {
      const dbs = listAgentDbs();
      // 预数总行数给进度条用（COUNT(*) 很便宜）
      let rowsTotal = 0;
      const counts = new Map<string, number>();
      for (const ref of dbs) {
        try {
          const db = new DatabaseSync(ref.dbPath, { readOnly: true });
          const c = db.prepare("SELECT COUNT(*) n FROM trajectory_runtime_events").get() as { n: number };
          db.close();
          counts.set(ref.id, Number(c.n));
          rowsTotal += Number(c.n);
        } catch {
          counts.set(ref.id, 0);
        }
      }
      progress = { ...progress!, phase: "scanning", rowsTotal };
      const ledger = emptyLedger();
      for (const ref of dbs) {
        progress = { ...progress!, agentId: ref.name, rowsDone: progress!.rowsDone };
        writeProgressFile();
        const { events, labels } = scanAgentDb(ref.id, ref.dbPath, 0);
        const { days, sessions } = aggregateParsedEvents(events);
        mergeDayBuckets(ledger.days, days);
        mergeSessionBuckets(ledger.sessions, sessions);
        applyLabels(ledger, ref.id, labels);
        const usageTs = events.filter((e) => e.usage).map((e) => e.tsMs);
        ledger.agents[ref.id] = { lastEventTs: usageTs.length ? Math.max(...usageTs) : 0 };
        progress = { ...progress!, rowsDone: progress!.rowsDone + events.length };
      }
      ledger.built = true;
      writeLedger(ledger);
      progress = { ...progress!, phase: "done" };
    } catch (e) {
      progress = { ...progress!, phase: "error", error: String((e as Error).message || e) };
    } finally {
      writeProgressFile();
      rebuilding = false;
    }
  })();
}

/** 增量补账：只扫各库水位之后的事件并并入账本（节流 30s，页面开着才跑）。
 *  回看 30 分钟宽限窗补 runId→模型映射（长 run 的 prompt.submitted 可能落在水位之前）。 */
function catchUp(ledger: UsageLedger): boolean {
  let any = false;
  const dbs = listAgentDbs();
  for (const ref of dbs) {
    try {
      const since = Math.max(0, (ledger.agents[ref.id]?.lastEventTs ?? 0) - MODEL_GRACE_MS);
      const { events, labels } = scanAgentDb(ref.id, ref.dbPath, since);
      // 只把「水位之后」的 usage 事件计入账本（宽限窗里的老行只用于补模型归属，不重复计数）
      const fresh = events.filter((e) => e.usage && e.tsMs > (ledger.agents[ref.id]?.lastEventTs ?? 0));
      if (fresh.length === 0) {
        applyLabels(ledger, ref.id, labels);
        continue;
      }
      const { days, sessions } = aggregateParsedEvents(fresh);
      mergeDayBuckets(ledger.days, days);
      mergeSessionBuckets(ledger.sessions, sessions);
      applyLabels(ledger, ref.id, labels);
      const newWatermark = Math.max(...fresh.map((e) => e.tsMs));
      ledger.agents[ref.id] = { lastEventTs: Math.max(ledger.agents[ref.id]?.lastEventTs ?? 0, newWatermark) };
      any = true;
    } catch {
      // 单库失败不拖垮整页
    }
  }
  return any;
}

// ===== 路由与载荷 =====

/** 账本 → 页面载荷：days 日期升序、sessions 按 total 降序截头部、agent 清单=目录∪配置名 */
function buildPayload(ledger: UsageLedger) {
  const dbs = listAgentDbs();
  const names = new Map(dbs.map((d) => [d.id, d.name]));
  const days = Object.entries(ledger.days)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, agents]) => ({ date, agents }));
  const sessions = Object.entries(ledger.sessions)
    .map(([key, s]) => ({ key, ...s }))
    .sort((a, b) => b.total - a.total)
    .slice(0, SESSION_CAP);
  const lastEventTs = Math.max(0, ...Object.values(ledger.agents).map((a) => a.lastEventTs));
  return { ok: true, rebuilding: false, updatedAt: ledger.builtAt, lastEventTs, agents: [...names].map(([id, name]) => ({ id, name })), days, sessions };
}

type UsageReq = { method?: string; url?: string; socket?: { remoteAddress?: string }; headers?: Record<string, unknown> };
type UsageRes = { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void };

/** 统一入口：GET /__rana/usage（页面载荷）与 POST /__rana/usage/rebuild（后台全量建账） */
async function usageHandler(req: UsageReq, res: UsageRes): Promise<void> {
  if (!isLoopback(req)) return void json(res, 403, { ok: false, error: "仅本机可查" });
  const url = new URL(req.url ?? "/", "http://local");
  const method = req.method ?? "GET";
  if (method === "POST" && url.pathname === "/rebuild") {
    if (rebuilding) return void json(res, 409, { ok: false, error: "重建已在进行" });
    startRebuild();
    return void json(res, 202, { ok: true, rebuilding: true });
  }
  if (method !== "GET") return void json(res, 405, { ok: false, error: "method not allowed" });
  if (rebuilding) return void json(res, 200, { ok: true, rebuilding: true, progress });
  const ledger = readLedger();
  if (!ledger.built) {
    startRebuild();
    return void json(res, 200, { ok: true, rebuilding: true, progress });
  }
  let changed = false;
  if (Date.now() - lastCatchupAt > CATCHUP_THROTTLE_MS) {
    lastCatchupAt = Date.now();
    try {
      changed = catchUp(ledger);
    } catch {
      // 补账失败不阻塞页面显示
    }
  }
  if (changed) writeLedger(ledger);
  return void json(res, 200, buildPayload(ledger));
}

// ===== 插件注册 =====

export function ranaUsageMiddleware() {
  const handler = (req: UsageReq, res: UsageRes): void => {
    usageHandler(req, res).catch(() => {
      try { json(res, 500, { ok: false, error: "usage 中间件异常" }); } catch { /* 已响应则忽略 */ }
    });
  };
  return defineRanaPlugin({
    name: "rana-usage",
    routes: { "/__rana/usage": handler },
  });
}
