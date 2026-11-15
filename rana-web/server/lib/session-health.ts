/**
 * session-health.ts — 会话健康哨兵（2026-11-15 状态页新卡「🩺 会话健康哨兵」）
 *
 * 数据源：各 agent 库（STATE_HOME/agents/<id>/agent/openclaw-agent.sqlite）的
 * session_windows 表（11-14 draining 手术动过的就是它）——每会话窗口一行，status 记窗口终态。
 * 2026-11-15 四库实查：status 有效值 = done / failed / timeout / running / killed / null；
 * created_at / updated_at / ended_at 均为 epoch 毫秒；同 session_key 可有多代窗口
 * （每代重建新窗口，created_at 大者为最新）。
 *
 * 灯口径（2026-11-15 主人真数据拍板修正）：**每 session_key 取最新窗口判定健康**——
 * 最新窗口 status='failed' 才算「真坏死」（消息会 draining 超时那种病）；
 * 被新窗口顶掉的老 failed 是已愈合的伤疤，不算病（不然历史累计会出 30 个假警报）。
 * timeout/killed 是自动化任务的正常异常终态，也不算红。
 *
 * 纪律：
 * - 只读！DatabaseSync readOnly 打开（approvals → session-edit → usage 先例链），
 *   网关 WAL 占用不冲突；库打不开 / 表不存在 = 该 agent 降级 unknown，不炸。
 * - 纯函数（aggregateSessionWindows / buildSessionHealth）零 I/O 可直测；
 *   单库查询（readAgentSessionWindows）接受 DatabaseSync 实例，测试用 :memory: 建 fixture 表。
 * - agent 库路径一律 STATE_HOME 拼接，不写死盘符（usage.ts listAgentDbs 同款思路）。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { STATE_HOME, OPENCLAW_CONFIG } from "./paths";
import { readJson } from "./fs-json";

/** 真坏死明细行（该 session_key 的最新窗口 failed） */
export interface SickSessionRow {
  sessionKey: string;
  /** 窗口 display_name（可空，前端展示美化用） */
  name: string | null;
  /** 该窗口的最近 failed 时间：updated_at 优先、ended_at 兜底（烂值=null） */
  lastFailedAt: number | null;
}

/** session_windows 行投影（列名=2026-11-15 main 库实查；rid=rowid，并列 created_at 时的兜底序） */
export interface SessionWindowRow {
  rid: number | null;
  session_key: string | null;
  status: string | null;
  created_at: number | null;
  updated_at: number | null;
  ended_at: number | null;
  display_name: string | null;
}

/** 单 agent 的会话健康统计（unknown=true = 库打不开/表缺失，降级观察不冤枉） */
export interface SessionHealthAgent {
  id: string;
  name: string;
  /** 窗口总行数（含历史代） */
  total: number;
  /** 真坏死：最新窗口 status='failed' 的不同 session_key 数 */
  sick: number;
  /** 历史 failed 已被新窗口顶掉的行数（伤疤；有才发，0 省略） */
  healedFailed?: number;
  /** 真坏死明细（时间降序，最多 20 条；有才发） */
  sickRows?: SickSessionRow[];
  /** 最新一条真坏死的时间/key/name（= sickRows[0]，无病时全 null） */
  lastFailedAt: number | null;
  lastFailedKey: string | null;
  lastFailedName: string | null;
  unknown?: boolean;
}

/** 状态页 sessionHealth 载荷：绿=全部健康 / 红=有窗口真坏死 / 灰=一个库都没读到 */
export interface SessionHealth {
  lamp: "green" | "red" | "gray";
  agents: SessionHealthAgent[];
  checkedAt: number;
}

/** 真坏死明细上限：防极端坏库时 payload 膨胀；前端展示近 20 条足够定位 */
const SICK_ROWS_CAP = 20;

