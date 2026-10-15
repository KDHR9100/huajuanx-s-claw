import fs from "node:fs";
import path from "node:path";
import { execFileP } from "../lib/exec";
import { STATE_HOME, OPENCLAW_MJS } from "../lib/paths";
import { json, readBody, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 轨迹回放端点（🔍 过程页的后端；全部仅本机——轨迹含完整对话与装配 prompt）：
 * - GET  /__rana/trajectory/list                 导出清单（扫各导出目录的 manifest.json）
 * - POST /__rana/trajectory/export {sessionKey}  跑 openclaw CLI 导出一个会话（180s 超时；同时只允许一个）
 * - GET  /__rana/trajectory/events?name=         读 events.jsonl，服务端瘦身成「按 run 分组的时间线」
 * 导出统一落 STATE_HOME/.openclaw/trajectory-exports/<rana-web-时间戳>/（状态目录，git 已忽略，不进公开仓）。
 * 瘦身原则（对应拍板「对话+工具+token账单，深度内容折叠」）：正文/思考/工具参数按上限截断，
 * messagesSnapshot / 完整装配 prompt 这类大块不发给前端，只发规模数字。
 */

const EXPORTS_DIR = path.join(STATE_HOME, ".openclaw", "trajectory-exports");
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SESSION_KEY_RE = /^[\w:.-]{1,200}$/;
/** 单段文本上限（字符）：聊天正文放宽，其他碎片收紧 */
const CAP_TEXT = 20000;
const CAP_SNIPPET = 400;

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s);

