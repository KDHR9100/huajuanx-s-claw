/**
 * agent-bridge.mjs — 专用会话桥接脚本（study / fate / life）的共享实现（Node 侧）。
 *
 * 背景：study-agent.mjs / fate-agent.mjs / life-agent.mjs 曾各自逐字重复约 95% 的代码
 * （ed25519 握手、extractJson、会话定位、看门狗、输出契约）。这里合并为单一实现，
 * 三个脚本退化为薄封装，只声明各自的 会话 key / 标签 / 差异参数。
 *
 * 输出契约（stdout 一行 JSON）：
 *   {ok:true, reply:"她的最终回复", data:{解析出的json} | null} 或 {ok:false, error:"原因"}
 */
import WebSocket from "ws";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client/browser";
import fs from "node:fs";
import path from "node:path";
import { STATE_HOME } from "./rana-config.mjs";

const DEFAULT_WAIT_MS = 165000; // 中间件 execFile 超时 180s，留出余量

const out = (obj) => {
  console.log(JSON.stringify(obj));
  process.exit(0);
};

/**
 * @param {object} opts
 * @param {string}   opts.sessionKey      常驻会话 key（也是默认目标会话）
 * @param {string}   opts.label           常驻会话显示名
 * @param {string}   opts.message         要发给她的完整指令文本
 * @param {string}  [opts.model]          这轮指定模型（create / patch 时带上）
 * @param {string}  [opts.overrideKey]    用指定会话替代常驻会话（一次性模式）
 * @param {string}  [opts.overrideLabel]  overrideKey 生效时的会话显示名
 * @param {boolean} [opts.ephemeral]      干完活删掉本次会话（一次性模式）
 * @param {number}  [opts.tail]           发消息前从 tailSourceKey 摘最近 N 轮拼进指令开头
 * @param {string}  [opts.tailSourceKey]  摘历史的来源会话（默认同 sessionKey）
 * @param {number}  [opts.waitMs]         等 final 的上限
 * @param {string[]}[opts.scopes]         握手 scopes
 */
export async function runAgentBridge(opts) {
  const {
    sessionKey: SESSION_KEY,
    label: SESSION_LABEL,
    message: rawMessage,
    model: wantModel = "",
    overrideKey = "",
    overrideLabel = "",
    ephemeral = false,
    tail: tailCount = 0,
    tailSourceKey = SESSION_KEY,
    waitMs = DEFAULT_WAIT_MS,
    scopes = ["operator.read", "operator.write"],
  } = opts ?? {};

  let message = rawMessage ?? "";
  if (!message) out({ ok: false, error: "缺少 --message 参数" });

  let token = "";
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(STATE_HOME, "openclaw.json"), "utf8"));
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

  // 这轮实际用哪个会话接收回复（默认常驻会话；一次性模式是调用方传进来的）
  const targetKey = overrideKey || SESSION_KEY;

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
    out({ ok: false, error: `超时（${Math.round(waitMs / 1000)}s 内没等到她干完）` });
  }, waitMs + 10000);

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
        role: "operator", scopes,
        signedAtMs: ts ?? Date.now(), token, nonce: nonce ?? "", platform: "browser",
      });
      const rid = String(++seq);
      pending.set(rid, { resolve: (p) => (hello = p), reject: () => {} });
      ws.send(JSON.stringify({
        type: "req", id: rid, method: "connect",
        params: {
          minProtocol: 4, maxProtocol: 4,
          client: { id: "webchat-ui", version: "0.1.0", platform: "browser", mode: "webchat" },
          role: "operator", scopes,
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
      if (p.sessionKey && p.sessionKey !== targetKey) return;
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

    // 0) 可选：从常驻会话摘最近 N 轮对话当背景（"只带最近几条"模式）
    if (tailCount > 0) {
      try {
        const hist = await request("chat.history", { sessionKey: tailSourceKey });
        const msgs = (hist.messages ?? [])
          .map((m) => ({ role: String(m.role ?? ""), text: String(m.content ?? "") }))
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.text);
        const picked = msgs.slice(-(tailCount * 2)); // 一轮 = 一问一答
        if (picked.length) {
          const lines = picked.map((m) => `${m.role === "user" ? "主人" : "Rana"}：${m.text}`);
          message = `【近期对话背景（只要这 ${tailCount} 轮，更早的不用管）】\n${lines.join("\n")}\n\n${message}`;
        }
      } catch { /* 摘不到历史就不带，指令照发 */ }
    }

    // 2) 找到/创建这轮要用的会话
    let sessionKey = "";
    try {
      const list = await request("sessions.list", {});
      const hit = (list.sessions ?? []).find((s) => s.key === targetKey);
      if (hit) sessionKey = hit.key;
    } catch { /* list 失败不致命，下面直接试创建 */ }
    if (!sessionKey) {
      try {
        const created = await request("sessions.create", {
          key: targetKey,
          agentId: "main",
          label: overrideKey ? (overrideLabel || SESSION_LABEL) : SESSION_LABEL,
          ...(wantModel ? { model: wantModel } : {}), // 创建时直接带上模型
        });
        sessionKey = created.key ?? targetKey;
      } catch (e) {
        // 已存在等并发情形：再 list 一次兜底
        const list = await request("sessions.list", {});
        const hit = (list.sessions ?? []).find((s) => s.key === targetKey);
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
      const t = setTimeout(() => reject(new Error(`${Math.round(waitMs / 1000)}s 内没等到她干完`)), waitMs);
      const timer = setInterval(() => {
        if (finalText || runError) { clearInterval(timer); clearTimeout(t); resolve(); }
      }, 200);
    });
    if (runError) throw new Error("她那边出错了：" + runError);

    // 一次性会话：干完就删，别留在侧栏
    if (ephemeral && overrideKey) {
      try { await request("sessions.delete", { key: sessionKey }); } catch { /* 删不掉也无妨 */ }
    }
    clearTimeout(watchdog);
    out({ ok: true, reply: finalText, data: extractJson(finalText) });
  } catch (e) {
    clearTimeout(watchdog);
    try { ws.close(); } catch { /* 已断开 */ }
    out({ ok: false, error: e.message });
  }
}