/** 时间戳清洗：非正的有限数字一律当烂值（烂库/迁移残留可能出 0/负数/垃圾） */
function safeTs(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** 两行谁更新：created_at 大者赢；并列（含烂值）rowid 大者赢（插入晚=后建） */
function newerWindow(a: SessionWindowRow, b: SessionWindowRow): boolean {
  const ta = safeTs(a.created_at) ?? 0;
  const tb = safeTs(b.created_at) ?? 0;
  if (ta !== tb) return ta > tb;
  return (a.rid ?? 0) > (b.rid ?? 0);
}

/** unknown agent 工厂：库读不到时的降级形状（前端灰小灯） */
export function unknownAgent(id: string, name: string): SessionHealthAgent {
  return { id, name, total: 0, sick: 0, lastFailedAt: null, lastFailedKey: null, lastFailedName: null, unknown: true };
}

/** 行数组 → 单 agent 统计（纯函数，可直测）。
 *  每 session_key 取最新窗口（created_at 最大，并列 rowid 兜底）判定健康：
 *  最新窗口 failed = 真坏死（sick）；历史 failed 且不是最新 = 伤疤（healedFailed）。
 *  烂时间戳：sick 行时间 updated_at → ended_at 依次兜底，全烂=null（计数与 key 保留）。 */
export function aggregateSessionWindows(agentId: string, name: string, rows: SessionWindowRow[]): SessionHealthAgent {
  // 1. 按 key 分组取最新窗口（session_key 理论 NOT NULL；烂库 null 合并成一组，不炸为先）
  const latestByKey = new Map<string, SessionWindowRow>();
  for (const r of rows) {
    const key = r.session_key ?? "";
    const cur = latestByKey.get(key);
    if (!cur || newerWindow(r, cur)) latestByKey.set(key, r);
  }
  // 2. 数真坏死与伤疤：failed 行里「是最新窗口」的算病，「被顶掉」的算伤疤
  const latestSet = new Set(latestByKey.values());
  const sickRows: SickSessionRow[] = [];
  let healed = 0;
  for (const r of rows) {
    if (r.status !== "failed") continue;
    if (!latestSet.has(r)) {
      healed++;
      continue;
    }
    sickRows.push({
      sessionKey: r.session_key ?? "",
      name: r.display_name ?? null,
      lastFailedAt: safeTs(r.updated_at) ?? safeTs(r.ended_at),
    });
  }
  // 3. 明细按最近 failed 时间降序（烂时间沉底，sort 稳定保插入序），截头
  sickRows.sort((a, b) => (b.lastFailedAt ?? 0) - (a.lastFailedAt ?? 0));
  const top = sickRows.slice(0, SICK_ROWS_CAP);
  const agent: SessionHealthAgent = {
    id: agentId,
    name,
    total: rows.length,
    sick: sickRows.length,
    lastFailedAt: top[0]?.lastFailedAt ?? null,
    lastFailedKey: top[0]?.sessionKey ?? null,
    lastFailedName: top[0]?.name ?? null,
  };
  if (healed > 0) agent.healedFailed = healed;
  if (top.length > 0) agent.sickRows = top;
  return agent;
}

/** agent 统计数组 → 灯（纯函数，可直测）。
 *  一个库都没读到（空清单/全 unknown）= gray；已知库里任一 sick>0 = red；否则 green。
 *  排序：unknown 殿后；有病的在前按最近坏死时间降序（烂时间沉底）；其余保持清单原序。 */
export function buildSessionHealth(agents: SessionHealthAgent[], checkedAt: number = Date.now()): SessionHealth {
  const known = agents.filter((a) => !a.unknown);
  const lamp: SessionHealth["lamp"] = known.length === 0 ? "gray" : known.some((a) => a.sick > 0) ? "red" : "green";
  const sorted = [...agents].sort((a, b) => {
    const ua = a.unknown ? 1 : 0;
    const ub = b.unknown ? 1 : 0;
    if (ua !== ub) return ua - ub;
    const sa = !a.unknown && a.sick > 0 ? 1 : 0;
    const sb = !b.unknown && b.sick > 0 ? 1 : 0;
    if (sa !== sb) return sb - sa;
    if (sa === 1 && (a.lastFailedAt ?? 0) !== (b.lastFailedAt ?? 0)) return (b.lastFailedAt ?? 0) - (a.lastFailedAt ?? 0);
    return 0;
  });
  return { lamp, agents: sorted, checkedAt };
}

/** 单库读 session_windows 投影（只读；接受 DatabaseSync 实例以便 :memory: 直测）。
 *  rid=rowid 作窗口代际并列时的兜底序。表不存在 / SQL 报错 → null（上层转 unknown，不炸）。 */
export function readAgentSessionWindows(db: DatabaseSync): SessionWindowRow[] | null {
  try {
    return db
      .prepare("SELECT rowid AS rid, session_key, status, created_at, updated_at, ended_at, display_name FROM session_windows")
      .all() as unknown as SessionWindowRow[];
  } catch {
    return null;
  }
}

interface AgentDbRef {
  id: string;
  name: string;
  dbPath: string;
}

/** 列出有 agent 库的 agent：扫 STATE_HOME/agents 目录 + 从 openclaw.json 取显示名（usage.ts 同款思路） */
function listSessionAgentDbs(): AgentDbRef[] {
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

/** 收集全部 agent 的会话健康（I/O 层，sys-status 中间件调用；单库失败降级 unknown 不拖垮整页） */
export function collectSessionHealth(checkedAt: number = Date.now()): SessionHealth {
  const agents: SessionHealthAgent[] = [];
  for (const ref of listSessionAgentDbs()) {
    try {
      const db = new DatabaseSync(ref.dbPath, { readOnly: true });
      let agent: SessionHealthAgent;
      try {
        const rows = readAgentSessionWindows(db);
        agent = rows ? aggregateSessionWindows(ref.id, ref.name, rows) : unknownAgent(ref.id, ref.name);
      } finally {
        db.close();
      }
      agents.push(agent);
    } catch {
      // 库打不开（文件消失/损坏等）：unknown 降级，不炸
      agents.push(unknownAgent(ref.id, ref.name));
    }
  }
  return buildSessionHealth(agents, checkedAt);
}