/** 工具结果等 content 块数组 → 拼成纯文本预览 */
const blockText = (v: unknown): string => {
  const content = asObj(v).content;
  if (Array.isArray(content)) {
    return content
      .map((c) => str(asObj(c).text))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
};

/** assistant 消息内容块 → 瘦身块（思考/参数只留头部预览，正文截断） */
const slimBlocks = (content: unknown): Array<Json> =>
  asArr(content).map((c) => {
    const b = asObj(c);
    const t = str(b.type);
    if (t === "text") return { k: "text", text: cap(str(b.text), CAP_TEXT) };
    if (t === "thinking" || t === "reasoning" || t === "redacted_thinking")
      return { k: "think", chars: str(b.thinking ?? b.text).length, head: cap(str(b.thinking ?? b.text), CAP_SNIPPET) };
    if (t === "toolCall" || t === "tool_call" || t === "toolcall" || t === "tool_use")
      return { k: "tool", name: str(b.name), args: cap(JSON.stringify(b.arguments ?? b.args ?? ""), 1500) };
    if (t === "image") return { k: "img", mime: str(b.mimeType) };
    return { k: t || "?" };
  });

const slimUsage = (u: unknown): Json | undefined => {
  const x = asObj(u);
  if (!("input" in x) && !("output" in x) && !("totalTokens" in x)) return undefined;
  return {
    input: num(x.input),
    output: num(x.output),
    totalTokens: num(x.totalTokens),
    cost: num(asObj(x.cost).usd ?? asObj(x.cost).total),
  };
};

// ===== 单行事件瘦身 =====
interface SlimEvent {
  seq: number;
  ts: string;
  source: string;
  type: string;
  runId?: string;
  model?: string;
  d?: Json;
}

const slimLine = (j: Json, fallbackSeq: number): SlimEvent | null => {
  const type = str(j.type);
  if (type === "trace.metadata") return null; // 纯 harness 配置快照，时间线用不上
  const data = asObj(j.data);
  const modelId = str(j.modelId);
  const ev: SlimEvent = {
    seq: num(j.seq) ?? fallbackSeq,
    ts: str(j.ts),
    source: str(j.source),
    type,
    ...(j.runId ? { runId: str(j.runId) } : {}),
    ...(modelId ? { model: `${str(j.provider)}/${modelId}` } : {}),
  };
  const message = asObj(data.message);
  switch (type) {
    case "user.message":
      ev.d = { text: cap(str(message.content), CAP_TEXT) };
      break;
    case "assistant.message": {
      const usage = slimUsage(message.usage);
      ev.d = { blocks: slimBlocks(message.content), ...(usage ? { usage } : {}) };
      break;
    }
    case "prompt.submitted":
      ev.d = {
        prompt: cap(str(data.prompt), 4000),
        msgs: asArr(data.messages).length,
        sysChars: str(data.systemPrompt).length,
        imagesCount: num(data.imagesCount),
      };
      break;
    case "context.compiled":
      ev.d = {
        msgs: asArr(data.messages).length,
        sysChars: str(data.systemPrompt).length,
        tools: Array.isArray(data.tools) ? data.tools.length : num(data.tools),
        imagesCount: num(data.imagesCount),
      };
      break;
    case "model.completed": {
      // usage 藏在快照里最后一条带 usage 的 assistant 消息上；快照本体不发
      let usage: Json | undefined;
      for (const m of asArr(data.messagesSnapshot)) {
        const u = slimUsage(asObj(m).usage);
        if (u) usage = u;
      }
      ev.d = {
        stopReason: str(data.stopReason),
        compactionCount: num(data.compactionCount),
        finalPromptChars: str(data.finalPromptText).length,
        ...(usage ? { usage } : {}),
      };
      break;
    }
    case "session.started":
      ev.d = { trigger: str(data.trigger), agentId: str(data.agentId), toolCount: num(data.toolCount) };
      break;
    case "session.ended":
      ev.d = { status: str(data.status), stopReason: str(data.stopReason) };
      break;
    case "session.compaction":
      ev.d = { tokensBefore: num(data.tokensBefore), summaryHead: cap(str(data.summary), CAP_SNIPPET) };
      break;
    case "trace.artifacts":
      ev.d = {
        finalStatus: str(data.finalStatus),
        toolCount: Array.isArray(data.toolMetas) ? data.toolMetas.length : undefined,
      };
      break;
    case "session.reset":
      ev.d = { reason: cap(str(data.reason), CAP_SNIPPET) };
      break;
    case "session.model_change":
      ev.d = { provider: str(data.provider), modelId: str(data.modelId) };
      break;
    case "session.thinking_level_change":
      ev.d = { level: str(data.thinkingLevel) };
      break;
    case "session.custom":
      ev.d = { customType: str(data.customType) };
      break;
    case "tool.call":
      ev.d = { name: str(data.name), args: cap(JSON.stringify(data.args ?? data.arguments ?? ""), 1500) };
      break;
    case "tool.result":
      ev.d = {
        name: str(data.name),
        isError: data.isError === true,
        meta: cap(str(data.meta), CAP_SNIPPET),
        result: cap(blockText(data.result), 2500),
      };
      break;
    default:
      ev.d = { note: cap(JSON.stringify(data), CAP_SNIPPET) };
      break;
  }
  return ev;
};

// ===== 按 run 分组（runtime 事件带 runId；transcript 消息按时间窗归入，窗外的进「早期对话」） =====
interface RunBucket {
  id: string;
  events: SlimEvent[];
  startedAt?: string;
  endedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  history: boolean;
}

const buildTimeline = (events: SlimEvent[]) => {
  const buckets = new Map<string, RunBucket>();
  const ensure = (id: string, history = false): RunBucket => {
    let b = buckets.get(id);
    if (!b) {
      b = { id, events: [], history };
      buckets.set(id, b);
    }
    return b;
  };
  const HISTORY = "";
  // 第一遍：带 runId 的归 run；同时记录每 run 的起止/提交/完成时间
  for (const ev of events) {
    if (ev.runId) {
      const b = ensure(ev.runId);
      b.events.push(ev);
      if (ev.type === "session.started") b.startedAt = ev.ts;
      if (ev.type === "session.ended") b.endedAt = ev.ts;
      if (ev.type === "prompt.submitted") b.submittedAt = ev.ts;
      if (ev.type === "model.completed") b.completedAt = ev.ts;
    }
  }
  // 补齐没有 started/ended 事件的 run 的窗口（用自身事件时间）
  for (const b of buckets.values()) {
    if (!b.startedAt) b.startedAt = b.events[0]?.ts;
    if (!b.endedAt) b.endedAt = b.events[b.events.length - 1]?.ts;
  }
  // 第二遍：无 runId 的（多为 transcript 落库消息）按时间塞进覆盖它的 run，塞不进进「早期对话」
  const t = (ts?: string) => (ts ? Date.parse(ts) : NaN);
  for (const ev of events) {
    if (ev.runId) continue;
    const et = t(ev.ts);
    let hit: RunBucket | undefined;
    if (Number.isFinite(et)) {
      for (const b of buckets.values()) {
        if (b.history) continue;
        const s = t(b.startedAt);
        const e = t(b.endedAt);
        if (Number.isFinite(s) && Number.isFinite(e) && et >= s && et <= e) {
          hit = b;
          break;
        }
      }
    }
    (hit ?? ensure(HISTORY, true)).events.push(ev);
  }
  // 收口成响应结构
  const rows = [...buckets.values()]
    .map((b) => {
      const sorted = b.events.slice().sort((x, y) => x.seq - y.seq);
      const usage = (() => {
        for (let i = sorted.length - 1; i >= 0; i--) {
          const u = asObj(sorted[i].d).usage;
          if (u && Object.keys(u).length) return u;
        }
        return undefined;
      })();
      const model = sorted.find((x) => x.model)?.model;
      const stopReason =
        sorted.find((x) => x.type === "session.ended")?.d?.stopReason ??
        sorted.find((x) => x.type === "model.completed")?.d?.stopReason;
      const sub = t(b.submittedAt);
      const comp = t(b.completedAt);
      const durationMs =
        Number.isFinite(sub) && Number.isFinite(comp) && comp >= sub ? comp - sub : t(b.endedAt) - t(b.startedAt);
      return {
        id: b.id,
        history: b.history,
        startedAt: b.startedAt,
        endedAt: b.endedAt,
        durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
        model,
        stopReason: stopReason as string | undefined,
        usage,
        events: sorted,
      };
    })
    .sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
  // 「早期对话」永远排最前，其余按开始时间升序并编号
  rows.sort((a, b) => Number(b.history) - Number(a.history));
  return rows.map((r, i) => ({ ...r, idx: r.history ? 0 : i + 1 - rows.filter((x) => x.history).length }));
};

// ===== 事件文件读取（按 mtime+size 缓存） =====
const eventCache = new Map<string, { mtimeMs: number; size: number; data: unknown }>();

const readTimeline = (name: string): { ok: true; name: string; sessionKey?: string; generatedAt?: string; runs: unknown[]; eventCount: number } => {
  const dir = path.join(EXPORTS_DIR, name);
  const file = path.join(dir, "events.jsonl");
  const st = fs.statSync(file); // 不存在直接抛，调用方转 404
  const cached = eventCache.get(name);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.data as ReturnType<typeof readTimeline>;
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const events: SlimEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const slim = slimLine(JSON.parse(lines[i]) as Json, i + 1);
      if (slim) events.push(slim);
    } catch {
      /* 单行坏了跳过，不让整个回放挂掉 */
    }
  }
  let sessionKey: string | undefined;
  let generatedAt: string | undefined;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Json;
    sessionKey = str(m.sessionKey) || undefined;
    generatedAt = str(m.generatedAt) || undefined;
  } catch {
    /* manifest 缺了也能回放 */
  }
  const data = { ok: true as const, name, sessionKey, generatedAt, runs: buildTimeline(events), eventCount: events.length };
  eventCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
};

