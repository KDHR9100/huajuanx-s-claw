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
/** 删除链路专用超时：服务端串行删除单个 ~7s，排队时更要留足余量 */
const DELETE_TIMEOUT_MS = 120_000;
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
  /** state=status 时的生命周期阶段（preparing_workspace…starting_model） */
  phase?: string;
}

interface PendingReq {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** session.message 事件载荷：单条落库消息（含微信等外部渠道写入的） */
interface SessionMessagePayload {
  sessionKey: string;
  agentId?: string;
  message?: Record<string, unknown>;
  messageId?: string;
  messageSeq?: number;
  runId?: string;
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
  /** 乐观创建中的会话：tempKey → 服务端真实 key 的 Promise（sendChat/delete 需先等它） */
  private pendingCreates = new Map<string, Promise<string>>();
  /** 正在后台删除的会话 key：防止列表刷新把会话短暂“复活” */
  private deletingKeys = new Set<string>();
  /** 删除操作串行队列：服务端逐个处理，客户端排队避免超时堆积 */
  private deleteChain: Promise<void> = Promise.resolve();
  /** 已订阅消息流的会话 key（微信等外部渠道的 chat/session.message 事件只投给订阅连接） */
  private msgSubKey: string | null = null;
  /** 刚终态的 runId 缓存：chat final 已渲染的回复，忽略随后重复的落库事件 */
  private finalRunIds = new Set<string>();
  /** sessions.changed 触发的列表刷新防抖 */
  private sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;

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
        this.msgSubKey = null; // 重连后会随 hello-ok 重新订阅
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
        scopes: ["operator.read", "operator.write", "operator.admin"],
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
        scopes: ["operator.read", "operator.write", "operator.admin"],
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
        // 全量订阅会话事件（sessions.changed / session.message，其他会话只用于标未读），
        // 当前会话再单独订阅消息流以收到微信等外部渠道的流式 chat 事件
        void this.request("sessions.subscribe", {}).catch(() => {});
        void this.syncMessageSubscription(cur);
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
    if (event === "session.message") {
      this.onSessionMessage(payload as SessionMessagePayload);
      return;
    }
    if (event === "sessions.changed") {
      const p = (payload ?? {}) as { sessionKey?: string; phase?: string };
      // 非当前会话有新落库消息 → 标未读（当前会话的消息由订阅流实时渲染）
      if (p.sessionKey && p.sessionKey !== store().currentKey && p.phase === "message") {
        store().markUnread(p.sessionKey);
      }
      this.scheduleRefreshSessions();
      return;
    }
    if (event === "cron") {
      // 定时任务有变动（run/job 变更）→ 通知订阅者（CronPage 自动刷新）
      for (const cb of this.cronEventListeners) {
        try {
          cb(payload);
        } catch {
          /* 订阅者自己兜错 */
        }
      }
      return;
    }
    if (event === "shutdown") {
      store().setConn("closed", "gateway 正在重启");
    }
  }

