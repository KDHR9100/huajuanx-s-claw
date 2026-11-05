// 聊天历史「改真身」端点：GET /__rana/session-edit（取消息真身块 + 哈希）、
// POST /__rana/session-edit（校验后原地 UPDATE 会话库 transcript_events）。
//
// 安全模型（抄 person-graph + RP 钉子手术两处仓库先例）：
// - GET/POST 全部仅本机回环（transcript 含 RP 私密，一个字节不出本机）
// - 路径服务端推导（扫 agents/*/agent/openclaw-agent.sqlite 定位会话），前端只传 sessionKey
// - 写前当日备份（VACUUM INTO 一致性快照）、事务内重新定位 + 哈希比对、只 UPDATE 不 INSERT
// - 会话活跃检查（transcript_updated_at <90s 拒绝写），避开与运行时写路径赛跑
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { STATE_HOME } from "../lib/paths";
import { json, isLoopback } from "../lib/http";
import type { Plugin } from "vite";
import {
  SessionEditError,
  findSessionLocation,
  loadTranscriptMessages,
  locateMessage,
  hashBlocks,
  applyBlocksToEvent,
  encodeEventJson,
  backupAgentDb,
  sessionRecencyMs,
  type EditableBlock,
  type LoadedMessage,
} from "../lib/session-edit-core";

/** 会话活跃阈值：transcript_updated_at 距今小于这个数就拒绝写（前端另有流式中禁用） */
const ACTIVE_GUARD_MS = 90_000;
/** 入参上限 */
const MAX_KEY_LEN = 200;
const MAX_PREFIX_LEN = 200;
/** 每块内容上限（正常聊天消息远小于此，超了就是异常提交） */
const MAX_BLOCK_CHARS = 200_000;

type Row = Record<string, unknown>;

/** 扫 agents/<agentId>/agent/openclaw-agent.sqlite 找含该 session_key 的库 */
function resolveSessionDbPath(agentsDir: string, sessionKey: string): string {
  if (!sessionKey || sessionKey.length > MAX_KEY_LEN) throw new SessionEditError(400, "sessionKey 不合法");
  let dirs: string[] = [];
  try {
    dirs = existsSync(agentsDir) ? readdirSync(agentsDir) : [];
  } catch {
    throw new SessionEditError(500, "agents 目录不可读");
  }
  for (const agentId of dirs) {
    const dbPath = path.join(agentsDir, agentId, "agent", "openclaw-agent.sqlite");
    if (!existsSync(dbPath)) continue;
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      continue; // 库被锁/坏了，扫下一个
    }
    try {
      if (findSessionLocation(db, sessionKey)) return dbPath;
    } catch {
      // 查询失败当不存在，扫下一个
    } finally {
      db.close();
    }
  }
  throw new SessionEditError(404, `会话 ${sessionKey} 不在任何 agent 库里`);
}

/** GET / POST 共用：打开库 → 查会话位置 → 载入消息 → 按锚点定位（调用方负责关库） */
function loadAndLocate(
  dbPath: string,
  sessionKey: string,
  anchor: { eventId?: string; role?: string; prefix?: string; tsMs?: number },
): { db: DatabaseSync; hit: LoadedMessage } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const loc = findSessionLocation(db, sessionKey);
  if (!loc) throw new SessionEditError(404, "会话定位失败（session_nodes 无此 key）");
  const messages = loadTranscriptMessages(db, loc.sessionId);
  const hit = locateMessage(messages, anchor);
  return { db, hit };
}

/** 解析请求锚点入参（eventId / role+prefix+tsMs 至少带一组） */
function parseAnchor(q: Row): { eventId?: string; role?: string; prefix?: string; tsMs?: number } {
  const anchor: { eventId?: string; role?: string; prefix?: string; tsMs?: number } = {};
  if (typeof q.eventId === "string" && q.eventId) anchor.eventId = q.eventId;
  if (typeof q.role === "string" && q.role) anchor.role = q.role;
  if (typeof q.prefix === "string" && q.prefix) anchor.prefix = q.prefix.slice(0, MAX_PREFIX_LEN);
  if (typeof q.tsMs === "string" && q.tsMs) {
    const n = Number(q.tsMs);
    if (Number.isFinite(n)) anchor.tsMs = n;
  }
  if (!anchor.eventId && !(anchor.role && anchor.prefix)) {
    throw new SessionEditError(400, "缺少定位锚点（eventId 或 role+prefix）");
  }
  return anchor;
}

