/**
 * 「🔎 历史对话全文搜索」核心逻辑——跨 agent 库搜 transcript_events 的 message 正文。
 *
 * 为什么抽这个文件：搜索链路的「校验 / 转义 / 抽正文 / 切 snippet / 合并截断」都是纯逻辑，
 * 抽出来配 vitest 直测（tests/unit/memorySearch.test.ts，in-memory sqlite 灌 fixture），
 * 中间件（../plugins/memory.ts 的 GET /search 路由）只留路由与 I/O。
 *
 * 数据形态（2026-11-15 node:sqlite 只读实查 main 库，PROJECT-MAP §8.1 同源）：
 * - transcript_events：一行一事件，event_json(TEXT) 或 event_zstd(BLOB) 二选一；
 *   **本搜索只碰 event_json（SQL WHERE event_json IS NOT NULL 天然排除 zstd 行）**，
 *   深档案不含（UI 有注明）。node:zstd 跨版本不可靠（CI 是 Node 22），一律不解 zstd。
 * - message 事件：{ type:"message", id(UUID), parentId, timestamp, message:{ role, content } }。
 *   timestamp 实查是 ISO 字符串（"2026-09-07T17:23:49.716Z"），但按两种形态容错（ISO 串 / 毫秒数字）。
 * - 排序锚用表列 created_at（epoch 毫秒，与事件 ts 同毫秒——实查对齐），事件 ts 缺失时兜底。
 * - 会话归属：事件 JSON 里**没有** sessionKey 字段，但表列 session_id 可经
 *   session_nodes.current_session_id 反查出 session_key（如 "agent:main:main"）——
 *   LEFT JOIN 一次带出来，映射不到就 sessionKey 缺席（前端跳转按钮置灰）。
 * - role 分布（实查 main）：assistant 10270 / toolResult 4579 / user 3536 / custom 428。
 *   toolResult 是工具输出（JSON/日志噪音大）、custom 是系统便签——**只搜 user/assistant 正文**。
 * - 性能实测：main 库 3.1 万行 LIKE 全表扫描 ~90ms，仍设 scanRowCap（20 万行）兜底，
 *   超限提前停扫并标 partial（部分结果）。
 *
 * 安全：q 只在内存里用，不落盘、不进日志；本模块全程只读。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STATE_HOME, OPENCLAW_CONFIG } from "./paths";
import { readJson } from "./fs-json";

// ---------- 类型 ----------

/** 一条搜索命中（sessionKey 映射不到就缺席——诚实降级，不猜） */
export interface MemorySearchHit {
  agentId: string;
  agentName?: string;
  /** 会话 key（session_nodes 反查得到才有）；前端拿它跳聊天页 */
  sessionKey?: string;
  sessionId?: string;
  /** epoch 毫秒（事件 timestamp 优先，表列 created_at 兜底） */
  ts: number;
  role: string;
  /** 命中点前后各 ~60 字的正文切片（前后越界补省略号） */
  snippet: string;
}

export interface MemorySearchSummary {
  hits: MemorySearchHit[];
  /** 截断前的全部命中数（各库累加） */
  total: number;
  /** 实际参与搜索的库数（打不开/表缺失的库被跳过，不计入） */
  dbCount: number;
  /** 本次提供结果的所有 agent（前端渲染范围 chips 用） */
  agents: Array<{ id: string; name: string }>;
  /** 扫描行数超限的 agent（部分结果标记） */
  partialAgents: string[];
  /** 跳过的 agent（库打不开/表缺失） */
  skippedAgents: string[];
  elapsedMs: number;
}

export interface AgentDbRef {
  id: string;
  name: string;
  dbPath: string;
}

/** 最小 DatabaseSync 形状（只用到 prepare/iterate/close，测试里塞 :memory: 库即可） */
export interface SearchableDb {
  prepare(sql: string): { iterate(...params: unknown[]): IterableIterator<Record<string, unknown>> };
  close(): void;
}

// ---------- 参数校验 ----------

/** 查询词上限：trim 后 ≥2 字符，最长 64（超长截断不报错） */
const Q_MIN = 2;
const Q_MAX = 64;

export type NormalizedQuery = { ok: true; q: string } | { ok: false; error: string };

