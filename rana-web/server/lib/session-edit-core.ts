/**
 * 聊天历史「改真身」核心逻辑——网页编辑历史消息（含思考块）并持久化回 agent 会话库。
 *
 * 为什么抽这个文件：编辑链路里的「定位 / 校验 / 改写」都是纯逻辑，抽出来配 vitest 直测
 * （tests/unit/session-edit-core.test.ts），中间件（../plugins/session-edit.ts）只留路由与 I/O。
 *
 * 真身存储形态（openclaw 运行时 agent 库，实查 2026-11-05）：
 * - transcript_events：一行一个转录事件；event_json（plain TEXT）或 event_zstd（压缩 BLOB）二选一
 * - 事件对象：{ type:"message", id(UUID), parentId, timestamp:"ISO字符串", message:{ role, content:[块数组] } }
 * - 块数组里 {type:"text",text} 与思考块 {type:"thinking"|"reasoning", thinking|text, …签名} 并列；
 *   上下文装配按 (session_id, seq) 取活跃分支（context_eligible），原地 UPDATE 行引用不变、索引不破。
 * - session_windows.transcript_updated_at 是毫秒时间戳（运行时 touch = Date.now() 严格递增），
 *   改完必须 bump，否则增量尾巴/重置窗口缓存可能继续复用旧内容。
 */
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { zstdDecompressSync, zstdCompressSync } from "node:zlib";

/** 可编辑块视图：thinking=思考块，text=正文块 */
export interface EditableBlock {
  kind: "thinking" | "text";
  content: string;
}

/** 解析后的事件对象（宽松形态，字段缺失容错） */
export interface TranscriptEvent {
  type?: string;
  id?: string;
  timestamp?: string;
  parentId?: string;
  message?: { role?: string; content?: unknown };
}

/** 定位后的可编辑消息 */
export interface LoadedMessage {
  sessionId: string;
  seq: number;
  eventId: string;
  tsMs?: number;
  role: "user" | "assistant";
  /** text 块拼接（与前端 extractText 同口径，定位锚） */
  joinedText: string;
  /** 可编辑块视图（非空 text/thinking，按 content 数组顺序） */
  blocks: EditableBlock[];
  /** 行的存储格式：写回时保持原格式（plain 不动，zstd 重新压缩） */
  storage: "plain" | "zstd";
  event: TranscriptEvent;
}

/** 带 HTTP 状态码的错误（中间件直接映射） */
export class SessionEditError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- 解析 / 序列化 ----------

/** 解码一行转录事件（plain 或 zstd）→ 事件对象 + 存储格式 */
export function decodeEventRow(row: { event_json?: unknown; event_zstd?: unknown }): {
  event: TranscriptEvent;
  storage: "plain" | "zstd";
} {
  try {
    if (typeof row.event_json === "string") {
      return { event: JSON.parse(row.event_json) as TranscriptEvent, storage: "plain" };
    }
    if (Buffer.isBuffer(row.event_zstd) && row.event_zstd.length > 0) {
      return {
        event: JSON.parse(zstdDecompressSync(row.event_zstd).toString("utf8")) as TranscriptEvent,
        storage: "zstd",
      };
    }
  } catch (e) {
    throw new SessionEditError(500, `转录事件解码失败：${(e as Error).message}`);
  }
  throw new SessionEditError(500, "转录事件行既无 event_json 也无 event_zstd");
}

/** 事件对象 → 存储值（plain=JSON 字符串；zstd=压缩 Buffer）。写回保持原格式。 */
export function encodeEventJson(event: TranscriptEvent, storage: "plain" | "zstd"): {
  event_json: string | null;
  event_zstd: Buffer | null;
  bytes: number;
} {
  const text = JSON.stringify(event);
  if (storage === "plain") return { event_json: text, event_zstd: null, bytes: Buffer.byteLength(text) };
  const buf = zstdCompressSync(Buffer.from(text, "utf8"));
  return { event_json: null, event_zstd: buf, bytes: Buffer.byteLength(text) };
}

// ---------- 块视图与改写 ----------

const THINKING_TYPES = new Set(["thinking", "reasoning"]);
/** Anthropic 式签名：改内容即失效，改思考块时顺手剥掉（智谱/GLM 不校验，剥了安全） */
const SIGNATURE_FIELDS = ["thinkingSignature", "signature", "thought_signature"];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 判断一个 content 块是否「可编辑」：非空 text 块 / 非空思考块（redacted_thinking 是密文，不可编辑不展示） */
function editableOf(block: unknown): { kind: "thinking" | "text"; content: string } | null {
  if (!isRecord(block)) return null;
  if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
    return { kind: "text", content: block.text };
  }
  if (typeof block.type === "string" && THINKING_TYPES.has(block.type)) {
    const content = typeof block.thinking === "string" ? block.thinking : typeof block.text === "string" ? block.text : "";
    if (content.length > 0) return { kind: "thinking", content };
  }
  return null;
}

