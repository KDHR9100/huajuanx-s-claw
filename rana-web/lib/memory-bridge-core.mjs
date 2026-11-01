/**
 * memory-bridge-core.mjs — 两条记忆桥（公开腿 memory-bridge / 私密腿 private-memory-bridge）共用的纯机制库。
 * 两桥各自抄过一份读会话库/调模型/记水位的机制代码，"修一边漏一边"的慢性事故已发生两次，
 * 机制收进本模块后，同款修复从此只改这里。
 *
 * 本库只含机制，不含任何腿语义（说话人称呼、目录、提示词、外发目的地、隐私边界）——
 * 腿语义由各入口脚本通过回调注入（sessionFilter/cleanText/present），
 * 本库不含任何具体说话人名、目录名、提示词、模型名、隐私词表。
 *
 * 函数体从 memory-bridge.mjs 原样提取（正则/默认值/错误处理逐字节保真），仅做参数化改写。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// model 字段可能是字符串或 {primary, fallbacks} 对象（2026-10 配置改版），统一规整成字符串
function modelStr(m) {
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && typeof m.primary === 'string') return m.primary;
  return '';
}

/** 桥日志（两腿同款格式）：ISO 时间 + 消息，追加写 logPath（失败静默）并同步控制台。返回闭包 */
function makeLog(logPath) {
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    try { fs.appendFileSync(logPath, line + '\n'); } catch {}
    console.log(line);
  };
}

/**
 * 云端响应解析：中转站永远回 SSE（stream:false 也不听），需自行拼 delta；
 * sse-fix-proxy 已在流尾补 finish_reason/[DONE] 所以正常收尾。纯函数，供单测。
 */
function parseCloudText(text) {
  if (!/^\s*data:/.test(text) && !text.includes('\ndata:')) {
    const j = JSON.parse(text); // 万一哪天中转站老实回 JSON 了（解析失败让它抛，调用方 catch）
    return (j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  let out = '';
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const p = s.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const j = JSON.parse(p);
      const ch = j.choices?.[0] ?? {};
      if (ch.delta?.content) out += ch.delta.content;
      if (ch.message?.content) out += ch.message.content;
    } catch { /* 忽略无法解析的半行 */ }
  }
  return out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** OpenAI 兼容 /chat/completions：apiKey falsy 时不带 Authorization 头；失败抛「状态码+响应前200字符」。
 *  第 8 参 temperature（默认 0.2 与原硬编码一致；私密腿行为通道传 0）。 */
async function chat(url, apiKey, model, sys, user, maxTokens = 500, timeoutMs = 120000, temperature = 0.2) {
  const res = await fetch(url.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
    // sys 并入首条 user：RP 调优的本地模型常忽略 system 角色
    body: JSON.stringify({ model, messages: [{ role: 'user', content: sys + '\n\n' + user }], max_tokens: maxTokens, temperature, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
  const j = await res.json();
  return (j.choices?.[0].message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * 云端提炼调用（中转站永远回 SSE，stream:false 也不听）：拿全文后交给 parseCloudText 拼 delta。
 * ⚠️ 第 6 参是 timeoutMs（不是 maxTokens）——与 chat 的参数序刻意不同：既有调用点
 * cloudChat(url, key, model, sys, user, 60000) 第 6 位传的是超时毫秒，改序会静默把
 * 60000 当成 max_tokens 发出去；maxTokens/temperature 因此排在第 7/8 位。
 */
async function cloudChat(url, apiKey, model, sys, user, timeoutMs = 120000, maxTokens = 500, temperature = 0.2) {
  const res = await fetch(url.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: sys + '\n\n' + user }], max_tokens: maxTokens, temperature, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
  return parseCloudText(await res.text());
}

/* ---------- 读取 agent 库新增对话（机制部分；过滤/清洗/说话人由入参注入，逻辑顺序与原版一致） ---------- */
/**
 * - sessionFilter(key)：会话过滤，在 JSON.parse 之前判定（cron/评估/闸门等会话规则由腿注入）；
 * - cleanText(text)：腿清洗链注入口（think 剥离/代码块/图片占位等，本库不内置）；
 * - present(text, role, key)：说话人语义注入口，返回 null 跳过该行，或 { text, speaker, tag }；
 * - capChars 预算截断：本次装不下就停，state 停在上一条，下次接着来。
 */
function readNewEvents({ home, agentId, sinceMs, capChars, sessionFilter, cleanText, present }) {
  const db = new DatabaseSync(`${home}/agents/${agentId}/agent/openclaw-agent.sqlite`, { readOnly: true });
  // session_id -> session_key（过滤 cron / 非本 agent 会话）
  const keyOf = new Map();
  for (const r of db.prepare('SELECT session_key, current_session_id FROM session_nodes').all())
    keyOf.set(r.current_session_id, r.session_key);
  const rows = db.prepare(
    'SELECT session_id, event_json, created_at FROM transcript_events WHERE created_at > ? ORDER BY created_at ASC'
  ).all(sinceMs);
  db.close();

  const out = [];
  let chars = 0;
  for (const r of rows) {
    const key = keyOf.get(r.session_id) || '';
    if (sessionFilter && !sessionFilter(key)) continue; // 会话过滤在 JSON.parse 之前（省解析开销）
    let j;
    try { j = JSON.parse(r.event_json); } catch { continue; }
    const msg = j && j.type === 'message' ? j : null; // 10-03 事故防护：个别损坏/空事件行不炸整条腿
    if (!msg) continue;
    const role = msg.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = msg.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.filter(c => c && c.type === 'text').map(c => c.text).join(' ');
    if (cleanText) text = cleanText(text); // 腿清洗链注入口（原版内置的 think/代码块/图片链改由调用方传入）
    if (!text || text.startsWith('/')) continue; // 斜杠命令跳过
    const p = present ? present(text, role, key) : { text, speaker: role, tag: '' }; // present 缺省用中性 role 当说话人
    if (!p || !p.text) continue;
    const line = `[${new Date(r.created_at).toTimeString().slice(0, 5)}]${p.tag || ''} ${p.speaker}: ${(p.text || '').replace(/\s+/g, ' ').slice(0, 500)}`;
    if (chars + line.length > capChars) break; // 本次装不下，state 停在上一条，下次接着来
    chars += line.length;
    out.push({ ts: r.created_at, line });
  }
  return out;
}

export { modelStr, makeLog, parseCloudText, chat, cloudChat, readNewEvents };
