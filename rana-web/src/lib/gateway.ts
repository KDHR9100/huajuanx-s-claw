// Rana Web ↔ OpenClaw gateway 连接层（协议 v4）。
// 握手：connect.challenge → Ed25519 设备签名（sha256(原始公钥).hex 作 deviceId）
// → connect(token + device) → hello-ok。
// 事件：chat（delta/final/aborted/error/status）、sessions.changed、shutdown。
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client/browser";
import { loadBrowserIdentity } from "./identity";
import { useAppStore } from "../store/useAppStore";
import type { ChatMessage, ModelInfo, SessionRow } from "./types";

const TOKEN_KEY = "rana-web.gateway-token";
const HELLO_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RECONNECT = 6;

const store = () => useAppStore.getState();

interface HelloOk {
  protocol: number;
  server?: { version?: string; connId?: string };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: { sessionDefaults?: { mainSessionKey?: string } };
}

interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  seq?: number;
  state: "delta" | "final" | "aborted" | "error" | "status";
  deltaText?: string;
  replace?: boolean;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> | string; text?: string };
  errorMessage?: string;
  errorKind?: string;
  stopReason?: string;
}

interface PendingReq {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function extractText(m: unknown): string {
  if (!m || typeof m !== "object") return "";
  const row = m as Record<string, unknown>;
  if (typeof row.text === "string") return row.text;
  const content = row.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => (c as Record<string, unknown>)?.type === "text")
      .map((c) => String((c as Record<string, unknown>)?.text ?? ""))
      .join("");
  }
  return "";
}

class GatewayConnection {
  private ws: WebSocket | null = null;
  private reqSeq = 0;
  private pending = new Map<string, PendingReq>();
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private wsUrl = "ws://127.0.0.1:18789";
  private token = "";
  private hello: HelloOk | null = null;
  private connecting: Promise<void> | null = null;

  get helloOk(): HelloOk | null {
    return this.hello;
  }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    this.manualClose = false;
    this.token = await this.resolveToken();
    if (!this.token) {
      store().setConn("error", "缺少 gateway token：请在设置中填写（或通过 dev 端点 /__rana/config 提供）");
      return;
    }
    store().setConn("connecting");
    const identity = await loadBrowserIdentity();

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      let opened = false;