/** 从事件里取可编辑块视图（与 applyBlocksToEvent 的走查规则严格一致）。
 *  user 消息常以纯字符串存 content（实查 2026-11-05：user content 是 string），整体视作一个 text 块。 */
export function listEditableBlocks(event: TranscriptEvent): EditableBlock[] {
  const content = event.message?.content;
  if (typeof content === "string") return content ? [{ kind: "text", content }] : [];
  if (!Array.isArray(content)) return [];
  const out: EditableBlock[] = [];
  for (const b of content) {
    const e = editableOf(b);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 把前端传回的块内容写回事件对象（原地改）。
 * 规则：块数必须与原可编辑块一致、kind 顺序一致；只改块内容，不动块的类型/顺序/其他字段
 * （toolCall/媒体/附件块一概不碰）。思考块改完剥签名。
 */
export function applyBlocksToEvent(event: TranscriptEvent, blocks: EditableBlock[]): void {
  // 字符串形态：必须恰好一个 text 块，整段替换
  if (event.message && typeof event.message.content === "string") {
    if (blocks.length !== 1 || blocks[0].kind !== "text") {
      throw new SessionEditError(409, "该消息正文是整段字符串，只支持整段替换");
    }
    event.message.content = blocks[0].content;
    return;
  }
  const content = event.message?.content;
  if (!Array.isArray(content)) throw new SessionEditError(400, "该消息没有可编辑的内容块");
  const editable: Array<{ block: Record<string, unknown>; kind: "thinking" | "text" }> = [];
  for (const b of content) {
    if (!isRecord(b)) continue;
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) editable.push({ block: b, kind: "text" });
    else if (typeof b.type === "string" && THINKING_TYPES.has(b.type) &&
      (typeof b.thinking === "string" || typeof b.text === "string") &&
      (b.thinking as string || b.text as string || "").length > 0) {
      editable.push({ block: b, kind: "thinking" });
    }
  }
  if (editable.length !== blocks.length) {
    throw new SessionEditError(409, `内容块数对不上（库里 ${editable.length} 个可编辑块，提交了 ${blocks.length} 个），请重开编辑`);
  }
  blocks.forEach((nb, i) => {
    const { block, kind } = editable[i];
    if (nb.kind !== kind) throw new SessionEditError(409, `第 ${i + 1} 个块类型对不上（库里 ${kind}，提交 ${nb.kind}），请重开编辑`);
    const content2 = String(nb.content ?? "");
    if (kind === "text") {
      block.text = content2;
    } else {
      if (typeof block.thinking === "string") block.thinking = content2;
      else block.text = content2;
      for (const f of SIGNATURE_FIELDS) delete block[f];
    }
  });
}

// ---------- 定位 ----------

/** 事件 ts 与前端 ts 的匹配容差（投影 timestamp 与事件 ISO ts 同源，正常应相等；留余量） */
const TS_TOLERANCE_MS = 5000;
/** 定位前缀最短长度：太短的锚太弱，宁可不干活也不改错条 */
export const MIN_PREFIX_LEN = 8;
/** 定位前缀最长长度（前端传 60，服务端放宽到 200） */
export const MAX_PREFIX_LEN = 200;

/**
 * 在会话转录里定位唯一一条消息。
 * 锚点：eventId（chat.history 若带真身 UUID 则精确命中）> role+前缀+ts 邻近。
 * 要求唯一命中：0 条或多条都报错，绝不猜。
 */
export function locateMessage(
  messages: LoadedMessage[],
  anchor: { eventId?: string; role?: string; prefix?: string; tsMs?: number },
): LoadedMessage {
  const { eventId, role, prefix, tsMs } = anchor;
  // ① 精确锚：事件 UUID（36 位）直接等值匹配
  if (eventId && /^[0-9a-f-]{16,64}$/i.test(eventId)) {
    const hit = messages.find((m) => m.eventId === eventId);
    if (hit) return hit;
    // UUID 形态但库里没有 → 不回退模糊锚，避免改错条
    throw new SessionEditError(404, "按消息 id 没找到对应的历史消息（可能已被压缩归档），请刷新后重试");
  }
  // ② 模糊锚：role + 前缀（+ ts 邻近）
  const pfx = String(prefix ?? "");
  if (pfx.length < MIN_PREFIX_LEN) throw new SessionEditError(400, `定位前缀太短（至少 ${MIN_PREFIX_LEN} 字），拒绝盲改`);
  if (pfx.length > MAX_PREFIX_LEN) throw new SessionEditError(400, `定位前缀超过 ${MAX_PREFIX_LEN} 字上限`);
  if (role !== "user" && role !== "assistant") throw new SessionEditError(400, "role 只允许 user/assistant");
  let candidates = messages.filter((m) => m.role === role && m.joinedText.startsWith(pfx));
  if (typeof tsMs === "number" && tsMs > 0) {
    const narrow = candidates.filter((m) => m.tsMs !== undefined && Math.abs(m.tsMs - tsMs) <= TS_TOLERANCE_MS);
    if (narrow.length === 1) return narrow[0];
    if (narrow.length > 1) throw new SessionEditError(409, "定位到多条同前缀消息（时间窗内），拒绝猜测，请稍后重试或改另一条");
    // 时间窗内 0 条 → 放弃 ts 锚退回纯前缀（投影/事件 ts 口径差异兜底）
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) throw new SessionEditError(404, "没找到匹配的历史消息（可能已被压缩归档，或内容有出入），请刷新后重试");
  throw new SessionEditError(409, "定位到多条同前缀消息，拒绝猜测，请改另一条（或等会话再长一点）");
}

/** 可编辑块视图 → 稳定哈希（sha256 前 16 位），GET 返回、POST 回传比对，兜并发改动 */
export function hashBlocks(blocks: EditableBlock[]): string {
  return createHash("sha256").update(JSON.stringify(blocks)).digest("hex").slice(0, 16);
}

// ---------- agent 库访问（node:sqlite，同 approvals.ts 先例） ----------

type Db = import("node:sqlite").DatabaseSync;

/** 查 session_key → 当前转录代际的 session_id（扫不到返回 undefined） */
export function findSessionLocation(db: Db, sessionKey: string): { sessionId: string; status: string | null } | undefined {
  const row = db.prepare("SELECT current_session_id, status FROM session_nodes WHERE session_key = ?").get(sessionKey) as
    | { current_session_id?: unknown; status?: unknown }
    | undefined;
  const id = row?.current_session_id;
  return typeof id === "string" && id ? { sessionId: id, status: typeof row?.status === "string" ? row.status : null } : undefined;
}

/** 读一个会话当前代际的全部可编辑消息（type=message 且 role∈{user,assistant} 且正文非空） */
export function loadTranscriptMessages(db: Db, sessionId: string): LoadedMessage[] {
  const rows = db
    .prepare("SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId) as Array<{ seq: number; event_json: string | null; event_zstd: Buffer | null }>;
  const out: LoadedMessage[] = [];
  for (const row of rows) {
    let event: TranscriptEvent;
    let storage: "plain" | "zstd";
    try {
      ({ event, storage } = decodeEventRow(row));
    } catch {
      continue; // 单行坏了跳过，不拖垮整个会话
    }
    if (event.type !== "message") continue;
    const role = event.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const blocks = listEditableBlocks(event);
    const joinedText = blocks.filter((b) => b.kind === "text").map((b) => b.content).join("");
    if (!joinedText) continue; // 空正文（纯工具轮/纯附件）跳过——与 chat.history 展示口径对齐
    const tsIso = typeof event.timestamp === "string" ? event.timestamp : undefined;
    const parsed = tsIso ? Date.parse(tsIso) : NaN;
    out.push({
      sessionId,
      seq: Number(row.seq),
      eventId: typeof event.id === "string" ? event.id : "",
      tsMs: Number.isFinite(parsed) ? parsed : undefined,
      role,
      joinedText,
      blocks,
      storage,
      event,
    });
  }
  return out;
}

/**
 * 会话活跃检查：transcript_updated_at 距今 < recencyMs → 拒绝写。
 * 避开与运行时写路径（正在流式/刚收尾的会话）赛跑；正常聊天结束后 90 秒即可改。
 */
export function sessionRecencyMs(db: Db, sessionId: string): number | null {
  const row = db
    .prepare("SELECT MAX(transcript_updated_at) AS t FROM session_windows WHERE session_id = ?").get(sessionId) as
    | { t?: unknown }
    | undefined;
  const t = row?.t;
  return typeof t === "number" ? t : typeof t === "bigint" ? Number(t) : null;
}

/**
 * 当日备份：VACUUM INTO 一致性快照（在线安全，不锁写），一天一份，已存在则跳过。
 * 恢复方法：停网关后用备份文件覆盖原库（连同 -wal/-shm 一并删掉再起）。
 */
export function backupAgentDb(db: Db, dbPath: string, dateTag: string): { path: string; skipped: boolean } {
  const bakPath = `${dbPath}.bak-sessedit-${dateTag}`;
  if (existsSync(bakPath)) return { path: bakPath, skipped: true };
  db.exec(`VACUUM INTO '${bakPath.replace(/'/g, "''")}'`);
  return { path: bakPath, skipped: false };
}
