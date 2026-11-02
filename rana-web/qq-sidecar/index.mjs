// qq-sidecar 入口：SnowLuma OneBot(WS) → OpenClaw(CLI) → QQ。
//
// 现状（P1 + 群友感）：
//   - 只回白名单群/私聊，会话 key 固定 qq:group:<群号> / qq:private:<QQ号>，历史连续；
//   - 群消息走「群友感」策略（persona.mjs）：合并窗口、节流、@/关键词必回、未点名时按概率潜水、
//     偶尔带表情、发送前有拟人等待；
//   - 单实例锁（端口锁）防止重复进程导致一次消息回两遍；
//   - 每 10 秒写 state/status.json 心跳，活动写 state/activity.jsonl，供 rana-web 的
//     「QQ 陪伴」页展示与启停（中间件 server/plugins/qq-sidecar.ts）；
//   - 失败只记日志，不往群里发错误信息。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OneBotHttp, OneBotWs, discoverAccount } from './onebot.mjs';
import { AgentRunner, SerialQueue } from './runner.mjs';
import { formatIncoming, segmentsToText, splitText, stripMarkdown } from './text.mjs';
import {
  decideReply,
  formatBatch,
  humanDelayMs,
  isAddressed,
  normalizePersona,
  withEmoji,
} from './persona.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.QQ_SIDECAR_CONFIG || path.join(HERE, 'config.json');
const LOCK_PORT = Number(process.env.QQ_SIDECAR_LOCK_PORT ?? 47612);
const STATUS_FILE = path.join(HERE, 'state', 'status.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`缺少配置 ${CONFIG_PATH}，请复制 config.example.json 为 config.json 并填写`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
}

function resolvePath(file) {
  return path.isAbsolute(file) ? file : path.join(HERE, file);
}

function openLog(file) {
  if (!file) return () => {};
  const abs = resolvePath(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return (line) => {
    const stamp = new Date().toISOString();
    try {
      fs.appendFileSync(abs, `${stamp} ${line}\n`, 'utf8');
    } catch {
      // 日志失败不影响主链路
    }
  };
}

/** 单实例锁：端口被占说明已有 sidecar 在跑（重复实例会把一条消息回两遍）。 */
function acquireLock(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({ ok: false, error }));
    server.listen(port, '127.0.0.1', () => resolve({ ok: true, server }));
  });
}

