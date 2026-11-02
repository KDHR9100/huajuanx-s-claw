import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { RANA_WEB } from "../lib/paths";
import { json, readBody, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * QQ 陪伴边车管理端点（本机只读状态 + 启停/重启 + 白名单/群友感改配置）：
 * - GET  /__rana/qq-sidecar             状态：进程存活、心跳、QQ 号、WS 状态、白名单、群友感参数、日志尾巴、最近活动
 * - POST /__rana/qq-sidecar/control     {action:"start"|"stop"|"restart"}，仅本机回环来源
 * - POST /__rana/qq-sidecar/config      改 allow.groups/allow.private/persona/reply.maxChars，仅本机回环来源；
 *                                       只碰这几个字段，onebot token/homeDir 等原样保留；改完需重启 sidecar 生效
 *
 * 数据来源是 sidecar 自己写的 state/status.json（每 10 秒心跳）与 state/activity.jsonl；
 * GET 不返回 token。config.json 与 state/ 都在 qq-sidecar/.gitignore 里，不进公开仓库。
 */
export function ranaQqSidecarMiddleware(): Plugin {
  const DIR = path.join(RANA_WEB, "qq-sidecar");
  const ENTRY = path.join(DIR, "index.mjs");
  const CONFIG_FILE = path.join(DIR, "config.json");
  const STATUS_FILE = path.join(DIR, "state", "status.json");
  const ACTIVITY_FILE = path.join(DIR, "state", "activity.jsonl");
  const LOG_FILE = path.join(DIR, "state", "sidecar.log");
  /** 心跳超过这个时间视为状态过期（sidecar 每 10 秒写一次） */
  const STALE_MS = 45_000;

  const isAlive = (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const readStatus = (): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const readConfigSummary = () => {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "")) as {
        openclaw?: { agent?: string };
        allow?: { groups?: unknown[]; private?: unknown[] };
        persona?: Record<string, unknown>;
        reply?: { maxChars?: number };
      };
      return {
        exists: true,
        agent: cfg.openclaw?.agent ?? "",
        groups: (cfg.allow?.groups ?? []).map(String),
        private: (cfg.allow?.private ?? []).map(String),
        privateCount: (cfg.allow?.private ?? []).length,
        persona: cfg.persona ?? {},
        maxChars: cfg.reply?.maxChars ?? 500,
      };
    } catch {
      return {
        exists: false,
        agent: "",
        groups: [] as string[],
        private: [] as string[],
        privateCount: 0,
        persona: {},
        maxChars: 500,
      };
    }
  };

  const tailLines = (file: string, maxLines: number): string[] => {
    try {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  };

  const readActivity = (maxLines: number) => {
    const lines = tailLines(ACTIVITY_FILE, maxLines);
    const out: unknown[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // 半行/坏行跳过
      }
    }
    return out;
  };

  const snapshot = () => {
    const status = readStatus();
    const pid = Number(status?.pid ?? 0);
    const updatedAt = Number(status?.updatedAt ?? 0);
    const alive = isAlive(pid);
    const fresh = updatedAt > 0 && Date.now() - updatedAt < STALE_MS;
    return {
      running: alive,
      stale: alive ? !fresh : false,
      status,
      config: readConfigSummary(),
      logs: tailLines(LOG_FILE, 40),
      activity: readActivity(40),
      now: Date.now(),
      entryExists: fs.existsSync(ENTRY),
    };
  };

  const waitUntil = async (predicate: () => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return predicate();
  };

  const start = () => {
    if (!fs.existsSync(ENTRY)) return { ok: false, error: `缺少入口 ${ENTRY}` };
    if (!fs.existsSync(CONFIG_FILE)) {
      return { ok: false, error: "缺少 config.json：先复制 qq-sidecar/config.example.json 并填好 onebot.homeDir" };
    }
    const current = readStatus();
    const pid = Number(current?.pid ?? 0);
    if (pid && isAlive(pid)) return { ok: true, already: true, pid };

    const child = spawn(process.execPath, [ENTRY], {
      cwd: DIR,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  };

  const stop = async () => {
    const current = readStatus();
    const pid = Number(current?.pid ?? 0);
    const updatedAt = Number(current?.updatedAt ?? 0);
    if (!pid || !isAlive(pid)) return { ok: true, already: true };
    if (!updatedAt || Date.now() - updatedAt > STALE_MS) {
      return { ok: false, error: "心跳已过期，不敢按旧 PID 杀进程；请手动确认后重试" };
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      return { ok: false, error: `停止失败：${(error as Error).message}` };
    }
    const dead = await waitUntil(() => !isAlive(pid), 6000);
    return dead ? { ok: true, pid } : { ok: false, error: `进程 ${pid} 6 秒内没有退出` };
  };

  const parseIds = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
    const out: string[] = [];
    for (const item of value) {
      const s = String(item ?? "").trim();
      if (!/^\d{5,12}$/.test(s)) throw new Error(`${label}里有非法号码「${s || "(空)"}」，只接受 5-12 位数字`);
      if (!out.includes(s)) out.push(s);
    }
    if (out.length > 50) throw new Error(`${label}最多 50 个`);
    return out;
  };

  const numIn = (value: unknown, label: string, min: number, max: number, integer = false) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}需在 ${min}~${max} 之间`);
    return integer ? Math.round(n) : n;
  };

  /** 只改白名单 / 群友感 / 单条字数，其余字段（token、homeDir、agent、stateDir）原样保留。 */
  const saveConfig = (body: Record<string, unknown>) => {
    const allow = body.allow as { groups?: unknown; private?: unknown } | undefined;
    const persona = (body.persona ?? {}) as Record<string, unknown>;
    const reply = body.reply as { maxChars?: unknown } | undefined;
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "读不到 config.json（先复制 config.example.json 并填好 onebot）" };
    }

    const allowPatch: Record<string, unknown> = {};
    if (allow?.groups !== undefined) allowPatch.groups = parseIds(allow.groups, "群白名单");
    if (allow?.private !== undefined) allowPatch.private = parseIds(allow.private, "私聊白名单");
    cfg.allow = { ...((cfg.allow as Record<string, unknown>) ?? {}), ...allowPatch };

    const patch: Record<string, unknown> = {};
    if (persona.mergeWindowMs !== undefined) patch.mergeWindowMs = numIn(persona.mergeWindowMs, "合并窗口(毫秒)", 0, 60_000, true);
    if (persona.minReplyIntervalMs !== undefined) {
      patch.minReplyIntervalMs = numIn(persona.minReplyIntervalMs, "回复节流(毫秒)", 0, 600_000, true);
    }
    if (persona.lurkRate !== undefined) patch.lurkRate = numIn(persona.lurkRate, "潜水概率", 0, 1);
    if (persona.emojiRate !== undefined) patch.emojiRate = numIn(persona.emojiRate, "表情概率", 0, 1);
    if (persona.atTrigger !== undefined) patch.atTrigger = Boolean(persona.atTrigger);
    if (persona.typingBaseMs !== undefined) patch.typingBaseMs = numIn(persona.typingBaseMs, "打字基础延迟(毫秒)", 0, 10_000, true);
    if (persona.typingPerCharMs !== undefined) {
      patch.typingPerCharMs = numIn(persona.typingPerCharMs, "每字延迟(毫秒)", 0, 200);
    }
    if (persona.typingMaxMs !== undefined) patch.typingMaxMs = numIn(persona.typingMaxMs, "打字延迟上限(毫秒)", 0, 30_000, true);
    if (persona.keywordTrigger !== undefined) {
      if (!Array.isArray(persona.keywordTrigger)) throw new Error("关键词必须是数组");
      const kws = persona.keywordTrigger.map((k) => String(k ?? "").trim()).filter(Boolean);
      if (kws.length > 20) throw new Error("关键词最多 20 个");
      if (kws.some((k) => k.length > 24)) throw new Error("单个关键词最长 24 字");
      patch.keywordTrigger = kws;
    }
    cfg.persona = { ...((cfg.persona as Record<string, unknown>) ?? {}), ...patch };

    if (reply?.maxChars !== undefined) {
      cfg.reply = {
        ...((cfg.reply as Record<string, unknown>) ?? {}),
        maxChars: numIn(reply.maxChars, "单条最大字数", 100, 2000, true),
      };
    }

    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, CONFIG_FILE);
    return { ok: true, restartRequired: true };
  };

  const handler = (
    req: { method?: string; url?: string },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    json(res, 200, snapshot());
  };

  const controlHandler = (
    req: {
      method?: string;
      socket?: { remoteAddress?: string };
      headers?: Record<string, unknown>;
      on: (ev: string, cb: (c?: string) => void) => void;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }
    void readBody(req).then(async (raw) => {
      let action = "";
      try {
        action = String((JSON.parse(raw) as { action?: string }).action ?? "");
      } catch {
        // 坏 body 落到下面的 400
      }
      if (action === "start") {
        json(res, 200, start());
        return;
      }
      if (action === "stop") {
        json(res, 200, await stop());
        return;
      }
      if (action === "restart") {
        const stopped = await stop();
        if (!stopped.ok) {
          json(res, 200, stopped);
          return;
        }
        json(res, 200, start());
        return;
      }
      json(res, 400, { error: "action 只能是 start / stop / restart" });
    });
  };

  const configHandler = (
    req: {
      method?: string;
      socket?: { remoteAddress?: string };
      headers?: Record<string, unknown>;
      on: (ev: string, cb: (c?: string) => void) => void;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可改配置" });
      return;
    }
    void readBody(req).then((raw) => {
      try {
        const body = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
        json(res, 200, saveConfig(body));
      } catch (error) {
        json(res, 400, { error: (error as Error).message });
      }
    });
  };

  return {
    name: "rana-qq-sidecar",
    configureServer(server) {
      server.middlewares.use("/__rana/qq-sidecar/control", controlHandler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/qq-sidecar/config", configHandler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/qq-sidecar", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/qq-sidecar/control", controlHandler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/qq-sidecar/config", configHandler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/qq-sidecar", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
