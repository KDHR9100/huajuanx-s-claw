// E2E 验证：连接 gateway → chat.send → 流式 chat 事件 → 终态 → sessions.patch 切模型 → sessions.list 用量。
// 用法：node e2e-chat.mjs
import WebSocket from "ws";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client/browser";
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync("K:/openclaw/.openclaw/.openclaw/openclaw.json", "utf8"));
const token = cfg.gateway.auth.token;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubJwk = publicKey.export({ format: "jwk" });
const publicKeyRaw = Buffer.from(pubJwk.x, "base64url");
const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");

const ws = new WebSocket("ws://127.0.0.1:18789", { origin: "http://localhost:5173" });
let id = 0;
const pending = new Map();

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const rid = String(++id);
    pending.set(rid, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id: rid, method, params }));
  });

const timeout = (ms, label) => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout: " + label)), ms));

let hello = null;
let deltaCount = 0;
let finalText = "";

ws.onmessage = (ev) => {
  const frame = JSON.parse(ev.data);
  if (frame.type === "event" && frame.event === "connect.challenge") {
    const { ts, nonce } = frame.payload ?? {};
    const payload = buildDeviceAuthPayloadV3({
      deviceId, clientId: "webchat-ui", clientMode: "webchat",
      role: "operator", scopes: ["operator.read", "operator.write"],
      signedAtMs: ts ?? Date.now(), token, nonce: nonce ?? "", platform: "browser",
    });
    const rid = String(++id);
    pending.set(rid, { resolve: (p) => (hello = p), reject: () => {} });
    ws.send(JSON.stringify({
      type: "req", id: rid, method: "connect",
      params: {
        minProtocol: 4, maxProtocol: 4,
        client: { id: "webchat-ui", version: "0.1.0", platform: "browser", mode: "webchat" },
        role: "operator", scopes: ["operator.read", "operator.write"],
        device: { id: deviceId, publicKey: publicKeyRaw.toString("base64url"), signature: cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url"), signedAt: ts ?? Date.now(), nonce: nonce ?? "" },
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
    else p.reject(Object.assign(new Error(frame.error?.code + ": " + frame.error?.message), { error: frame.error }));
    return;
  }
  if (frame.type === "event" && frame.event === "chat") {
    const p = frame.payload ?? {};
    if (p.state === "delta") {
      deltaCount++;
      if (deltaCount <= 3) console.log(`[delta #${deltaCount}] +${JSON.stringify(p.deltaText)}`);
    } else if (p.state === "final") {
      finalText = (p.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
      console.log(`[final] runId=${p.runId} len=${finalText.length} stop=${p.stopReason ?? "-"}`);
      console.log(`[final text] ${finalText.slice(0, 160)}`);
    } else if (p.state === "error") {
      console.log(`[error] ${p.errorMessage} kind=${p.errorKind}`);
    } else if (p.state !== "status") {
      console.log(`[chat] state=${p.state}`);
    }
  } else if (frame.type === "event") {
    console.log(`[evt] ${frame.event}`, JSON.stringify(frame.payload ?? {}).slice(0, 120));
  }
};
ws.onclose = (e) => console.log("[closed]", e.code, e.reason);
ws.onerror = () => {};

try {
  await Promise.race([timeout(10000, "hello"), new Promise((r) => { const t = setInterval(() => { if (hello) { clearInterval(t); r(); } }, 100); })]);
  console.log("[hello] protocol =", hello.protocol, "| mainKey =", hello.snapshot?.sessionDefaults?.mainSessionKey);

  const before = await Promise.race([request("sessions.list", {}), timeout(8000, "sessions.list")]);
  const session = (before.sessions ?? []).find((s) => s.key === hello.snapshot?.sessionDefaults?.mainSessionKey) ?? (before.sessions ?? [])[0];
  if (!session) throw new Error("没有可用会话");
  console.log("[session] key =", session.key, "| model =", session.model, "| totalTokens =", session.totalTokens);

  // 0) 清理：把主会话模型恢复为默认 qwen3.8-flash（之前测试切到了本地 tifa）
  try { const pb = await Promise.race([request("sessions.patch", { key: session.key, model: "qwen3.8-flash" }), timeout(8000, "patch main default")]); console.log("[cleanup] main model ->", pb.model ?? "qwen3.8-flash"); } catch (e) { console.log("[cleanup] patch:", e.message); }

  // 1) 新建会话，使用默认云端模型验证全链路
  const created = await Promise.race([request("sessions.create", {}), timeout(10000, "sessions.create")]);
  const newRow = created.session ?? created;
  const newKey = newRow.key ?? created.key;
  console.log("[created] key =", newKey);

  const sendRes = await Promise.race([request("chat.send", { sessionKey: newKey, message: "1+1等于几？只回答数字", idempotencyKey: crypto.randomUUID() }), timeout(15000, "chat.send")]);
  console.log("[chat.send] status =", sendRes.status, "| runId =", sendRes.runId, "| messageSeq =", sendRes.messageSeq);

  await Promise.race([
    new Promise((_, reject) => setTimeout(() => reject(new Error("90秒内未收到 final")), 90000)),
    new Promise((r) => { const t = setInterval(() => { if (finalText) { clearInterval(t); r(); } }, 200); }),
  ]);

  // 切回主模型并汇总新会话用量
  const patchBack = await Promise.race([request("sessions.patch", { key: newKey, model: session.model }), timeout(8000, "sessions.patch back")]);
  console.log("[sessions.patch back] ->", patchBack.model);

  const after = await Promise.race([request("sessions.list", {}), timeout(8000, "sessions.list after")]);
  const row2 = (after.sessions ?? []).find((s) => s.key === newKey);
  console.log("[usage after] totalTokens =", row2?.totalTokens, "| input =", row2?.inputTokens, "| output =", row2?.outputTokens, "| context =", row2?.contextTokens, "| cost =", row2?.estimatedCostUsd);

  console.log("[E2E] OK — deltas:", deltaCount);
  process.exit(0);
} catch (e) {
  console.error("[E2E] FAILED:", e.message);
  process.exit(1);
}
