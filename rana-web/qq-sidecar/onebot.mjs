// OneBot v11 最小客户端：WS 收事件 + HTTP 发动作。
//
// 认证口径（与 qq-bridge 的实测结论一致）：
//   - HTTP 与 WS 的 accessToken 可能不同（SnowLuma 按账号分文件配置）；
//   - 这里两个都支持，WS 优先用 query 参数，其次 Authorization 头。
// 未登录 SnowLuma 时本模块只会在重连里报错，不影响进程其它部分。
import fs from 'node:fs';
import path from 'node:path';

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30_000;

/** 读出本机所有 SnowLuma 账号的端点（http 与 ws 的 token 各自独立）。 */
function readAccounts(homeDir) {
  const out = [];
  if (!homeDir) return out;
  const dir = path.join(homeDir, 'config');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const m = /^onebot_(\d+)\.json$/i.exec(e.name);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8'));
      const nets = j?.networks ?? {};
      const http = Array.isArray(nets.httpServers) ? nets.httpServers[0] : null;
      const ws = Array.isArray(nets.wsServers) ? nets.wsServers[0] : null;
      out.push({
        uin: m[1],
        http: http ? { token: String(http.accessToken ?? ''), url: `http://${http.host || '127.0.0.1'}:${Number(http.port) || 3000}` } : null,
        ws: ws ? { token: String(ws.accessToken ?? ''), url: `ws://${ws.host || '127.0.0.1'}:${Number(ws.port) || 3001}` } : null,
      });
    } catch {
      // 单个坏文件不影响其它账号
    }
  }
  return out;
}

/**
 * 探测当前真正登录的账号。
 * 为什么不能按文件顺序取：SnowLuma 会给每个登录过的账号留一份 onebot_<QQ>.json，
 * 换号后旧文件的 token 仍然存在但会 401；拿错就会表现为「连上了但不收消息/发不出去」。
 */
export async function discoverAccount(homeDir, { timeoutMs = 6000 } = {}) {
  const accounts = readAccounts(homeDir);
  const tried = [];
  for (const acc of accounts) {
    if (!acc.http) continue;
    try {
      const res = await fetch(`${acc.http.url}/get_login_info`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(acc.http.token ? { authorization: `Bearer ${acc.http.token}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({}));
      tried.push({ uin: acc.uin, ok: body.status === 'ok' && body.retcode === 0 });
      if (body.status === 'ok' && body.retcode === 0) {
        return { ok: true, ...acc, self: body.data, tried };
      }
    } catch (error) {
      tried.push({ uin: acc.uin, ok: false, error: error?.message ?? String(error) });
    }
  }
  return { ok: false, tried, accounts: accounts.length };
}

class OneBotHttp {
  constructor({ httpUrl, token }) {
    this.base = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.token = token || '';
  }

  async call(action, params = {}, { timeoutMs = 15_000 } = {}) {
    const res = await fetch(`${this.base}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
    }
    return body.data;
  }

  sendGroup(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message, auto_escape: true });
  }

  sendPrivate(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message, auto_escape: true });
  }

  loginInfo() {
    return this.call('get_login_info', {}, { timeoutMs: 6000 });
  }
}

class OneBotWs {
  constructor({ wsUrl, token, onEvent, onStatus = () => {}, log = console.log }) {
    this.url = String(wsUrl || 'ws://127.0.0.1:3001');
    this.token = token || '';
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.log = log;
    this.ws = null;
    this.closed = false;
    this.backoff = RECONNECT_MIN_MS;
    this.selfId = null;
  }

  connect() {
    if (this.closed) return;
    const url = this.token
      ? `${this.url}${this.url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.token)}`
      : this.url;
    const headers = this.token ? { Authorization: `Bearer ${this.token}` } : undefined;
    let ws;
    try {
      ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
    } catch (error) {
      this.log(`[onebot] 创建 WebSocket 失败: ${error?.message ?? error}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = RECONNECT_MIN_MS;
      this.log(`[onebot] WS 已连接 ${this.url}`);
      this.onStatus('connected');
    };
    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      // 生命周期元事件：记住自己的 QQ 号，用于过滤自己发的消息
      if (frame.post_type === 'meta_event' && frame.meta_event_type === 'lifecycle') {
        this.selfId = frame.self_id ?? this.selfId;
        return;
      }
      if (frame.post_type === 'message' && frame.message_type === 'group' && frame.group_id) {
        this.selfId = frame.self_id ?? this.selfId;
      }
      try {
        this.onEvent(frame);
      } catch (error) {
        this.log(`[onebot] 事件处理异常: ${error?.message ?? error}`);
      }
    };
    ws.onerror = () => {
      // 具体原因在 close 里统一打日志，避免刷屏
    };
    ws.onclose = (ev) => {
      this.ws = null;
      this.onStatus('disconnected');
      if (this.closed) return;
      this.log(`[onebot] WS 断开 code=${ev.code}，${Math.round(this.backoff / 1000)}s 后重连`);
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(RECONNECT_MAX_MS, this.backoff * 2);
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // 关闭失败不影响退出
    }
  }
}

export { OneBotHttp, OneBotWs };