async function main() {
  const cfg = loadConfig();
  const fileLog = openLog(cfg.log?.file);
  const log = (msg) => {
    const line = `[qq-sidecar] ${msg}`;
    console.log(line);
    fileLog(line);
  };

  const lock = await acquireLock(LOCK_PORT);
  if (!lock.ok) {
    if (lock.error?.code === 'EADDRINUSE') log(`端口 ${LOCK_PORT} 已被占用，已有 sidecar 在跑，本进程退出`);
    else log(`单实例锁失败：${lock.error?.message ?? lock.error}，本进程退出`);
    return;
  }

  const persona = normalizePersona(cfg.persona);
  const activityFile = resolvePath(cfg.log?.activity ?? 'state/activity.jsonl');
  fs.mkdirSync(path.dirname(activityFile), { recursive: true });
  const activity = (rec) => {
    try {
      fs.appendFileSync(activityFile, `${JSON.stringify({ ts: Date.now(), ...rec })}\n`, 'utf8');
    } catch {
      // 活动日志失败不影响主链路
    }
  };

  // ---- 状态心跳：给 rana-web 的「QQ 陪伴」页读 ----
  const startedAt = Date.now();
  const stats = { received: 0, replied: 0, lurked: 0, failed: 0 };
  const status = {
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
    account: null,
    ws: 'connecting',
    groups: (cfg.allow?.groups ?? []).map(String),
    private: (cfg.allow?.private ?? []).map(String),
    agent: cfg.openclaw.agent,
    persona,
    stats,
    lastMessageAt: 0,
    lastReplyAt: 0,
    lastError: '',
  };
  const writeStatus = (patch = {}) => {
    Object.assign(status, patch, { updatedAt: Date.now(), stats: { ...stats } });
    try {
      fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
      const tmp = `${STATUS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(status), 'utf8');
      fs.renameSync(tmp, STATUS_FILE);
    } catch {
      // 心跳写失败不影响收发
    }
  };
  writeStatus();

  const explicitToken = cfg.onebot.accessToken || '';
  const account = !explicitToken && cfg.onebot.homeDir
    ? await discoverAccount(cfg.onebot.homeDir)
    : null;
  if (account && !account.ok) {
    log(`账号探测失败：试过 ${account.tried?.map((t) => t.uin).join(', ') || '无账号文件'}，全部未通过`);
  }
  if (account?.ok) {
    log(`探测到当前登录 QQ ${account.uin}，HTTP ${account.http?.url}，WS ${account.ws?.url}`);
  }

  const httpToken = explicitToken || account?.http?.token || '';
  const wsToken = explicitToken || account?.ws?.token || httpToken;
  const httpUrl = account?.http?.url || cfg.onebot.httpUrl;
  const wsUrl = account?.ws?.url || cfg.onebot.wsUrl;

  const http = new OneBotHttp({ httpUrl, token: httpToken });
  const runner = new AgentRunner({
    agent: cfg.openclaw.agent,
    mjsPath: cfg.openclaw.mjsPath,
    stateDir: cfg.openclaw.stateDir,
    timeoutSeconds: cfg.openclaw.timeoutSeconds,
    log,
  });
  const queue = new SerialQueue();

  const allowGroups = new Set((cfg.allow?.groups ?? []).map(String));
  const allowPrivate = new Set((cfg.allow?.private ?? []).map(String));
  const lastReplyByGroup = new Map();
  const buffers = new Map(); // groupId -> { items, timer }

  let login = account?.ok ? account.self : null;
  if (!login) {
    try {
      login = await http.loginInfo();
      log(`OneBot 已登录 QQ ${login?.user_id ?? '?'}（${login?.nickname ?? ''}）`);
    } catch (error) {
      log(`OneBot HTTP 暂不可用（${error?.message ?? error}）——WS 事件仍会尝试连接`);
    }
  }
  if (login) writeStatus({ account: { uin: login.user_id, nickname: login.nickname ?? '' } });

  const hasAtMe = (event, selfId) => {
    const mine = String(selfId ?? event.self_id ?? '');
    return Array.isArray(event.message)
      && event.message.some((seg) => seg?.type === 'at' && String(seg?.data?.qq ?? '') === mine);
  };

  /** 跑一轮并回群（节流等待 → agent → 去 markdown → 表情 → 分条发送）。 */
  const runAndReply = (targetId, sessionKey, body, { addressed, groupId }) => queue.push(sessionKey, async () => {
    const startedRunAt = Date.now();
    try {
      if (groupId) {
        const cooldown = persona.minReplyIntervalMs - (startedRunAt - (lastReplyByGroup.get(groupId) ?? 0));
        if (cooldown > 0) await sleep(cooldown);
      }
      const { text } = await runner.run({ sessionKey, message: body });
      let reply = stripMarkdown(text);
      if (!reply) {
        log(`空回复，已跳过（会话 ${sessionKey}）`);
        return;
      }
      reply = withEmoji(reply, persona.emojiRate);
      const chunks = splitText(reply, cfg.reply?.maxChars ?? 500);

      // 拟人等待：按回复长度模拟打字，避免「秒回」的机器人感
      await sleep(humanDelayMs(reply, persona));

      for (const [i, chunk] of chunks.entries()) {
        if (groupId) await http.sendGroup(targetId, chunk);
        else await http.sendPrivate(targetId, chunk);
        if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 250));
      }
      stats.replied += 1;
      const now = Date.now();
      status.lastReplyAt = now;
      if (groupId) lastReplyByGroup.set(groupId, now);
      writeStatus({ lastError: '' });
      activity({
        type: 'reply',
        groupId: groupId ?? null,
        targetId,
        addressed,
        chunks: chunks.length,
        ms: now - startedRunAt,
        text: reply.slice(0, 200),
      });
      log(`已回复 ${targetId}：${chunks.length} 条，用时 ${now - startedRunAt}ms`);
    } catch (error) {
      stats.failed += 1;
      writeStatus({ lastError: String(error?.message ?? error) });
      log(`处理失败（会话 ${sessionKey}）：${error?.message ?? error}`);
    }
  });

  /** 群消息合并窗口到点：判断回不回，再入串行队列。 */
  const flushGroup = (groupId) => {
    const buf = buffers.get(groupId);
    if (!buf) return;
    clearTimeout(buf.timer);
    buffers.delete(groupId);
    const items = buf.items.splice(0);
    if (!items.length) return;

    const addressed = isAddressed(items, { atTrigger: persona.atTrigger, keywords: persona.keywordTrigger });
    const decision = decideReply({
      addressed,
      lastReplyAt: lastReplyByGroup.get(groupId) ?? 0,
      now: Date.now(),
      minReplyIntervalMs: persona.minReplyIntervalMs,
      lurkRate: persona.lurkRate,
    });
    if (!decision.reply) {
      stats.lurked += 1;
      activity({
        type: 'lurk',
        groupId,
        reason: decision.reason,
        preview: items.map((it) => it.text).join(' / ').slice(0, 160),
      });
      log(`潜水（${decision.reason}）：群 ${groupId} 的 ${items.length} 条消息`);
      return;
    }

    const sessionKey = `qq:group:${groupId}`;
    log(`收到 群 ${groupId} 消息（${items.length} 条${addressed ? '，在叫她' : ''}）→ 会话 ${sessionKey}`);
    void runAndReply(groupId, sessionKey, formatBatch(items, groupId), { addressed, groupId });
  };

  const onEvent = (event) => {
    if (event.post_type !== 'message') return;
    const isGroup = event.message_type === 'group';
    const targetId = String(isGroup ? event.group_id : event.user_id);
    const allowed = isGroup ? allowGroups.has(targetId) : allowPrivate.has(targetId);
    if (!allowed) return;
    if (String(event.user_id ?? '') === String(event.self_id ?? '')) return;

    const text = segmentsToText(event.message, event.self_id);
    // 只过滤「纯 reply/空段」；图片、表情等占位消息也算有效内容
    if (!text.trim()) return;

    const sender = event.sender ?? {};
    const name = sender.card || sender.nickname || String(event.user_id ?? '');
    const userId = String(event.user_id ?? '');
    stats.received += 1;
    status.lastMessageAt = Date.now();
    activity({
      type: 'in',
      groupId: isGroup ? targetId : null,
      userId,
      name,
      text: text.slice(0, 200),
    });

    if (!isGroup) {
      const sessionKey = `qq:private:${targetId}`;
      log(`收到 私聊 ${targetId} 消息 → 会话 ${sessionKey}`);
      void runAndReply(targetId, sessionKey, formatIncoming(event, event.self_id), { addressed: true, groupId: null });
      return;
    }

    // 群消息：先进合并窗口，攒着一起想
    let buf = buffers.get(targetId);
    if (!buf) {
      buf = { items: [], timer: null };
      buffers.set(targetId, buf);
    }
    buf.items.push({ userId, name, text, atMe: hasAtMe(event, event.self_id) });
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => flushGroup(targetId), persona.mergeWindowMs);
  };

  const ws = new OneBotWs({
    wsUrl,
    token: wsToken,
    onEvent,
    onStatus: (state) => writeStatus({ ws: state }),
    log,
  });
  ws.connect();
  log(`已启动：群白名单 [${[...allowGroups].join(', ') || '空'}]，agent=${cfg.openclaw.agent}`);
  log(`群友感：合并 ${persona.mergeWindowMs}ms / 节流 ${persona.minReplyIntervalMs}ms / 潜水 ${Math.round(persona.lurkRate * 100)}% / 表情 ${Math.round(persona.emojiRate * 100)}%`);

  const heartbeat = setInterval(() => writeStatus(), 10_000);

  const shutdown = () => {
    log('收到退出信号，正在关闭…');
    clearInterval(heartbeat);
    ws.close();
    try {
      lock.server.close();
    } catch {
      // 忽略关闭失败
    }
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`[qq-sidecar] 启动失败: ${error?.message ?? error}`);
  process.exitCode = 1;
});
