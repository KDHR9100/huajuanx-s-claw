/**
 * cli-bridge.mjs — 「跑一轮 agent / 跑一次 CLI」的单一真相源（2026-11-14 收拢批1）。
 *
 * 收拢内容（零行为变化纪律：函数体逐字搬移）：
 *   - createAgentBridge：原 server/lib/agent-session-bridge.ts（fate/life/study 三插件互斥会话桥工厂）
 *   - runAgentBridge / DEFAULT_WAIT_MS：原 lib/agent-bridge.mjs（study/fate/life 三边车 WS 会话桥实体）
 *   - resolveStateHome / resolveOpenclawMjs：语义 = lib/rana-config.mjs:14/42 现行版（逐字同源）
 *   - spawnCli / runCli：统一 CLI 执行层（超时/输出上限/解析策略注入式），
 *     骨架取自 qq-sidecar/runner.mjs 的 AgentRunner.run（(t+30)s 硬超时 / 4MB 看门 / 首{到末}兜底）。
 * 解析策略（尾行 JSON / 首{到末} / indexOf 截取 / 裸 parse / 原文返回）各自保留为注入项；
 * 互斥留调用方（三桥 busy 在 createAgentBridge 原样保留，qq-sidecar 串行靠 SerialQueue，detached 无超时原样）。
 */
import path from "node:path";
import fs from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client/browser";

/** execFile 的 Promise 版（同 server/lib/exec.ts 现行版，逐字同源）：插件 .ts 世界与边车共用的执行件 */
export const execFileP = promisify(execFile);

/** runAgentBridge 等 final 的默认上限（中间件 execFile 超时 180s，留出余量） */
export const DEFAULT_WAIT_MS = 165000;
/** qq-sidecar AgentRunner 的 stdout 超限看门（超过即 kill 子进程） */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// ===== 状态目录与命令定位（语义 = lib/rana-config.mjs 现行版，逐字同源） =====

/** 状态目录：环境变量优先（网关启动脚本同款），缺省回退仓库内布局（本文件在 rana-web/lib/ 下，上两级即仓库根） */
export function resolveStateHome() {
  return process.env.OPENCLAW_STATE_DIR
    ? path.resolve(process.env.OPENCLAW_STATE_DIR)
    : path.resolve(fileURLToPath(new URL('../../.openclaw/.openclaw', import.meta.url)));
}

/** 网关状态库路径（密钥库 secret_store_entries 所在） */
export const STATE_HOME = resolveStateHome();

let cachedMjs = null;
/**
 * openclaw.mjs 的位置（2026-10-25 迁移批1 起，替代各脚本写死的 G:/node/node.exe + C:/Users/... 绝对路径）：
 * env OPENCLAW_MJS 优先（云端 systemd/cron 注入）→ npm root -g 探测（openclaw 装在全局）→ 裸文件名让 PATH 兜底。
 * 每个进程只探一次。
 */
export function resolveOpenclawMjs() {
  if (cachedMjs) return cachedMjs;
  if (process.env.OPENCLAW_MJS) {
    cachedMjs = process.env.OPENCLAW_MJS;
    return cachedMjs;
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, timeout: 15000 }).trim();
    const cand = path.join(root, 'openclaw', 'openclaw.mjs');
    if (fs.existsSync(cand)) {
      cachedMjs = cand;
      return cachedMjs;
    }
  } catch { /* npm 不在或慢，走 PATH 兜底 */ }
  cachedMjs = 'openclaw.mjs';
  return cachedMjs;
}

// ===== 解析策略注册表（五套现存口径逐字收录，供 runCli 的 parse 注入；批2 逐处对拍后替换散写） =====

