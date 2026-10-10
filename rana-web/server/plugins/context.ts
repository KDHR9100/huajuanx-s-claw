import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, sign as cryptoSign, createHash, randomUUID } from "node:crypto";
// @ts-ignore —— ws 无类型声明（仅服务端中间件用）
import WebSocket from "ws";
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client/browser";
import { readGatewayToken } from "../lib/paths";
import type { Plugin } from "vite";

/**
 * 上下文体检端点：GET /__rana/context（仅本机）
 * 服务端直连 gateway（operator 设备签名），开一次性 main 会话执行 /context list 拿官方账单
 * （底稿注入 / 技能清单 / 工具 schema），补读主会话才注入的 USER/MEMORY/当日日记体积，
 * 再带主会话实时单轮输入。临时会话跑完即删，不进聊天流、不烧模型 token。
 * 每次点击都新建+删除一个临时会话，所以留给按钮手动触发，不做轮询。
 */
export function ranaContextMiddleware(): Plugin {
  const handler = async (
    req: { method?: string; url?: string; socket?: { remoteAddress?: string } },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const ra = req.socket?.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "仅本机可查询" }));
      return;
    }
    const token = readGatewayToken();
    if (!token) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "拿不到 gateway token（openclaw.json）" }));
      return;
    }
    // ?sessionKey= 指定要体检的会话（账单按该会话所属 agent 装配计算）；缺省测 main 主会话
    const u = new URL(req.url ?? "/", "http://localhost");
    const sessionKey = u.searchParams.get("sessionKey") ?? "";
    try {
      const report = await probeGatewayContext(token, sessionKey || undefined);
      res.end(JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), ...report }));
    } catch (e) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  };
  return {
    name: "rana-context",
    configureServer(server) {
      server.middlewares.use("/__rana/context", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/context", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
/** 解析 /context list 输出（run 或 estimate 口径都认）：正文数字带千分位逗号 */
const parseContextReport = (text: string) => {
  const num = (s: string) => Number(s.replace(/,/g, ""));
  const sysM = text.match(/System prompt \((?:run|estimate)\): ([\d,]+) chars \(~([\d,]+) tok\)(?: \(Project Context [\d,]+ chars \(~([\d,]+) tok\)\))?/);
  const skillsM = text.match(/Skills list \(system prompt text\): ([\d,]+) chars \(~([\d,]+) tok\) \((\d+) skills\)/);
  const schemaM = text.match(/Tool schemas \(JSON\): ([\d,]+) chars \(~([\d,]+) tok\)/);
  const files: Array<{ name: string; chars: number; tok: number }> = [];
  const fileRe = /^- ([\w.]+\.md): (?:OK|MISSING)[^|]*\| raw ([\d,]+) chars \(~([\d,]+) tok\)/gm;
  for (const m of text.matchAll(fileRe)) files.push({ name: m[1], chars: num(m[2]), tok: num(m[3]) });
  return {
    sysTok: sysM ? num(sysM[2]) : 0,
    projectTok: sysM?.[3] ? num(sysM[3]) : 0,
    skillsTok: skillsM ? num(skillsM[2]) : 0,
    skillsCount: skillsM ? Number(skillsM[3]) : 0,
    schemasTok: schemaM ? num(schemaM[2]) : 0,
    files,
  };
};

/** agentId → 工作区目录（openclaw.json 显式配置优先，缺省按约定路径推） */
const resolveAgentWorkspace = (agentId: string): string => {
  try {
    const cfg = JSON.parse(fs.readFileSync("K:\\openclaw\\.openclaw\\.openclaw\\openclaw.json", "utf8")) as {
      agents?: { entries?: Record<string, { workspace?: string }> };
    };
    const ws = cfg.agents?.entries?.[agentId]?.workspace;
    if (ws) return ws;
  } catch {
    /* 配置读不到走约定路径 */
  }
  return `K:\\openclaw\\.openclaw\\.openclaw\\workspace-${agentId}`;
};

/** 该 agent 会话注入、但 /context 临时会话估算不到的底稿文件（中文按 chars/4 粗算，与官方口径一致）。
 *  exclude 传注入列表里已有的文件名（大写比较），避免同文件重复计数（RP 等装配会把 USER/MEMORY 直接列进注入）。 */
const contextExtraFiles = (workspaceDir: string, exclude?: Set<string>) => {
  const out: Array<{ name: string; chars: number; tok: number }> = [];
  for (const name of ["USER.md", "MEMORY.md"]) {
    if (exclude?.has(name.toUpperCase())) continue;
    try {
      const chars = fs.readFileSync(path.join(workspaceDir, name), "utf8").length;
      out.push({ name, chars, tok: Math.round(chars / 4) });
    } catch {
      /* 该工作区没有此文件就跳过 */
    }
  }
  try {
    const memDir = path.join(workspaceDir, "memory");
    const latest = fs.readdirSync(memDir).filter((f) => /^20\d\d-/.test(f)).sort().pop();
    if (latest) {
      const chars = fs.readFileSync(path.join(memDir, latest), "utf8").length;
      out.push({ name: `日记 ${latest}`, chars, tok: Math.round(chars / 4) });
    }
  } catch {
    /* 无日记 */
  }
  return out;
};

/** 连 gateway 收集上下文账单：临时会话跑 /context list + 目标会话实时用量；临时会话即删 */
async function probeGatewayContext(token: string, sessionKey?: string): Promise<{
  session: { key: string; agentId?: string; inputTokens?: number; contextWindow?: number };
  baseline: { sysTok: number; projectTok: number; skillsTok: number; skillsCount: number; schemasTok: number; files: Array<{ name: string; chars: number; tok: number }> };
  extra: Array<{ name: string; chars: number; tok: number }>;
}> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyRaw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");

  const ws = new WebSocket("ws://127.0.0.1:18789", { origin: "http://localhost:5173" });
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = String(++seq);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const withTimeout = <T,>(p: Promise<T>, ms: number, label: string) =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("超时: " + label)), ms))]);

  let hello: Record<string, unknown> | null = null;
  let finalText = "";

  ws.on("message", (data: Buffer) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame.type === "event" && frame.event === "connect.challenge") {
      const { ts, nonce } = (frame.payload ?? {}) as { ts?: number; nonce?: string };
      const payload = buildDeviceAuthPayloadV3({
        deviceId, clientId: "webchat-ui", clientMode: "webchat", role: "operator",
        scopes: ["operator.read", "operator.write"], signedAtMs: ts ?? Date.now(), token, nonce: nonce ?? "", platform: "browser",
      });
      request("connect", {
        minProtocol: 4, maxProtocol: 4,
        client: { id: "webchat-ui", version: "0.1.0", platform: "browser", mode: "webchat" },
        role: "operator", scopes: ["operator.read", "operator.write"],
        device: {
          id: deviceId, publicKey: publicKeyRaw.toString("base64url"),
          signature: cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url"),
          signedAt: ts ?? Date.now(), nonce: nonce ?? "",
        },
        auth: { token }, locale: "zh-CN",
      }).then((p) => {
        hello = p;
      }).catch(() => {});
      return;
    }
    if (frame.type === "res") {
      const p = pending.get(String(frame.id));
      if (!p) return;
      pending.delete(String(frame.id));
      if (frame.ok) p.resolve(frame.payload ?? {});
      else p.reject(new Error(String((frame.error as { message?: string })?.message ?? "gateway 拒绝")));
      return;
    }
    if (frame.type === "event" && frame.event === "chat") {
      const p = (frame.payload ?? {}) as { state?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
      if (p.state === "final") {
        finalText = (p.message?.content ?? []).filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("");
      }
    }
  });

  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }), 8000, "连接 gateway");

    await withTimeout(new Promise<void>((r) => {
      const t = setInterval(() => { if (hello) { clearInterval(t); r(); } }, 100);
    }), 12000, "网关握手");
    const snapshot = ((hello ?? {}) as { snapshot?: { sessionDefaults?: { mainSessionKey?: string } } }).snapshot;
    const mainKey = snapshot?.sessionDefaults?.mainSessionKey ?? "agent:main:main";

    const list = (await withTimeout(request("sessions.list", {}), 8000, "sessions.list")) as { sessions?: Array<Record<string, unknown>> };
    const rows = list.sessions ?? [];
    // 指定会话就测它（账单按该会话所属 agent 的装配算）；没指定回退主会话
    const targetRow = (sessionKey ? rows.find((s) => s.key === sessionKey) : undefined) ?? rows.find((s) => s.key === mainKey);
    if (!targetRow) throw new Error(sessionKey ? "会话不存在（可能已删除或归档）" : "找不到主会话");
    const targetKey = String(targetRow.key);
    const agentId = String(targetRow.agentId ?? "main");

    const created = (await withTimeout(request("sessions.create", { agentId }), 10000, "临时会话创建")) as Record<string, unknown>;
    const row = (created.session ?? created) as Record<string, unknown>;
    const tmpKey = String(row.key ?? created.key ?? "");
    try {
      finalText = "";
      await withTimeout(request("chat.send", { sessionKey: tmpKey, message: "/context list", idempotencyKey: randomUUID() }), 12000, "发送命令");
      await withTimeout(new Promise<void>((r) => {
        const t = setInterval(() => { if (finalText) { clearInterval(t); r(); } }, 150);
      }), 45000, "/context 回复");
      const baseline = parseContextReport(finalText);
      const injected = new Set(baseline.files.map((f) => f.name.toUpperCase()));
      return {
        session: {
          key: targetKey,
          agentId,
          inputTokens: typeof targetRow.inputTokens === "number" ? (targetRow.inputTokens as number) : undefined,
          contextWindow: typeof targetRow.contextTokens === "number" ? (targetRow.contextTokens as number) : undefined,
        },
        baseline,
        extra: contextExtraFiles(resolveAgentWorkspace(agentId), injected),
      };
    } finally {
      // 临时会话清理（尽力而为；失败只留一个空会话，可在会话页手动删）
      try {
        await withTimeout(request("sessions.patch", { key: tmpKey, archived: true, expectedSessionId: row.sessionId }), 8000, "归档临时会话");
        await withTimeout(request("sessions.delete", { key: tmpKey, archivedOnly: true, deleteTranscript: true }), 15000, "删除临时会话");
      } catch {
        /* 忽略 */
      }
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}
