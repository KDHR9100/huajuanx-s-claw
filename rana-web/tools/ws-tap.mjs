#!/usr/bin/env node
// ws-tap —— 网关直播事件面探针（可观测性方向1查证用，2026-10-14）
//
// 做什么：以 operator 身份连本机网关 ws://127.0.0.1:18789，复刻 rana-web 前端的订阅方式
// （sessions.subscribe 全量 + 目标会话 sessions.messages.subscribe），开一个临时 main 会话，
// 发一条必定触发 read 工具调用的消息，把来回所有 WS 帧原样录进 %TEMP%/openclaw/ws-tap-<时间戳>.jsonl，
// 终态后删临时会话退出，并在 stdout 打一份事件面小结。
//
// 回答的问题：聊天进行中这条连接到底能收到哪些事件——
// chat 的 status/delta 各阶段、session.tool（工具调用镜像）、agent 事件（stream:"tool"）、
// session.message（落库）等，为「直播层」可行性定案。
//
// 花费：一 turn 云端模型 token（与「上下文体检」按钮同款模式）；临时会话即删。
// 安全：token 运行时从状态目录配置读，不落盘；录像含会话内容，只写本地 %TEMP%。
// 依赖：本目录归属 rana-web（ws / @openclaw/gateway-client 从 rana-web/node_modules 解析）。
//
// 用法：node rana-web/tools/ws-tap.mjs   （可选环境变量 OPENCLAW_STATE_DIR 覆盖状态目录）

import { generateKeyPairSync, sign as cryptoSign, createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client/browser";

// ===== 路径与配置 =====
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const STATE_HOME = process.env.OPENCLAW_STATE_DIR
  ? path.resolve(process.env.OPENCLAW_STATE_DIR)
  : path.join(REPO_ROOT, ".openclaw", ".openclaw");

const readToken = () => {
  for (const file of [path.join(STATE_HOME, "openclaw.json"), path.join(os.homedir(), ".openclaw", "openclaw.json")]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      const token = cfg?.gateway?.auth?.token;
      if (token) return token;
    } catch {
      /* 试下一个 */
    }
  }
  return "";
};

const token = readToken();
if (!token) {
  console.error("[ws-tap] 拿不到 gateway token（" + path.join(STATE_HOME, "openclaw.json") + " 的 gateway.auth.token）");
  process.exit(1);
}

const stamp = new Date();
const pad = (n) => String(n).padStart(2, "0");
const RUN_TAG =
  `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
  `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
const LOG_DIR = path.join(os.tmpdir(), "openclaw");
const LOG_FILE = path.join(LOG_DIR, `ws-tap-${RUN_TAG}.jsonl`);
fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: "ax" });

/** 收发帧全量落盘（大帧截断到 64KB，防异常巨帧撑爆文件；截断标记 truncated:true） */
const record = (dir, frame) => {
  let line = JSON.stringify({ t: new Date().toISOString(), dir, frame });
  if (line.length > 65536) {
    line = JSON.stringify({ t: new Date().toISOString(), dir, truncated: true, head: line.slice(0, 65536) });
  }
  logStream.write(line + "\n");
};

// ===== 连接与请求基建（照 server/plugins/context.ts 的握手范本） =====
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyRaw = Buffer.from((publicKey.export({ format: "jwk" })).x, "base64url");
const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");

const ws = new WebSocket("ws://127.0.0.1:18789", { origin: "http://localhost:5173" });
let seq = 0;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    record("out", { type: "req", id, method, params });
  });
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("超时: " + label)), ms))]);

// ===== 事件面统计 =====
const stats = {
  framesIn: 0,
  framesOut: 0,
  byEvent: new Map(), // "event:state|stream" → 次数
  chatStates: new Set(),
  statusPhases: new Set(),
  sessionTool: [], // {name, phase} 摘要
  agentStreams: new Map(), // stream → 次数
  errors: [],
};
const bump = (k) => stats.byEvent.set(k, (stats.byEvent.get(k) ?? 0) + 1);

let hello = null;
let tmpKey = "";
let tmpSessionId = "";
let finished = false;

const note = (frame) => {
  if (frame.type !== "event") return;
  const ev = String(frame.event ?? "?");
  const p = frame.payload ?? {};
  if (ev === "chat") {
    const state = String(p.state ?? "?");
    stats.chatStates.add(state);
    bump(`chat:${state}`);
    if (state === "status" && p.phase) stats.statusPhases.add(String(p.phase));
  } else if (ev === "agent") {
    const stream = String(p.stream ?? "?");
    stats.agentStreams.set(stream, (stats.agentStreams.get(stream) ?? 0) + 1);
    bump(`agent:${stream}`);
    if (stream === "tool" && p.data?.name) stats.sessionTool.push({ via: "agent", name: String(p.data.name), phase: String(p.data.phase ?? "") });
  } else if (ev === "session.tool") {
    bump("session.tool");
    stats.sessionTool.push({
      via: "session.tool",
      name: String(p.data?.name ?? p.name ?? "?"),
      phase: String(p.data?.phase ?? p.phase ?? ""),
    });
  } else {
    bump(ev);
  }
};

