// 列出 gateway 全部模型 + 当前会话，便于选择 E2E 目标模型
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
const request = (method, params) => new Promise((resolve, reject) => {
  const rid = String(++id);
  pending.set(rid, { resolve, reject });
  ws.send(JSON.stringify({ type: "req", id: rid, method, params }));
});
let hello = null;
ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data);
  if (f.type === "event" && f.event === "connect.challenge") {
    const { ts, nonce } = f.payload ?? {};
    const payload = buildDeviceAuthPayloadV3({
      deviceId, clientId: "webchat-ui", clientMode: "webchat", role: "operator",
      scopes: ["operator.read", "operator.write"], signedAtMs: ts ?? Date.now(), token, nonce: nonce ?? "", platform: "browser",
    });
    const rid = String(++id);
    pending.set(rid, { resolve: (p) => (hello = p), reject: () => {} });
    ws.send(JSON.stringify({ type: "req", id: rid, method: "connect", params: {
      minProtocol: 4, maxProtocol: 4,
      client: { id: "webchat-ui", version: "0.1.0", platform: "browser", mode: "webchat" },
      role: "operator", scopes: ["operator.read", "operator.write"],
      device: { id: deviceId, publicKey: publicKeyRaw.toString("base64url"), signature: cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url"), signedAt: ts ?? Date.now(), nonce: nonce ?? "" },
      auth: { token }, locale: "zh-CN",
    }}));
    return;
  }
  if (f.type === "res") {
    const p = pending.get(f.id);
    if (!p) return;
    pending.delete(f.id);
    if (f.ok) p.resolve(f.payload);
    else p.reject(new Error(f.error?.code + ": " + f.error?.message));
  }
};
ws.onopen = () => console.log("ws open");
ws.onclose = (e) => console.log("closed", e.code, e.reason);
ws.onerror = () => {};

await new Promise((r) => { const t = setInterval(() => { if (hello) { clearInterval(t); r(); } }, 100); });
const models = await request("models.list", {});
const rows = models.models ?? [];
for (const m of rows) console.log(`${m.id} | provider=${m.provider} | alias=${m.alias ?? "-"} | tags=${(m.tags ?? []).join(",")}`);
process.exit(0);