export const PARSE = {
  /** 尾行 JSON：取 stdout 最后一行 JSON.parse（agent-session-bridge 三桥口径；坏 JSON 时抛错） */
  lastLineJson: (raw) => JSON.parse(raw.trim().split("\n").pop() ?? "{}"),
  /** 首{到末}：剥 BOM 裸 parse，失败抓第一个 { 到最后一个 }，再失败回 null（qq-sidecar runner 口径） */
  firstToLastJson: (raw) => {
    const text = raw.replace(/^\uFEFF/, '').trim();
    try {
      return JSON.parse(text);
    } catch {
      // 兜底：抓第一个 { 到最后一个 }
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(text.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  },
  /** indexOf 截取：从第一个 { 截到末尾再 JSON.parse（health-patrol 口径；无 { 或坏 JSON 时抛错） */
  indexOfSliceJson: (raw) => JSON.parse(raw.slice(raw.indexOf("{"))),
  /** 裸 parse：stdout 原样 JSON.parse（agent-info / provider-config 口径；坏 JSON 时抛错） */
  bareJson: (raw) => JSON.parse(raw),
  /** 原文返回：stdout+stderr 拼接去首尾空白（approvals 口径） */
  rawText: (_raw, ctx) => `${ctx.stdout}${ctx.stderr}`.trim(),
};
// ===== CLI 执行层（超时/输出上限/解析全部注入式；互斥一律留调用方） =====

/**
 * 低层 spawn：按策略参数拉起子进程并立即返回 ChildProcess（fire-and-forget 场景）。
 * 不挂任何监听——stdio 'ignore' + detached + unref 即可原样复刻 memory-bridge 的 detached 无超时触发。
 */
export function spawnCli(opts) {
  const {
    command = process.execPath,
    args = [],
    env,
    windowsHide = false,
    detached = false,
    stdio,
    unref = false,
  } = opts ?? {};
  const spawnOpts = {};
  if (env !== undefined) spawnOpts.env = env;
  if (windowsHide) spawnOpts.windowsHide = true;
  if (detached) spawnOpts.detached = true;
  if (stdio !== undefined) spawnOpts.stdio = stdio;
  const child = spawn(command, args, spawnOpts);
  if (unref) child.unref();
  return child;
}

/**
 * 跑到收尾的 CLI 执行：spawn + 流式收集 stdout/stderr + 可选硬超时（到点 kill）/stdout 超限看门/解析策略。
 * resolve 一个结果对象——超时/退出码/解析失败的「错误话术」一律由调用方决定（互斥同理留调用方）。
 * 骨架逐字取自 qq-sidecar/runner.mjs 的 AgentRunner.run（(t+30)s 硬超时 / 4MB 看门 / 首{到末}兜底解析）。
 */
export function runCli(opts) {
  const {
    hardTimeoutMs = 0,
    maxOutputBytes = 0,
    parse = null,
    ...spawnOpts
  } = opts ?? {};
  return new Promise((resolve, reject) => {
    const child = spawnCli(spawnOpts);
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    const hardTimeout = hardTimeoutMs > 0
      ? setTimeout(() => {
          killedByTimeout = true;
          child.kill();
        }, hardTimeoutMs)
      : null;

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (maxOutputBytes > 0 && stdout.length > maxOutputBytes) child.kill();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (hardTimeout) clearTimeout(hardTimeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (hardTimeout) clearTimeout(hardTimeout);
      let parsed = null;
      if (!killedByTimeout && parse) {
        try {
          parsed = parse(stdout, { stdout, stderr, code });
        } catch (e) {
          reject(e);
          return;
        }
      }
      resolve({ code, stdout, stderr, timedOut: killedByTimeout, parsed });
    });
  });
}

// ===== 兼容导出 1：createAgentBridge（原 server/lib/agent-session-bridge.ts，函数体逐字搬移） =====
// 专用会话桥三胞胎收拢（2026-11-06 第二波①号）：fate/life/study 三插件各自手抄
// 「spawn 边车 + agentBusy 互斥 + 尾行 JSON 解析」，连错误话术都逐字一样。
// 工厂收拢互斥与执行；差异只在 args 组装与超时，由各插件注入。三个边车契约（agent-bridge.mjs）不动。

/**
 * 造一个「她一次只干一件事」的 agent 会话桥。
 * spawn/run 都吃 args 数组与可选超时覆盖；默认 180s（与原手抄一致）。
 */
export function createAgentBridge(script, defaultTimeoutMs = 180000) {
  let busy = false;

  const spawnOnce = async (args, timeoutMs) => {
    const { stdout } = await execFileP(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: timeoutMs ?? defaultTimeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  };

  return {
    /** 免互斥直跑（原 spawnAgent 等价） */
    spawn: spawnOnce,
    /** 互斥执行：忙时抛「她正忙着上一个请求，等一下再试」（原 runAgent 等价） */
    async run(args, timeoutMs) {
      if (busy) throw new Error("她正忙着上一个请求，等一下再试");
      busy = true;
      try {
        return await spawnOnce(args, timeoutMs);
      } finally {
        busy = false;
      }
    }
  };
}

// ===== 兼容导出 2：runAgentBridge（原 lib/agent-bridge.mjs，函数体逐字搬移） =====

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