const cleanupAndExit = async (code) => {
  if (finished) return;
  finished = true;
  // 临时会话清理（尽力而为；失败只留一个空会话，可在会话页手动删）
  try {
    if (tmpKey) {
      await withTimeout(request("sessions.messages.unsubscribe", { key: tmpKey }), 5000, "退订").catch(() => {});
      await withTimeout(
        request("sessions.patch", { key: tmpKey, archived: true, ...(tmpSessionId ? { expectedSessionId: tmpSessionId } : {}) }),
        8000,
        "归档临时会话",
      );
      await withTimeout(request("sessions.delete", { key: tmpKey, archivedOnly: true, deleteTranscript: true }), 15000, "删除临时会话");
    }
  } catch (e) {
    console.error("[ws-tap] 临时会话清理失败：" + e.message);
  }
  // 等落盘
  await new Promise((r) => logStream.end(r));
  // ===== 小结 =====
  const toolViaSessionTool = stats.sessionTool.filter((x) => x.via === "session.tool").length;
  const toolViaAgent = stats.sessionTool.filter((x) => x.via === "agent").length;
  console.log("===== ws-tap 事件面小结 =====");
  console.log(`录像文件: ${LOG_FILE}`);
  console.log(`收帧 ${stats.framesIn} / 发帧 ${stats.framesOut}`);
  console.log(`事件分布: ${[...stats.byEvent.entries()].map(([k, v]) => `${k}×${v}`).join(", ") || "(无)"}`);
  console.log(`chat states: ${[...stats.chatStates].join(", ") || "(无)"}`);
  console.log(`status phases: ${[...stats.statusPhases].join(", ") || "(无)"}`);
  console.log(`agent streams: ${[...stats.agentStreams.entries()].map(([k, v]) => `${k}×${v}`).join(", ") || "(无)"}`);
  console.log(`工具调用直播: session.tool×${toolViaSessionTool}, agent(tool)×${toolViaAgent}`);
  if (stats.sessionTool.length) console.log(`工具明细: ${stats.sessionTool.map((x) => `${x.name}(${x.phase})`).join(", ")}`);
  if (stats.errors.length) console.log(`错误帧: ${stats.errors.join("; ")}`);
  try {
    ws.close();
  } catch {
    /* 已关 */
  }
  process.exit(code);
};

// 总闸：150 秒还没等到终态就强制收尾（防挂死）
setTimeout(() => {
  console.error("[ws-tap] 150 秒未等到终态，强制收尾");
  void cleanupAndExit(2);
}, 150_000).unref();

ws.on("message", (data) => {
  let frame;
  try {
    frame = JSON.parse(data.toString());
  } catch {
    return;
  }
  stats.framesIn++;
  record("in", frame);
  note(frame);

  if (frame.type === "event" && frame.event === "connect.challenge") {
    const { ts, nonce } = frame.payload ?? {};
    // client.id 网关侧是白名单枚举，非白名单值直接 INVALID_REQUEST——用 rana-web 同款 webchat-ui
    const payload = buildDeviceAuthPayloadV3({
      deviceId,
      clientId: "webchat-ui",
      clientMode: "webchat",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      signedAtMs: ts ?? Date.now(),
      token,
      nonce: nonce ?? "",
      platform: "browser",
    });
    request("connect", {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: "webchat-ui", version: "0.1.0", platform: "browser", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      device: {
        id: deviceId,
        publicKey: publicKeyRaw.toString("base64url"),
        signature: cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url"),
        signedAt: ts ?? Date.now(),
        nonce: nonce ?? "",
      },
      auth: { token },
      locale: "zh-CN",
    })
      .then((p) => {
        hello = p;
      })
      .catch((e) => {
        console.error("[ws-tap] 网关握手被拒：" + e.message);
        void cleanupAndExit(1);
      });
    return;
  }

  if (frame.type === "res") {
    const p = pending.get(String(frame.id));
    if (!p) return;
    pending.delete(String(frame.id));
    if (frame.ok) p.resolve(frame.payload ?? {});
    else {
      const msg = String(frame.error?.message ?? "gateway 拒绝");
      stats.errors.push(`${frame.error?.code ?? "ERR"}: ${msg}`);
      p.reject(new Error(msg));
    }
    return;
  }

  // 终态判定：目标会话的 chat 事件到 final/aborted/error 后，留 2.5 秒收尾随事件再清理
  if (frame.type === "event" && frame.event === "chat" && tmpKey && frame.payload?.sessionKey === tmpKey) {
    const st = String(frame.payload.state ?? "");
    if (st === "final" || st === "aborted" || st === "error") {
      setTimeout(() => void cleanupAndExit(0), 2500).unref();
    }
  }
});

ws.on("open", async () => {
  try {
    await withTimeout(
      new Promise((r) => {
        const t = setInterval(() => {
          if (hello) {
            clearInterval(t);
            r();
          }
        }, 100);
      }),
      15000,
      "网关握手",
    );

    // 复刻 rana-web 前端的订阅面：全量会话事件 + 临时会话消息流
    await withTimeout(request("sessions.subscribe", {}), 8000, "sessions.subscribe");
    const created = await withTimeout(request("sessions.create", { agentId: "main" }), 10000, "临时会话创建");
    const row = created.session ?? created;
    tmpKey = String(row.key ?? created.key ?? "");
    tmpSessionId = String(row.sessionId ?? "");
    if (!tmpKey) throw new Error("创建结果里没有 session key");
    console.log(`[ws-tap] 临时会话: ${tmpKey}`);
    await withTimeout(request("sessions.messages.subscribe", { key: tmpKey }), 8000, "订阅消息流");

    await withTimeout(
      request("chat.send", {
        sessionKey: tmpKey,
        message: "请用 read 工具读取 K:/OpenClaw/README.md 的前 5 行，然后用一句话总结这个仓库是做什么的。",
        idempotencyKey: randomUUID(),
      }),
      15000,
      "发送消息",
    );
    console.log("[ws-tap] 消息已发出，等待事件流…");
  } catch (e) {
    console.error("[ws-tap] 启动阶段失败：" + e.message);
    void cleanupAndExit(1);
  }
});

ws.on("error", (e) => {
  console.error("[ws-tap] WS 错误：" + e.message);
});
ws.on("close", () => {
  if (!finished) {
    console.error("[ws-tap] 连接意外断开");
    void cleanupAndExit(1);
  }
});
