// 问卦桥接脚本：把页面发起的解卦请求送进 Rana 的专用会话，
// 等她干完活，把最终回复连同其中最后一个 ```json 结果块打印到 stdout（一行 JSON）。
// 由 vite.config.ts 的 /__rana/fate/* 中间件以子进程方式调用：
//   node fate-agent.mjs --message "完整指令文本"
// 输出契约：{ok:true, reply:"她的最终回复", data:{解析出的json} | null} 或 {ok:false, error:"原因"}
import WebSocket from "ws";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client/browser";
import fs from "node:fs";

const SESSION_KEY = "agent:main:fate-teller";
const SESSION_LABEL = "🔮 问卜";
const WAIT_FINAL_MS = 165000; // 等 final 的上限（中间件 execFile 超时 180s，留出余量）

const argv = process.argv.slice(2);
let message = "";
let wantModel = "";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--message") message = argv[i + 1] ?? "";
  if (argv[i] === "--model") wantModel = argv[i + 1] ?? "";
}
if (!message) {
  console.log(JSON.stringify({ ok: false, error: "缺少 --message 参数" }));
  process.exit(0);
}

const out = (obj) => {
  console.log(JSON.stringify(obj));
  process.exit(0);
};

let token = "";
try {
  const cfg = JSON.parse(fs.readFileSync("K:/openclaw/.openclaw/.openclaw/openclaw.json", "utf8"));
  token = cfg?.gateway?.auth?.token ?? "";
} catch (e) {
  out({ ok: false, error: "读不到 openclaw.json：" + e.message });
}
if (!token) out({ ok: false, error: "openclaw.json 里没有 gateway token" });

// ---- 设备身份与握手（照 e2e-chat.mjs 的已验证连法） ----
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubJwk = publicKey.export({ format: "jwk" });
const publicKeyRaw = Buffer.from(pubJwk.x, "base64url");
const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");

let seq = 0;
const pending = new Map();
let hello = null;
let finalText = "";
let runError = "";
let myRunId = "";

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const rid = String(++seq);
    pending.set(rid, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id: rid, method, params }));
  });

// 从回复里抠最后一个 ```json 代码块（skill 要求她最后必须输出结果块）
const extractJson = (text) => {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(blocks[i][1].trim());
    } catch {
      // 最后一块坏 JSON 时继续往前找
    }
  }
  return null;
};

const ws = new WebSocket("ws://127.0.0.1:18789", { origin: "http://localhost:5173" });

// 兜底看门狗：无论卡在哪一步，到点就报超时退出（别让中间件干等）
const watchdog = setTimeout(() => {
  out({ ok: false, error: `超时（${Math.round(WAIT_FINAL_MS / 1000)}s 内没等到她干完）` });
}, WAIT_FINAL_MS + 10000);

ws.onmessage = (ev) => {
  let frame;
  try {
    frame = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (frame.type === "event" && frame.event === "connect.challenge") {
    const { ts, nonce } = frame.payload ?? {};
    const payload = buildDeviceAuthPayloadV3({
      deviceId, clientId: "webchat-ui", clientMode: "webchat",
      role: "operator", scopes: ["operator.read", "operator.write"],
      signedAtMs: ts ?? Date.now(), token, nonce: nonce ?? "", platform: "browser",
    });
    const rid = String(++seq);
    pending.set(rid, { resolve: (p) => (hello = p), reject: () => {} });
    ws.send(JSON.stringify({
      type: "req", id: rid, method: "connect",
      params: {
        minProtocol: 4, maxProtocol: 4,
        client: { id: "webchat-ui", version: "0.1.0", platform: "browser", mode: "webchat" },
        role: "operator", scopes: ["operator.read", "operator.write"],
        device: {
          id: deviceId, publicKey: publicKeyRaw.toString("base64url"),
          signature: cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url"),
          signedAt: ts ?? Date.now(), nonce: nonce ?? "",
        },
        auth: { token }, locale: "zh-CN",
      },
    }));
    return;
  }
  if (frame.type === "res") {
    const p = pending.get(frame.id);
    if (!p) return;
    pending.delete(frame.id);
    if (frame.ok) p.resolve(frame.payload);
    else p.reject(new Error(frame.error?.code + ": " + frame.error?.message));
    return;
  }
  if (frame.type === "event" && frame.event === "chat") {
    const p = frame.payload ?? {};
    if (p.sessionKey && p.sessionKey !== SESSION_KEY) return;
    if (p.runId && myRunId && p.runId !== myRunId) return;
    if (p.state === "final") {
      finalText = (p.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
    } else if (p.state === "error") {
      runError = p.errorMessage || p.errorKind || "agent 运行出错";
    }
  }
};
ws.onclose = (e) => {
  if (!finalText && !runError) {
    clearTimeout(watchdog);
    out({ ok: false, error: `网关连接断了（code=${e.code}）` });
  }
};
ws.onerror = () => {};

try {
  // 1) 握手
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("10s 内没完成网关握手")), 10000);
    const timer = setInterval(() => {
      if (hello) { clearInterval(timer); clearTimeout(t); resolve(); }
    }, 100);
  });

  // 2) 找到/创建专用会话（固定 key，她能记住之前的排课偏好）
  let sessionKey = "";
  try {
    const list = await request("sessions.list", {});
    const hit = (list.sessions ?? []).find((s) => s.key === SESSION_KEY);
    if (hit) sessionKey = hit.key;
  } catch { /* list 失败不致命，下面直接试创建 */ }
  if (!sessionKey) {
    try {
      const created = await request("sessions.create", {
        key: SESSION_KEY,
        agentId: "main",
        label: SESSION_LABEL,
        ...(wantModel ? { model: wantModel } : {}), // 创建时直接带上模型
      });
      sessionKey = created.key ?? SESSION_KEY;
    } catch (e) {
      // 已存在等并发情形：再 list 一次兜底
      const list = await request("sessions.list", {});
      const hit = (list.sessions ?? []).find((s) => s.key === SESSION_KEY);
      if (!hit) throw e;
      sessionKey = hit.key;
    }
  }
  // 会话已存在时要换模型：patch 一下（失败不致命，用当前模型继续干）
  if (wantModel && sessionKey) {
    try {
      await request("sessions.patch", { key: sessionKey, model: wantModel });
    } catch { /* 模型切不动就用会话现有模型继续 */ }
  }

  // 3) 发消息，等她的最终回复
  const sendRes = await request("chat.send", {
    sessionKey, message, idempotencyKey: crypto.randomUUID(),
  });
  myRunId = String(sendRes?.runId ?? "");

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${Math.round(WAIT_FINAL_MS / 1000)}s 内没等到她干完`)), WAIT_FINAL_MS);
    const timer = setInterval(() => {
      if (finalText || runError) { clearInterval(timer); clearTimeout(t); resolve(); }
    }, 200);
  });
  if (runError) throw new Error("她那边出错了：" + runError);

  clearTimeout(watchdog);
  out({ ok: true, reply: finalText, data: extractJson(finalText) });
} catch (e) {
  clearTimeout(watchdog);
  try { ws.close(); } catch { /* 已断开 */ }
  out({ ok: false, error: e.message });
}