/** 校验提交的块数组形态，返回规范化后的块 */
function parseSubmittedBlocks(raw: unknown): EditableBlock[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) throw new SessionEditError(400, "blocks 必须是 1~8 个的数组");
  return raw.map((b, i) => {
    const kind = (b as Row)?.kind;
    const content = (b as Row)?.content;
    if (kind !== "thinking" && kind !== "text") throw new SessionEditError(400, `第 ${i + 1} 个块 kind 非法`);
    if (typeof content !== "string") throw new SessionEditError(400, `第 ${i + 1} 个块 content 必须是字符串`);
    if (content.length > MAX_BLOCK_CHARS) throw new SessionEditError(413, `第 ${i + 1} 个块超过 ${MAX_BLOCK_CHARS} 字上限`);
    return { kind, content } as EditableBlock;
  });
}

export function ranaSessionEditMiddleware(): Plugin {
  const AGENTS_DIR = path.join(STATE_HOME, "agents");

  const handler = (
    req: {
      method?: string;
      url?: string;
      on: (ev: string, cb: (c?: string) => void) => void;
      removeAllListeners: (ev?: string) => unknown;
      socket?: { remoteAddress?: string };
      headers?: Record<string, unknown>;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    const route = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "") || "/";
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }
    if (req.method === "GET" && route === "/") {
      void handleGet(AGENTS_DIR, req, res);
      return;
    }
    if (req.method === "POST" && route === "/") {
      void handlePost(AGENTS_DIR, req, res);
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-session-edit",
    configureServer(server) {
      server.middlewares.use("/__rana/session-edit", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/session-edit", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/** GET/POST 共用的请求/响应形态（与 person-graph 同款最小类型） */
interface ReqT {
  method?: string;
  url?: string;
  on: (ev: string, cb: (c?: string) => void) => void;
  removeAllListeners: (ev?: string) => unknown;
  socket?: { remoteAddress?: string };
  headers?: Record<string, unknown>;
}
interface ResT {
  setHeader: (k: string, v: string) => void;
  statusCode: number;
  end: (s: string) => void;
}

/** GET：取一条消息的真身块 + 哈希（只读） */
async function handleGet(agentsDir: string, req: ReqT, res: ResT): Promise<void> {
  const q = Object.fromEntries(new URL(req.url ?? "/", "http://x").searchParams) as Row;
  const sessionKey = String(q.sessionKey ?? "");
  try {
    const anchor = parseAnchor(q);
    const dbPath = resolveSessionDbPath(agentsDir, sessionKey);
    const { db, hit } = loadAndLocate(dbPath, sessionKey, anchor);
    try {
      json(res, 200, {
        ok: true,
        role: hit.role,
        seq: hit.seq,
        tsMs: hit.tsMs ?? null,
        hash: hashBlocks(hit.blocks),
        blocks: hit.blocks,
      });
    } finally {
      db.close();
    }
  } catch (e) {
    const err = e as SessionEditError;
    json(res, typeof err.status === "number" ? err.status : 500, { ok: false, error: err.message });
  }
}

/** 事务写入：守门（活跃/当日备份）→ BEGIN IMMEDIATE 重定位+哈希校验 → 原地 UPDATE → bump → COMMIT */
async function applyEdit(
  dbPath: string,
  sessionKey: string,
  anchor: { eventId?: string; role?: string; prefix?: string; tsMs?: number },
  expect: string,
  blocks: EditableBlock[],
  res: ResT,
): Promise<void> {
  // ① 只读连接守门：活跃检查 + 当日备份（VACUUM INTO 在线快照，不锁写）
  {
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const loc0 = findSessionLocation(ro, sessionKey);
      if (!loc0) throw new SessionEditError(404, "会话定位失败（session_nodes 无此 key）");
      const recent = sessionRecencyMs(ro, loc0.sessionId);
      if (typeof recent === "number" && Date.now() - recent < ACTIVE_GUARD_MS) {
        throw new SessionEditError(409, "会话刚刚还在活动（90 秒内），请等它静下来再改");
      }
      backupAgentDb(ro, dbPath, new Date().toISOString().slice(0, 10).replace(/-/g, ""));
    } finally {
      ro.close();
    }
  }
  // ② 读写连接事务
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    db.exec("BEGIN IMMEDIATE");
    const loc = findSessionLocation(db, sessionKey);
    if (!loc) throw new SessionEditError(404, "会话定位失败（session_nodes 无此 key）");
    const messages = loadTranscriptMessages(db, loc.sessionId);
    const hit = locateMessage(messages, anchor);
    if (hashBlocks(hit.blocks) !== expect) {
      throw new SessionEditError(409, "消息内容与打开编辑时对不上（可能刚被压缩或另一端改过），请重开编辑");
    }
    applyBlocksToEvent(hit.event, blocks);
    const encoded = encodeEventJson(hit.event, hit.storage);
    // 只 UPDATE 既有行，绝不 INSERT（不进活跃分支索引的新行永远读不到）
    db.prepare(
      "UPDATE transcript_events SET event_json = ?, event_zstd = ?, event_utf8_bytes = ? WHERE session_id = ? AND seq = ?",
    ).run(
      encoded.event_json,
      encoded.event_zstd,
      encoded.bytes,
      hit.sessionId,
      hit.seq,
    );
    // 同事务 bump transcript_updated_at（毫秒，严格递增，等价运行时 touchTranscriptMutation）
    const now = Date.now();
    const curRow = db
      .prepare("SELECT MAX(transcript_updated_at) AS t FROM session_windows WHERE session_id = ?")
      .get(hit.sessionId) as { t?: number | bigint | null } | undefined;
    const cur = typeof curRow?.t === "number" ? curRow.t : typeof curRow?.t === "bigint" ? Number(curRow.t) : 0;
    const next = Math.max(now, cur + 1);
    db.prepare("UPDATE session_windows SET transcript_updated_at = ? WHERE session_id = ?").run(next, hit.sessionId);
    db.exec("COMMIT");
    json(res, 200, { ok: true, seq: hit.seq, sessionId: hit.sessionId });
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 无事务可回滚
    }
    const err = e as SessionEditError;
    json(res, typeof err.status === "number" ? err.status : 500, { ok: false, error: err.message });
  } finally {
    db.close();
  }
}
/** POST：改真身主流程。守门（活跃/备份）→ 事务内重新定位+哈希比对 → 原地 UPDATE → bump 时间戳 */
async function handlePost(agentsDir: string, req: ReqT, res: ResT): Promise<void> {
  let body = "";
  req.on("data", (c?: string) => {
    body += c ?? "";
    if (body.length > 2 * 1024 * 1024) {
      json(res, 413, { ok: false, error: "请求体超过 2MB 上限" });
      req.removeAllListeners("data");
      req.removeAllListeners("end");
    }
  });
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body || "{}") as Row;
      const sessionKey = String(parsed.sessionKey ?? "");
      const expect = String(parsed.expect ?? "");
      if (!expect) throw new SessionEditError(400, "缺少 expect 哈希");
      const anchor = {
        eventId: typeof parsed.eventId === "string" ? parsed.eventId : undefined,
        role: typeof parsed.role === "string" ? parsed.role : undefined,
        prefix: typeof parsed.prefix === "string" ? parsed.prefix.slice(0, MAX_PREFIX_LEN) : undefined,
        tsMs: typeof parsed.tsMs === "number" ? parsed.tsMs : undefined,
      };
      if (!anchor.eventId && !(anchor.role && anchor.prefix)) {
        throw new SessionEditError(400, "缺少定位锚点（eventId 或 role+prefix）");
      }
      const blocks = parseSubmittedBlocks(parsed.blocks);
      const dbPath = resolveSessionDbPath(agentsDir, sessionKey);
      await applyEdit(dbPath, sessionKey, anchor, expect, blocks, res);
      return;
    } catch (e) {
      const err = e as SessionEditError;
      json(res, typeof err.status === "number" ? err.status : 500, { ok: false, error: err.message });
    }
  });
}