      const helloTimeout = setTimeout(() => {
        if (!opened) {
          // 直连被拒时回退到同源 /gateway 代理
          if (this.wsUrl === "ws://127.0.0.1:18789") {
            console.warn("[gateway] 直连超时，改走 /gateway 代理");
            this.wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/gateway`;
            ws.close();
            resolve();
          }
        }
      }, 4000);

      ws.onopen = () => {
        opened = true;
        clearTimeout(helloTimeout);
      };
      ws.onerror = () => {
        if (!opened) clearTimeout(helloTimeout);
      };
      ws.onclose = () => {
        clearTimeout(helloTimeout);
        this.pending.forEach((p) => {
          clearTimeout(p.timer);
          p.reject(new Error("连接已关闭"));
        });
        this.pending.clear();
        this.ws = null;
        if (this.manualClose) {
          store().setConn("closed");
          resolve();
          return;
        }
        store().setConn("closed");
        this.scheduleReconnect();
        resolve();
      };
      ws.onmessage = (ev) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(ev.data));
        } catch {
          return;
        }

        if (frame.type === "event" && frame.event === "connect.challenge") {
          const payload = (frame.payload ?? {}) as { ts?: number; nonce?: string };
          void this.sendConnect(payload.ts ?? Date.now(), payload.nonce ?? "", identity);
          return;
        }
        if (frame.type === "res") {
          const p = this.pending.get(String(frame.id));
          if (!p) return;
          this.pending.delete(String(frame.id));
          clearTimeout(p.timer);
          if (frame.ok) p.resolve(frame.payload);
          else {
            const err = frame.error as { code?: string; message?: string } | undefined;
            p.reject(new Error(`${err?.code ?? "ERROR"}: ${err?.message ?? "unknown"}`));
          }
          return;
        }
        if (frame.type === "event") {
          void this.handleEvent(String(frame.event), frame.payload);
        }
      };
    });
  }

  private async sendConnect(signedAt: number, nonce: string, identity: Awaited<ReturnType<typeof loadBrowserIdentity>>) {
    const client = { id: "webchat-ui" as const, version: "0.1.0", platform: "browser", mode: "webchat" as const };
    let device: Record<string, unknown> | undefined;
    if (identity) {
      const payload = buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        signedAtMs: signedAt,
        token: this.token,
        nonce,
        platform: client.platform,
      });
      device = {
        id: identity.deviceId,
        publicKey: identity.publicKey,
        signature: await identity.sign(payload),
        signedAt,
        nonce,
      };
    }
    this.request(
      "connect",
      {
        minProtocol: 4,
        maxProtocol: 4,
        client,
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        ...(device ? { device } : {}),
        auth: { token: this.token },
        locale: "zh-CN",
      },
      HELLO_TIMEOUT_MS,
    )
      .then(async (payload) => {
        this.reconnects = 0;
        this.hello = payload as HelloOk;
        store().setConn("connected");
        const mainKey = this.hello?.snapshot?.sessionDefaults?.mainSessionKey;
        if (mainKey) store().setMainSessionKey(mainKey);
        await Promise.all([this.refreshModels(), this.refreshSessions()]);
        const s = store();
        if (!s.currentKey) s.setCurrentKey(mainKey ?? s.sessions[0]?.key ?? "global");
        const cur = useAppStore.getState().currentKey;
        if (cur) void this.loadHistory(cur);
      })
      .catch((e: Error) => {
        store().setConn("error", e.message);
        this.manualClose = true;
        this.ws?.close();
      });
  }

  private scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer) return;
    if (this.reconnects >= MAX_RECONNECT) {
      store().setConn("error", `重连失败 ${MAX_RECONNECT} 次，请检查 gateway 是否运行`);
      return;
    }
    const delay = Math.min(1000 * 2 ** this.reconnects, 15_000);
    this.reconnects += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private async resolveToken(): Promise<string> {
    const local = localStorage.getItem(TOKEN_KEY);
    if (local) return local;
    try {
      const res = await fetch("/__rana/config");
      if (res.ok) {
        const cfg = (await res.json()) as { token?: string };
        if (cfg.token) {
          localStorage.setItem(TOKEN_KEY, cfg.token);
          return cfg.token;
        }
      }
    } catch {
      // dev 端点不可用（生产构建）时忽略
    }
    return "";
  }

  setToken(token: string) {
    localStorage.setItem(TOKEN_KEY, token.trim());
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("gateway 未连接"));
        return;
      }
      const id = String(++this.reqSeq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ type: "req", id, method, params: params ?? {} }));
    });
  }

  private async handleEvent(event: string, payload: unknown) {
    if (event === "chat") {
      this.onChatEvent(payload as ChatEventPayload);
      return;
    }
    if (event === "sessions.changed") {
      void this.refreshSessions();
      return;
    }
    if (event === "shutdown") {
      store().setConn("closed", "gateway 正在重启");
    }
  }

  private onChatEvent(p: ChatEventPayload) {
    if (!p?.sessionKey) return;
    const key = p.sessionKey;
    const s = store();
    const run = s.runs[key];
    const ensureAssistant = (): string => {
      if (run) return run.msgId;
      const msgId = `live-${p.runId}`;
      s.appendMessage(key, { id: msgId, role: "assistant", text: "", ts: Date.now(), streaming: true });
      s.setRun(key, { runId: p.runId, msgId, text: "", lastSeq: 0 });
      return msgId;
    };

    if (p.state === "delta") {
      const msgId = ensureAssistant();
      const cur = useAppStore.getState();
      const r = cur.runs[key];
      if (!r) return;
      const nextText = p.replace ? String(p.deltaText ?? "") : r.text + String(p.deltaText ?? "");
      const seq = p.seq ?? r.lastSeq + 1;
      cur.setRun(key, { ...r, text: nextText, lastSeq: seq });
      cur.patchMessage(key, msgId, { text: nextText, streaming: true, model: cur.messages[key]?.find((m) => m.id === msgId)?.model });
      return;
    }
    if (p.state === "final") {
      const msgId = ensureAssistant();
      const finalText = extractText(p.message) || useAppStore.getState().runs[key]?.text || "";
      useAppStore.getState().patchMessage(key, msgId, { text: finalText, streaming: false });
      useAppStore.getState().setRun(key, undefined);
      void this.refreshSessions();
      return;
    }
    if (p.state === "error") {
      const msgId = ensureAssistant();
      useAppStore.getState().patchMessage(key, msgId, { streaming: false, error: p.errorMessage ?? p.errorKind ?? "运行出错" });
      useAppStore.getState().setRun(key, undefined);
      void this.refreshSessions();
      return;
    }
    if (p.state === "aborted") {
      const cur = useAppStore.getState();
      const r = cur.runs[key];
      if (r) {
        cur.patchMessage(key, r.msgId, { streaming: false });
        cur.setRun(key, undefined);
      }
      return;
    }
    // state === "status"：v1 忽略
  }

  // ---------- 高层 API ----------

  async refreshSessions() {
    try {
      const res = (await this.request("sessions.list", {})) as { sessions?: unknown[]; list?: unknown[] };
      const rows = (res.sessions ?? res.list ?? []) as Array<Record<string, unknown>>;
      const mapped: SessionRow[] = rows.map((r) => ({
        key: String(r.key),
        title: String(r.displayName ?? r.derivedTitle ?? r.label ?? r.key),
        updatedAt: (r.updatedAt as number) ?? (r.lastActivityAt as number),
        model: r.model ? String(r.model) : undefined,
        inputTokens: r.inputTokens as number | undefined,
        outputTokens: r.outputTokens as number | undefined,
        totalTokens: r.totalTokens as number | undefined,
        contextTokens: r.contextTokens as number | undefined,
        estimatedCostUsd: r.estimatedCostUsd as number | undefined,
        hasActiveRun: Boolean(r.hasActiveRun) || r.status === "running",
        sessionId: r.sessionId ? String(r.sessionId) : undefined,
        isMain: r.isMain === true,
      }));
      store().setSessions(mapped);
    } catch (e) {
      console.warn("[gateway] sessions.list 失败:", e);
    }
  }

  async refreshModels() {
    try {
      const res = (await this.request("models.list", { view: "configured" })) as { models?: unknown[]; items?: unknown[] };
      const rows = (res.models ?? res.items ?? []) as Array<Record<string, unknown>>;
      const mapped: ModelInfo[] = rows.map((r) => {
        const id = String(r.id ?? r.modelId ?? r.model ?? "");
        return {
          id,
          name: (r.name as string) ?? (r.label as string) ?? id,
          contextWindow: (r.contextWindow as number) ?? (r.maxContextTokens as number),
          alias: r.alias as string | undefined,
          provider: (r.provider as string) ?? id.split("/")[0],
        };
      });
      store().setModels(mapped);
    } catch (e) {
      console.warn("[gateway] models.list 失败:", e);
    }
  }

  async loadHistory(sessionKey: string) {
    const s = store();
    if (s.runs[sessionKey]) return; // 正在流式输出，避免覆盖
    try {
      const res = (await this.request("chat.history", { sessionKey, })) as {
        messages?: unknown[];
        sessionInfo?: Record<string, unknown>;
      };
      const rows = res.messages ?? [];
      const mapped: ChatMessage[] = [];
      for (const m of rows as Array<Record<string, unknown>>) {
        const role = String(m.role ?? "");
        if (role !== "user" && role !== "assistant") continue;
        const text = extractText(m);
        if (!text) continue;
        mapped.push({
          id: String(m.id ?? m.messageId ?? `h-${mapped.length}`),
          role: role as "user" | "assistant",
          text,
          ts: (m.timestamp as number) ?? (m.ts as number) ?? 0,
          model: m.model ? String(m.model) : undefined,
        });
      }
      store().setMessages(sessionKey, mapped);
      if (res.sessionInfo?.model) store().mergeSession({ key: sessionKey, model: String(res.sessionInfo.model) });
    } catch (e) {
      console.warn("[gateway] chat.history 失败:", e);
    }
  }

  async sendChat(sessionKey: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const idempotencyKey = crypto.randomUUID();
    const msgId = `local-${idempotencyKey}`;
    store().appendMessage(sessionKey, { id: msgId, role: "user", text: trimmed, ts: Date.now() });
    const liveId = `pending-${idempotencyKey}`;
    store().appendMessage(sessionKey, { id: liveId, role: "assistant", text: "", ts: Date.now(), streaming: true });
    store().setRun(sessionKey, { runId: idempotencyKey, msgId: liveId, text: "", lastSeq: 0 });
    try {
      const res = (await this.request("chat.send", { sessionKey, message: trimmed, idempotencyKey })) as Record<string, unknown>;
      const runId = String(res.runId ?? idempotencyKey);
      const r = store().runs[sessionKey];
      if (r && r.runId === idempotencyKey) store().setRun(sessionKey, { ...r, runId });
      void this.refreshSessions();
    } catch (e) {
      const s = store();
      s.patchMessage(sessionKey, liveId, { streaming: false, error: String((e as Error).message) });
      s.setRun(sessionKey, undefined);
    }
  }

  async abort(sessionKey: string) {
    try {
      await this.request("chat.abort", { sessionKey });
    } catch (e) {
      console.warn("[gateway] chat.abort 失败:", e);
    }
  }

  async setModel(sessionKey: string, model: string) {
    try {
      const res = (await this.request("sessions.patch", { key: sessionKey, model })) as Record<string, unknown>;
      const resolved = (res.model as string) ?? model;
      store().mergeSession({ key: sessionKey, model: resolved });
    } catch (e) {
      console.warn("[gateway] sessions.patch 失败:", e);
      throw e;
    }
  }

  async createSession(): Promise<string> {
    const res = (await this.request("sessions.create", {})) as Record<string, unknown>;
    const row = (res.session ?? res) as Record<string, unknown>;
    const key = String(row.key ?? res.key ?? "");
    if (!key) throw new Error("sessions.create 未返回 key");
    store().mergeSession({
      key,
      title: (row.displayName as string) ?? (row.derivedTitle as string) ?? "新会话",
      model: row.model as string | undefined,
      updatedAt: Date.now(),
    });
    store().setCurrentKey(key);
    store().setMessages(key, []);
    void this.refreshSessions();
    return key;
  }

  async deleteSession(sessionKey: string) {
    // 有活动 run 时先中止，避免删除被服务端拒绝
    if (store().runs[sessionKey]) await this.abort(sessionKey).catch(() => {});
    // webchat 只有 operator.write：归档属 lifecycle patch（需 sessionId 作乐观锁），
    // 之后以 archivedOnly 删除（同样只需 write 权限）
    const row = store().sessions.find((x) => x.key === sessionKey);
    if (!row?.sessionId) throw new Error("缺少会话标识（sessionId），无法删除");
    await this.request("sessions.patch", { key: sessionKey, archived: true, expectedSessionId: row.sessionId });
    await this.request("sessions.delete", { key: sessionKey, archivedOnly: true, deleteTranscript: true });
    store().removeSession(sessionKey);
    // 删除后若切到了别的会话，补加载其历史
    const next = store().currentKey;
    if (next) void this.loadHistory(next);
  }
}

export const gateway = new GatewayConnection();

// E2E 调试钩子：无头验证脚本可经 window.gw 直接调用 gateway
if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).gw = gateway;