  private cronEventListeners = new Set<(payload: unknown) => void>();
  /** 订阅网关 cron 事件（任务运行/变更时触发）；返回取消订阅函数 */
  onCronEvent(cb: (payload: unknown) => void): () => void {
    this.cronEventListeners.add(cb);
    return () => this.cronEventListeners.delete(cb);
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
      cur.patchMessage(key, msgId, { text: nextText, streaming: true, status: undefined, model: cur.messages[key]?.find((m) => m.id === msgId)?.model });
      return;
    }
    if (p.state === "final") {
      this.rememberFinalRun(p.runId);
      const msgId = ensureAssistant();
      const finalText = extractText(p.message) || useAppStore.getState().runs[key]?.text || "";
      useAppStore.getState().patchMessage(key, msgId, { text: finalText, streaming: false, status: undefined });
      useAppStore.getState().setRun(key, undefined);
      void this.refreshSessions();
      return;
    }
    if (p.state === "error") {
      this.rememberFinalRun(p.runId);
      const msgId = ensureAssistant();
      useAppStore.getState().patchMessage(key, msgId, { streaming: false, status: undefined, error: p.errorMessage ?? p.errorKind ?? "运行出错" });
      useAppStore.getState().setRun(key, undefined);
      void this.refreshSessions();
      return;
    }
    if (p.state === "aborted") {
      this.rememberFinalRun(p.runId);
      const cur = useAppStore.getState();
      const r = cur.runs[key];
      if (r) {
        cur.patchMessage(key, r.msgId, { streaming: false, status: undefined });
        cur.setRun(key, undefined);
      }
      return;
    }
    // state === "status"：生命周期阶段（准备工作区/启动模型…），显示在气泡内的状态行
    if (p.state === "status") {
      const msgId = ensureAssistant();
      const cur = useAppStore.getState();
      const r = cur.runs[key];
      const phase = typeof p.phase === "string" ? p.phase : "";
      if (r) cur.setRun(key, { ...r, status: phase });
      cur.patchMessage(key, msgId, { status: phase });
      return;
    }
  }

  /** 落库消息推送（sessions.subscribe / sessions.messages.subscribe）：外部渠道对话的实时入库 */
  private onSessionMessage(p: SessionMessagePayload) {
    if (!p?.sessionKey) return;
    const key = p.sessionKey;
    const s = store();
    if (key !== s.currentKey) {
      s.markUnread(key);
      return;
    }
    const msg = p.message ?? {};
    const role = String(msg.role ?? "");
    if (role !== "user" && role !== "assistant") return;
    // 该回复已由 chat 流式事件渲染（run 进行中，或 final 已落）→ 跳过
    if (role === "assistant" && (s.runs[key] || (p.runId !== undefined && this.finalRunIds.has(p.runId)))) return;
    const text = extractText(msg);
    if (!text) return;
    const list = s.messages[key] ?? [];
    // 本地乐观追加/流式渲染过的消息会再收到一份落库事件，按内容去重。
    // compaction 会让 user 落库事件晚于 assistant 回复到达，只比对最后一条会漏 → 扫最近几条
    if (list.slice(-8).some((m) => m.role === role && m.text === text)) return;
    s.appendMessage(key, {
      id: String(p.messageId ?? `sm-${p.messageSeq ?? Date.now()}`),
      role: role as "user" | "assistant",
      text,
      ts: (msg.timestamp as number) ?? (msg.ts as number) ?? Date.now(),
      model: msg.model ? String(msg.model) : undefined,
    });
  }

  /** 换绑当前会话的消息订阅：微信等外部渠道的事件只投给订阅连接 */
  async syncMessageSubscription(key?: string) {
    if (!key || key === this.msgSubKey || key.startsWith("pending-create:")) return;
    const prev = this.msgSubKey;
    this.msgSubKey = key;
    if (prev) void this.request("sessions.messages.unsubscribe", { key: prev }).catch(() => {});
    try {
      await this.request("sessions.messages.subscribe", { key });
    } catch (e) {
      console.warn("[gateway] sessions.messages.subscribe 失败:", e);
      this.msgSubKey = null;
    }
  }

  private rememberFinalRun(runId: string) {
    if (!runId) return;
    this.finalRunIds.add(runId);
    if (this.finalRunIds.size > 50) {
      const oldest = this.finalRunIds.values().next().value;
      if (oldest !== undefined) this.finalRunIds.delete(oldest);
    }
  }

  /** sessions.changed 每次落库都发，列表刷新做尾部防抖 */
  private scheduleRefreshSessions() {
    if (this.sessionRefreshTimer) return;
    this.sessionRefreshTimer = setTimeout(() => {
      this.sessionRefreshTimer = null;
      void this.refreshSessions();
    }, 1500);
  }

  // ---------- 高层 API ----------

  async refreshSessions() {
    try {
      const res = (await this.request("sessions.list", {})) as { sessions?: unknown[]; list?: unknown[] };
      const rows = (res.sessions ?? res.list ?? []) as Array<Record<string, unknown>>;
      const mapped: SessionRow[] = rows.map((r) => ({
        key: String(r.key),
        // 用户设置的自定义标签（sessions.patch label）优先于服务端派生标题
        title: String(r.label ?? r.displayName ?? r.derivedTitle ?? r.key),
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
      // 后台删除中的会话先过滤掉，避免陈旧列表让刚删的会话闪回
      const kept = mapped.filter((r) => !this.deletingKeys.has(r.key));
      // 乐观创建中的占位会话：服务端列表还没有它，保留以免被刷新冲掉
      const pendingRows = store().sessions.filter(
        (x) => x.key.startsWith("pending-create:") && !kept.some((m) => m.key === x.key),
      );
      store().setSessions(pendingRows.length ? [...pendingRows, ...kept] : kept);
    } catch (e) {
      console.warn("[gateway] sessions.list 失败:", e);
    }
  }

  async refreshModels() {
    try {
      // 多智能体模式下 gateway 要求显式 owner；模型目录对两个 agent 一致，用 main 的即可
      const res = (await this.request("models.list", { view: "configured", agentId: "main" })) as { models?: unknown[]; items?: unknown[] };
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
    // 会话处于乐观创建期：先等后台创建拿到真实 key 再发送
    let key = sessionKey;
    if (key.startsWith("pending-create:")) {
      const p = this.pendingCreates.get(key);
      if (!p) return; // 创建已失败并被清理
      try {
        key = await p;
      } catch {
        return;
      }
    }
    const idempotencyKey = crypto.randomUUID();
    const msgId = `local-${idempotencyKey}`;
    store().appendMessage(key, { id: msgId, role: "user", text: trimmed, ts: Date.now() });
    const liveId = `pending-${idempotencyKey}`;
    store().appendMessage(key, { id: liveId, role: "assistant", text: "", ts: Date.now(), streaming: true });
    store().setRun(key, { runId: idempotencyKey, msgId: liveId, text: "", lastSeq: 0 });
    try {
      const res = (await this.request("chat.send", { sessionKey: key, message: trimmed, idempotencyKey })) as Record<string, unknown>;
      const runId = String(res.runId ?? idempotencyKey);
      const r = store().runs[key];
      if (r && r.runId === idempotencyKey) store().setRun(key, { ...r, runId });
      void this.refreshSessions();
    } catch (e) {
      const s = store();
      s.patchMessage(key, liveId, { streaming: false, error: String((e as Error).message) });
      s.setRun(key, undefined);
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

  async createSession(agentId?: string): Promise<string> {
    // 乐观创建：先插入本地占位会话并立即切换（服务端创建含 SQLite 写入较慢），
    // 完成后把消息/运行态迁移到真实 key；期间发消息会先等创建完成（见 sendChat）
    const tempKey = `pending-create:${crypto.randomUUID()}`;
    store().mergeSession({ key: tempKey, title: agentId === "rana-rp" ? "Rana·RP" : "新会话", updatedAt: Date.now() });
    store().setCurrentKey(tempKey);
    store().setMessages(tempKey, []);
    const pending = this.request("sessions.create", { agentId: agentId ?? "main" })
      .then((raw) => {
        const res = raw as Record<string, unknown>;
        const row = (res.session ?? res) as Record<string, unknown>;
        const key = String(row.key ?? res.key ?? "");
        if (!key) throw new Error("sessions.create 未返回 key");
        this.migratePendingSession(tempKey, key, row);
        return key;
      })
      .catch((e: Error) => {
        store().removeSession(tempKey);
        window.alert(`新建会话失败：${e.message}`);
        throw e;
      });
    this.pendingCreates.set(tempKey, pending);
    pending.finally(() => this.pendingCreates.delete(tempKey)).catch(() => {});
    return tempKey;
  }

  /** 乐观创建完成：把占位会话下的本地状态迁移到服务端真实 key */
  private migratePendingSession(tempKey: string, key: string, row: Record<string, unknown>) {
    const s = store();
    const msgs = s.messages[tempKey];
    const run = s.runs[tempKey];
    // removeSession 对"当前会话"会切到回退会话，先记住是否占位会话正处于活跃态
    const wasCurrent = s.currentKey === tempKey;
    store().removeSession(tempKey);
    store().mergeSession({
      key,
      title: (row.displayName as string) ?? (row.derivedTitle as string) ?? "新会话",
      model: row.model as string | undefined,
      updatedAt: Date.now(),
      // create 响应自带 sessionId：立即可删，不必等下一次列表刷新
      sessionId: row.sessionId ? String(row.sessionId) : undefined,
    });
    if (msgs?.length) store().setMessages(key, msgs);
    if (run) store().setRun(key, run);
    if (wasCurrent) store().setCurrentKey(key);
    void this.refreshSessions();
  }

  /** 重命名会话：乐观更新标题，服务端 sessions.patch label 为权威来源 */
  async renameSession(sessionKey: string, label: string) {
    if (sessionKey.startsWith("pending-create:")) throw new Error("会话还在创建中，请稍后再试");
    store().mergeSession({ key: sessionKey, title: label });
    try {
      await this.request("sessions.patch", { key: sessionKey, label });
    } catch (e) {
      // 失败回滚：以服务端列表标题为准
      void this.refreshSessions();
      throw e;
    }
  }

  async deleteSession(sessionKey: string) {
    // 会话还在乐观创建期：先等真实 key（创建失败则已被清理，无需再删）
    let key = sessionKey;
    if (key.startsWith("pending-create:")) {
      const p = this.pendingCreates.get(key);
      if (!p) return;
      const real = await p.catch(() => "");
      if (!real) return;
      key = real;
    }
    // webchat 只有 operator.write：归档属 lifecycle patch（需 sessionId 作乐观锁），
    // 之后以 archivedOnly 删除（同样只需 write 权限）
    let row = store().sessions.find((x) => x.key === key);
    if (!row?.sessionId) {
      // 新建后会话行可能还没等到列表刷新（缺 sessionId），先补一次
      await this.refreshSessions();
      row = store().sessions.find((x) => x.key === key);
    }
    if (!row?.sessionId) throw new Error("缺少会话标识（sessionId），无法删除");
    const wasCurrent = store().currentKey === key;
    // removeSession 会清掉 runs[key]，先记住是否有活动 run（删除前需中止）
    const hadRun = Boolean(store().runs[key]);
    // 乐观移除：服务端 SQLite 删除可达 8s+，先让界面即时响应，慢操作转后台
    this.deletingKeys.add(key);
    store().removeSession(key);
    // 只有删的是当前会话才需要加载回退会话的历史，避免多余往返
    if (wasCurrent) {
      const next = store().currentKey;
      if (next) void this.loadHistory(next);
    }
    // 服务端逐个处理删除（实测单个 ~7s）：并发触发会在 30s 默认超时处堆积误报，
    // 因此客户端串行排队，且超时后先核对服务端状态再定成败
    const attempt = async () => {
      if (hadRun) await this.abort(key).catch(() => {});
      await this.request("sessions.patch", { key, archived: true, expectedSessionId: row.sessionId }, DELETE_TIMEOUT_MS);
      await this.request("sessions.delete", { key, archivedOnly: true, deleteTranscript: true }, DELETE_TIMEOUT_MS);
    };
    const task = this.deleteChain.then(async () => {
      try {
        await attempt();
      } catch (e) {
        // 超时/报错不代表真失败：请求可能在客户端放弃后才完成，先查列表核实
        if (await this.sessionStillActive(key)) {
          try {
            await attempt(); // 确认还在才重试一次
          } catch (e2) {
            // 真失败：把会话放回列表，由调用方提示错误
            this.deletingKeys.delete(key);
            store().mergeSession(row);
            void this.refreshSessions();
            throw e2;
          }
        }
      }
      // 删除完成后仍短暂过滤，防止陈旧列表把会话闪回
      setTimeout(() => this.deletingKeys.delete(key), 15_000);
    });
    this.deleteChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** 会话是否仍活跃于服务端列表（归档/删除后不再出现；查询失败按"仍在"保守处理） */
  private async sessionStillActive(key: string): Promise<boolean> {
    try {
      const res = (await this.request("sessions.list", {}, 15_000)) as { sessions?: unknown[]; list?: unknown[] };
      const rows = (res.sessions ?? res.list ?? []) as Array<Record<string, unknown>>;
      return rows.some((r) => String(r.key) === key);
    } catch {
      return true;
    }
  }
}

export const gateway = new GatewayConnection();

// 会话切换时跟随换绑消息订阅（无论从侧边栏点击还是删除回退等路径触发）
useAppStore.subscribe((s, prev) => {
  if (s.currentKey && s.currentKey !== prev.currentKey) void gateway.syncMessageSubscription(s.currentKey);
});

// E2E 调试钩子：无头验证脚本可经 window.gw 直接调用 gateway
if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).gw = gateway;