// ===== 导出执行（同一时间只允许一个） =====
let exporting = false;

const doExport = async (sessionKey: string): Promise<string> => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const out =
    `rana-web-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  await execFileP(process.execPath, [OPENCLAW_MJS, "sessions", "export-trajectory", "--session-key", sessionKey, "--output", out, "--workspace", STATE_HOME, "--json"], {
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, OPENCLAW_STATE_DIR: STATE_HOME },
  });
  return out;
};

export function ranaTrajectoryMiddleware(): Plugin {
  const handler = (req: { method?: string; url?: string; socket?: { remoteAddress?: string }; headers?: Record<string, unknown>; on: (ev: string, cb: (c?: string) => void) => void }, res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string | Buffer) => void }) => {
    void (async () => {
      // 轨迹含完整对话与装配 prompt：一律仅本机
      if (!isLoopback(req)) {
        json(res, 403, { error: "仅本机可访问" });
        return;
      }
      const u = new URL(req.url ?? "/", "http://x");
      const route = u.pathname.replace(/\/+$/, "") || "/";

      // GET /list —— 导出清单
      if (req.method === "GET" && route === "/list") {
        const rows: Json[] = [];
        try {
          for (const name of fs.readdirSync(EXPORTS_DIR)) {
            const dir = path.join(EXPORTS_DIR, name);
            try {
              const m = asObj(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")));
              let sizeBytes: number | undefined;
              try {
                sizeBytes = fs.statSync(path.join(dir, "events.jsonl")).size;
              } catch {
                /* 缺 events.jsonl 的残包也能列出来，点了会 404 */
              }
              rows.push({
                name,
                sessionKey: str(m.sessionKey),
                generatedAt: str(m.generatedAt),
                eventCount: num(m.eventCount),
                sizeBytes,
              });
            } catch {
              /* 没 manifest 的目录跳过 */
            }
          }
        } catch {
          /* 导出目录还不存在 = 清单为空 */
        }
        rows.sort((a, b) => String(b.generatedAt ?? "").localeCompare(String(a.generatedAt ?? "")));
        json(res, 200, { ok: true, exports: rows });
        return;
      }

      // POST /export —— 跑 CLI 导出一个会话
      if (req.method === "POST" && route === "/export") {
        const body = asObj(JSON.parse((await readBody(req)) || "{}"));
        const sessionKey = str(body.sessionKey).trim();
        if (!SESSION_KEY_RE.test(sessionKey)) {
          json(res, 400, { error: "sessionKey 格式不对" });
          return;
        }
        if (exporting) {
          json(res, 409, { error: "已有一个导出在进行中，稍候再试" });
          return;
        }
        exporting = true;
        try {
          const name = await doExport(sessionKey);
          json(res, 200, { ok: true, name });
        } catch (e) {
          json(res, 500, { error: `导出失败：${(e as Error).message.slice(0, 500)}` });
        } finally {
          exporting = false;
        }
        return;
      }

      // GET /events?name= —— 瘦身时间线
      if (req.method === "GET" && route === "/events") {
        const name = u.searchParams.get("name") ?? "";
        if (!NAME_RE.test(name)) {
          json(res, 400, { error: "name 格式不对" });
          return;
        }
        try {
          json(res, 200, readTimeline(name));
        } catch {
          json(res, 404, { error: "导出不存在或缺 events.jsonl" });
        }
        return;
      }

      json(res, 405, { error: "method not allowed" });
    })().catch((e: Error) => {
      json(res, 500, { error: e.message });
    });
  };

  return {
    name: "rana-trajectory",
    configureServer(server) {
      server.middlewares.use("/__rana/trajectory", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/trajectory", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