/** 校验并归一化查询词：trim、长度门、截断。错误信息不带 q 原文（防日志夹带）。 */
export function normalizeQuery(raw: unknown): NormalizedQuery {
  if (typeof raw !== "string") return { ok: false, error: "缺少搜索词 q" };
  const q = raw.trim().slice(0, Q_MAX);
  if (q.length < Q_MIN) return { ok: false, error: `搜索词太短（至少 ${Q_MIN} 个字符）` };
  return { ok: true, q };
}

/** 返回条数上限：默认 30，上限 50 */
export const DEFAULT_LIMIT = 30;
export const LIMIT_CAP = 50;

export function normalizeLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), LIMIT_CAP);
}

// ---------- 纯函数 ----------

/**
 * LIKE 模式构造：转义通配符与转义符本身（% _ \），配合 SQL 的 ESCAPE '\' 使用。
 * 不转义的话用户搜 "100%" 会命中一串不该命中的行。
 */
export function buildLikePattern(q: string): string {
  const esc = q.replace(/[\\%_]/g, "\\$&");
  return `%${esc}%`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 抽正文纯文本：content 是纯字符串（实查 user 消息常这样存）→ 整体就是一个 text 块；
 * 块数组 → 只拼 {type:"text", text} 块（思考块/toolResult 不进搜索正文）。
 * 与 session-edit-core.ts listEditableBlocks 的 text 块口径一致。
 */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** 事件 timestamp 两种形态容错：ISO 字符串 → Date.parse；毫秒数字 → 原样；缺失/非法 → fallback（表列 created_at） */
export function parseEventTsMs(event: unknown, fallbackMs: number): number {
  const raw = isRecord(event) ? event.timestamp : undefined;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw.length > 0) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return fallbackMs;
}

/**
 * snippet 切片：大小写不敏感找首个命中点，前后各 ~radius 字。
 * 找不到命中返回 null（调用方跳过该行——LIKE 粗筛后 JSON 层二次过滤的对齐口径）。
 */
export function snippetAround(text: string, q: string, radius = 60): string | null {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  const body = text.slice(start, end);
  return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
}

/** 跨库合并：ts 降序（同 ts 保输入序稳定排序），截 limit；total 是截断前总数 */
export function mergeAndCap(hits: MemorySearchHit[], limit: number): { hits: MemorySearchHit[]; total: number } {
  const sorted = [...hits].sort((a, b) => b.ts - a.ts);
  const capped = sorted.slice(0, Math.max(0, limit));
  return { hits: capped, total: hits.length };
}

// ---------- 单库搜索 ----------

/** 扫描行数上限（LIKE 无索引，防超大库拖死请求；实测 main 3.1 万行 ~90ms，20 万行是宽裕兜底） */
export const SCAN_ROW_CAP = 200_000;

/** 单库搜索行（LIKE 粗筛投影：会话 key 一次 JOIN 带出，映射不到为 NULL） */
const SEARCH_SQL = `SELECT t.session_id AS sessionId, t.created_at AS createdAt, t.event_json AS eventJson,
  n.sk AS sessionKey
  FROM transcript_events t
  LEFT JOIN (
    SELECT current_session_id AS sid, MIN(session_key) AS sk
    FROM session_nodes
    WHERE session_key NOT LIKE '%:run:%'
    GROUP BY current_session_id
  ) n ON n.sid = t.session_id
  WHERE t.event_json IS NOT NULL AND t.event_json LIKE ? ESCAPE '\\'
  ORDER BY t.created_at DESC`;

export interface AgentSearchOutcome {
  hits: MemorySearchHit[];
  /** 截断前该库全部命中数 */
  total: number;
  /** 是否扫到行数上限被截断（部分结果） */
  partial: boolean;
  /** 语句级失败（表缺失/库损坏）→ 编排层把该 agent 计入 skippedAgents */
  failed: boolean;
}

/** 单库搜索：LIKE 粗筛 → JSON 解析 → message+user/assistant+正文二次过滤 → snippet。坏行跳过不炸。 */
export function searchAgentDb(
  db: SearchableDb,
  agentId: string,
  agentName: string | undefined,
  q: string,
  opts: { limit?: number; scanRowCap?: number } = {},
): AgentSearchOutcome {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const scanRowCap = opts.scanRowCap ?? SCAN_ROW_CAP;
  const out: AgentSearchOutcome = { hits: [], total: 0, partial: false, failed: false };
  const lowerQ = q.toLowerCase();
  let scanned = 0;
  try {
    for (const row of db.prepare(SEARCH_SQL).iterate(buildLikePattern(q))) {
      if (++scanned > scanRowCap) {
        out.partial = true;
        break;
      }
      let event: unknown;
      try {
        event = JSON.parse(String(row.eventJson));
      } catch {
        continue; // 坏 JSON 行跳过
      }
      if (!isRecord(event) || event.type !== "message") continue;
      const message = event.message;
      if (!isRecord(message)) continue;
      const role = typeof message.role === "string" ? message.role : "";
      if (role !== "user" && role !== "assistant") continue;
      const text = extractTextFromContent(message.content);
      if (!text || !text.toLowerCase().includes(lowerQ)) continue;
      const snippet = snippetAround(text, q);
      if (snippet === null) continue;
      const createdAt = typeof row.createdAt === "number" ? row.createdAt : 0;
      out.total += 1;
      if (out.hits.length < limit) {
        out.hits.push({
          agentId,
          agentName,
          sessionKey: typeof row.sessionKey === "string" && row.sessionKey ? row.sessionKey : undefined,
          sessionId: typeof row.sessionId === "string" ? row.sessionId : undefined,
          ts: parseEventTsMs(event, createdAt),
          role,
          snippet,
        });
      }
    }
  } catch {
    // 语句级失败（表缺失/库损坏）→ 编排层把该 agent 计入 skippedAgents
    out.failed = true;
  }
  return out;
}

// ---------- 多库编排 ----------

/** 列出有 agent 库的 agent：扫 STATE_HOME/agents 目录 + 从 openclaw.json 取显示名（usage.ts 同款，本文件自持一份） */
export function listAgentDbs(): AgentDbRef[] {
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

/** 解析 agents 参数：逗号分隔的 agentId 白名单；缺省/不认识=全部有库的 agent */
export function parseAgentsFilter(raw: unknown, all: AgentDbRef[]): AgentDbRef[] {
  if (typeof raw !== "string" || !raw.trim()) return all;
  const wanted = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (wanted.size === 0) return all;
  return all.filter((a) => wanted.has(a.id));
}

export interface SearchDeps {
  /** 打开只读连接（生产用 DatabaseSync；测试注入 :memory: 库） */
  openDb?: (dbPath: string) => SearchableDb | null;
  now?: () => number;
}

/**
 * 多库搜索编排：逐库打开 → searchAgentDb → 跨库合并 ts 降序截 limit。
 * 库打不开/表缺失 = 该 agent 跳过（skippedAgents 留痕，不拖垮整页）。
 * total 是截断前各库全量命中数之和（每库内部 hits 先截 limit 省内存，计数单独累计）。
 */
export function searchAgentDbs(
  q: string,
  refs: AgentDbRef[],
  opts: { limit?: number; scanRowCap?: number; deps?: SearchDeps } = {},
): MemorySearchSummary {
  const openDb = opts.deps?.openDb ?? defaultOpenDb;
  const now = opts.deps?.now ?? (() => Date.now());
  const start = now();
  const merged: MemorySearchHit[] = [];
  const agents: Array<{ id: string; name: string }> = [];
  const partialAgents: string[] = [];
  const skippedAgents: string[] = [];
  let dbCount = 0;
  let fullTotal = 0;
  for (const ref of refs) {
    agents.push({ id: ref.id, name: ref.name });
    let db: SearchableDb | null = null;
    try {
      db = openDb(ref.dbPath);
    } catch {
      db = null;
    }
    if (!db) {
      skippedAgents.push(ref.id);
      continue;
    }
    try {
      const one = searchAgentDb(db, ref.id, ref.name, q, opts);
      if (one.failed) {
        skippedAgents.push(ref.id);
        continue;
      }
      if (one.partial) partialAgents.push(ref.id);
      dbCount += 1;
      fullTotal += one.total;
      merged.push(...one.hits);
    } finally {
      try {
        db.close();
      } catch {
        // 关不掉就交给 GC
      }
    }
  }
  const { hits } = mergeAndCap(merged, opts.limit ?? DEFAULT_LIMIT);
  return {
    hits,
    total: fullTotal,
    dbCount,
    agents,
    partialAgents,
    skippedAgents,
    elapsedMs: Math.max(0, now() - start),
  };
}

/** 生产环境的只读打开器：打不开返回 null（调用方跳过该库） */
function defaultOpenDb(dbPath: string): SearchableDb | null {
  try {
    // node:sqlite 只读打开——库被网关 WAL 占用也安全（approvals/usage 同款先例）
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}
