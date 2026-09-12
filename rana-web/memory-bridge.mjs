#!/usr/bin/env node
/**
 * memory-bridge.mjs — Rana 多 agent 共享记忆桥
 *
 * 腿 1/2（双向）：main（云端工作体）与 rana-rp（本地陪伴体）的新增对话分别提炼成
 * 简短纪要，写入共享目录（经 NTFS junction 同时挂在两个 workspace 的
 * memory/shared 下，双边记忆索引都能检索到），并同步一份"共享近况"
 * 到两边 MEMORY.md 的标记区块（MEMORY.md 每回合整体注入，保证必见）。
 *
 * 腿 3（单向，2026-09-14 加）：rana-qq-public（QQ 群公共号）的群聊新对话提炼成
 * "群聊见闻"，只写进 main 的记忆（workspace-main/memory/qq-public-rana-*.md +
 * MEMORY.md「群聊近况」区块）。main 的任何内容都不会流向群聊侧。
 *
 * 隐私边界：RP 侧原文只送本地 LM Studio 提炼；工作侧原文送云端（本来就在云端）；
 *          群聊原文送云端 glm 提炼（公共号本身就跑在云端 glm 上，无新增暴露）。
 * 触发：openclaw cron --command（每 30 分钟）或手动 node 运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';

const HOME = 'K:/OpenClaw/.openclaw/.openclaw';
const SHARED = HOME + '/shared-memory';
const CFG = JSON.parse(fs.readFileSync(HOME + '/openclaw.json', 'utf8'));
// RP 侧提炼模型跟随 rana-rp agent 当前配置，避免写死旧模型被 JIT 反复拉起挤显存
const RP_DISTILL_MODEL = (CFG.agents?.entries?.['rana-rp']?.model || '').split('/').pop() || 'rana-rp-7b';
const NOW = Date.now();
// 本地兜底过滤表（privacy-patterns 文件含私人词表，不入公开仓库；缺文件时兜底跳过，提示词层防护仍在）
const LOCAL_FILTERS = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./memory-bridge.privacy-patterns.json', import.meta.url), 'utf8'));
  } catch { return {}; }
})();

/** apiKey 现在可能是明文串，也可能是 SecretRef 对象（{source:"store",id}）——后者去 state SQLite 解析 */
function resolveApiKey(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && raw.source === 'store') {
    const db = new DatabaseSync(HOME + '/state/openclaw.sqlite', { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT value FROM secret_store_entries WHERE name = ? AND kind = 'secret' AND deleted_at_ms IS NULL ORDER BY updated_at_ms DESC LIMIT 1"
      ).get(String(raw.id ?? ''));
      return row ? String(row.value) : undefined;
    } finally { db.close(); }
  }
  return undefined;
}
/** 云端提炼统一走 glm（aliyun token-plan 额度耗尽 + glm 是 main 现役主力） */
function glmChatConfig() {
  const p = CFG.models.providers['glm'];
  return { url: p.baseUrl, apiKey: resolveApiKey(p.apiKey), model: (CFG.agents?.entries?.['rana-qq-public']?.model || 'glm/glm-5.3-flash').split('/').pop() };
}

/** QQ 群别名表 + 主人 openid：存状态目录（私有），群哈希自动按首见顺序分配置 群A/群B/…，可手改成真群名 */
const QQ_LOCAL = (() => {
  const f = SHARED + '/qq-bridge.json';
  let j = {};
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  if (!j.groups || typeof j.groups !== 'object') j.groups = {};
  // 主人 openid 从 qqbot 直连绑定运行时读，不硬编码进公开仓库
  if (!j.ownerOpenId) {
    const direct = (CFG.bindings || []).find(b => b.match?.channel === 'qqbot' && b.match?.peer?.kind === 'direct');
    if (direct?.match?.peer?.id) j.ownerOpenId = direct.match.peer.id;
  }
  fs.writeFileSync(f, JSON.stringify(j, null, 1));
  return j;
})();
function groupAlias(sessionKey) {
  const hash = (sessionKey.match(/group:([0-9a-f]+)/) || [])[1];
  if (!hash) return '群?';
  if (!QQ_LOCAL.groups[hash]) {
    const used = Object.values(QQ_LOCAL.groups);
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let i = 0;
    while (used.includes('群' + letters[i]) && i < 25) i++;
    QQ_LOCAL.groups[hash] = '群' + (letters[i] ?? used.length);
    fs.writeFileSync(SHARED + '/qq-bridge.json', JSON.stringify(QQ_LOCAL, null, 1));
  }
  return QQ_LOCAL.groups[hash];
}

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  try { fs.appendFileSync(SHARED + '/.bridge.log', line + '\n'); } catch {}
  console.log(line);
};

const loadState = () => {
  try { return JSON.parse(fs.readFileSync(SHARED + '/.bridge-state.json', 'utf8')); } catch { return {}; }
};
const saveState = (s) => fs.writeFileSync(SHARED + '/.bridge-state.json', JSON.stringify(s, null, 1));

/* ---------- 1. 读取各侧新增对话 ---------- */
function readNewEvents(agentId, sinceMs, capChars, opts = {}) {
  const db = new DatabaseSync(`${HOME}/agents/${agentId}/agent/openclaw-agent.sqlite`, { readOnly: true });
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
    if (key.includes(':cron:')) continue; // 早报等系统会话不进共享记忆
    if (opts.sessionFilter && !opts.sessionFilter(key)) continue;
    let j;
    try { j = JSON.parse(r.event_json); } catch { continue; }
    const msg = j.type === 'message' ? j : null;
    if (!msg) continue;
    const role = msg.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = msg.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.filter(c => c && c.type === 'text').map(c => c.text).join(' ');
    text = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```[\s\S]*?```/g, '') // RP 侧舞台指令块不是叙事内容
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图]') // QQ 图片转占位
      .replace(/\[Chat history (begins|ends)\]/g, '')
      .trim();
    if (!text || text.startsWith('/')) continue; // 斜杠命令跳过
    let speaker;
    if (opts.qqSpeaker) {
      speaker = opts.qqSpeaker(text);
      text = text.replace(/^\[[^\]]*\]\s*/, '').trim(); // 去掉 [名字 (id)] 前缀行
      if (!text) continue;
    } else {
      speaker = role === 'user' ? '轩瑜' : 'Rana';
    }
    const gTag = opts.qqSpeaker ? ` [${groupAlias(key)}]` : '';
    const line = `[${new Date(r.created_at).toTimeString().slice(0, 5)}]${gTag} ${speaker}: ${text.replace(/\s+/g, ' ').slice(0, 500)}`;
    if (chars + line.length > capChars) break; // 本次装不下，state 停在上一条，下次接着来
    chars += line.length;
    out.push({ ts: r.created_at, line });
  }
  return out;
}

/** QQ 群消息的发言者：从正文里的 [名字 (OPENID)] 抠；主人 openid → 轩瑜 */
function qqSpeakerOf(text) {
  const m = text.match(/\[([^\](]{1,24}?)\s*\(([0-9A-F]{32})\)\]/);
  if (!m) return '群友';
  if (QQ_LOCAL.ownerOpenId && m[2].toUpperCase() === QQ_LOCAL.ownerOpenId.toUpperCase()) return '轩瑜';
  return m[1].trim();
}

/* ---------- 2. 提炼（各侧各自的模型） ---------- */
async function chat(url, apiKey, model, sys, user, maxTokens) {
  const res = await fetch(url.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
    // sys 并入首条 user：RP 调优的本地模型常忽略 system 角色
    body: JSON.stringify({ model, messages: [{ role: 'user', content: sys + '\n\n' + user }], max_tokens: maxTokens, temperature: 0.2, stream: false }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
  const j = await res.json();
  return (j.choices?.[0].message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const SYS = '任务：从对话片段提炼共享记忆纪要。禁止复述本任务，禁止扮演对话角色，直接输出纪要行。';
function promptFor(side, tag, dialog) {
  // RP 侧私密内容一律不进共享记忆（云端可见）——由 private-memory-bridge 负责保管
  const privacy = tag === 'RP' ? '\n私密、亲密、身体相关的内容一律跳过不记（由私密记忆单独负责，共享记忆绝不收录）。' : '';
  // 工作侧心跳/备份等运维自活动对陪伴侧毫无价值（heartbeat target=last 直接混在主会话里）
  const ops = tag === '工作' ? '\n跳过 Rana 自己的运维活动（心跳检查、备份、git/推送、巡检、监控、排障、重启重载、定时任务）——除非轩瑜本人有明显情绪或做了决定，否则一律不记。' : '';
  const qq = tag === '群聊' ? '\n这是 QQ 群里公共版 Rana 的聊天，群用 群A/群B 区分。跳过纯表情包、图片、寒暄刷屏；重点记：有人聊了有意思的话题、群友（点名）说了什么值得记的、轩瑜在群里的动态、公共号 Rana 的表现。涉隐私的私事不记。' : '';
  return `【${side}侧对话片段】\n${dialog}\n---\n从上面对话提炼 1-3 条纪要（合并相似内容；${tag === '群聊' ? '群里有互动就至少记一条' : '陪伴对话哪怕小事也至少记一条'}；实在没有才输出：空）。\n每条一行，格式：HH:MM [${tag}] 内容\n时间必须照抄对话行首的 [HH:MM] 标记，禁止自己编时间。\n示例：09:30 [${tag}] 轩瑜修完微信bug后疲惫，Rana 陪他休息了一会儿\n规则：内容≤60字；记一起做的事、聊的话题、${tag === '群聊' ? '谁（用群友名字）' : '轩瑜'}的状态情绪、重要事实；陈述句。${privacy}${ops}${qq}`;
}

function parseEntries(raw, tag, fallbackTs) {
  if (!raw || (/空/.test(raw) && raw.length < 10)) return [];
  const entries = [];
  for (let ln of raw.split('\n')) {
    ln = ln.replace(/^[-*\s]+/, '').trim();
    if (!ln || /^(空|无)/.test(ln)) continue;
    // 防模型复述任务/角色扮演/舞台指令/照抄对话（本地 7B 常见毛病）
    if (/记忆提炼器|共享记忆纪要|禁止复述|```|坐姿[:：]|^\*?\*?-(坐姿|状态|行为)/.test(ln)) continue;
    if (/轩瑜:|Rana:|\[\d{1,2}:\d{2}\]/.test(ln)) continue; // 原文回声
    // 隐私兜底/运维噪音兜底：正则表放本地 privacy-patterns 文件（不入公开仓库），缺文件时跳过
    if (tag === 'RP' && LOCAL_FILTERS.rpPrivacy && new RegExp(LOCAL_FILTERS.rpPrivacy).test(ln)) continue;
    if (tag === '工作' && LOCAL_FILTERS.opsNoise && new RegExp(LOCAL_FILTERS.opsNoise, 'i').test(ln)) continue;
    if (tag !== '群聊' && !/轩瑜|Rana/.test(ln)) continue; // 纪要必须提到他们俩之一（群聊侧人名不限）
    if (tag === '群聊' && !/[\u4e00-\u9fa5]/.test(ln)) continue; // 群聊纪要至少得有中文
    ln = ln.replace(/刘南|刘娜/g, 'Rana'); // 7B 微调残留的错误自称，入库前统一改回
    const m = ln.match(/^(\d{1,2}:\d{2})\s*\[/);
    const time = m ? m[1] : new Date(fallbackTs).toTimeString().slice(0, 5);
    if (!ln.includes(`[${tag}]`)) ln = `${time} [${tag}] ${ln.replace(/^(\d{1,2}:\d{2})?\s*/, '')}`;
    if (ln.length > 15) entries.push({ time, line: ln.slice(0, 120) });
  }
  return entries.slice(0, 3);
}

/* ---------- 3. 写共享文件 + 同步 MEMORY.md ----------
 * 注意：OpenClaw 记忆索引只扫 memory/*.md（不递归子目录），
 * 所以共享内容除母本外，同时平铺写到两个 workspace 的 memory/ 下。 */
function dateKey() {
  const d = new Date(NOW + 8 * 3600e3);
  return d.toISOString().slice(0, 10);
}
function monthFile() {
  return `${SHARED}/${dateKey().slice(0, 7)}.md`;
}
function flatName() {
  return `shared-rana-${dateKey().slice(0, 7)}.md`;
}
function appendShared(entries) {
  if (!entries.length) return;
  const f = monthFile();
  const day = dateKey();
  let body = '';
  try { body = fs.readFileSync(f, 'utf8'); } catch {}
  const heading = `## ${day}`;
  const block = entries.map(e => {
    const l = e.line.replace(/^(\d{1,2}:\d{2})\s+/, ''); // 行内已含时间则不重复
    return `- ${l.includes(e.time + ' ') ? '' : e.time + ' '}${l}`;
  }).join('\n');
  if (body.includes(heading)) body = body.replace(heading, `${heading}\n${block}`);
  else body = `${body.trim()}\n\n${heading}\n${block}\n`;
  fs.writeFileSync(f, body.trimStart());
}
function publishFlatCopies() {
  // 两个 workspace 的 memory/ 平级副本（记忆索引可检索）
  for (const ws of ['workspace-main', 'workspace-rana-rp']) {
    try { fs.copyFileSync(monthFile(), `${HOME}/${ws}/memory/${flatName()}`); } catch (e) { log('flat copy failed ' + ws + ': ' + e.message); }
  }
}
const MEM_MARK_BEGIN = '<!-- rana-shared-memory:start -->';
const MEM_MARK_END = '<!-- rana-shared-memory:end -->';
function syncMemoryMd(agentWorkspace) {
  const f = `${agentWorkspace}/MEMORY.md`;
  let body = '';
  try { body = fs.readFileSync(f, 'utf8'); } catch {}
  const month = fs.readFileSync(monthFile(), 'utf8');
  const lines = month.split('\n').filter(l => l.startsWith('- ')).slice(-6); // 最近 6 条必见
  const section = `\n${MEM_MARK_BEGIN}\n## 共享近况（工作体/陪伴体互通，全文见 memory/shared-rana-*.md）\n${lines.join('\n')}\n${MEM_MARK_END}\n`;
  if (body.includes(MEM_MARK_BEGIN)) {
    body = body.replace(new RegExp(MEM_MARK_BEGIN.replace(/[/*]/g, '\\$&') + '[\\s\\S]*?' + MEM_MARK_END.replace(/[/*]/g, '\\$&')), section.trim());
  } else {
    body = body.trimEnd() + '\n' + section;
  }
  fs.writeFileSync(f, body);
}

/* ---------- 3b. 群聊见闻：只写 main 侧 ---------- */
function qqMonthFile() {
  return `${SHARED}/qq-public-${dateKey().slice(0, 7)}.md`;
}
function qqFlatName() {
  return `qq-public-rana-${dateKey().slice(0, 7)}.md`;
}
const QQ_MARK_BEGIN = '<!-- rana-qq-digest:start -->';
const QQ_MARK_END = '<!-- rana-qq-digest:end -->';
function publishQqDigest(entries) {
  if (!entries.length) return;
  const f = qqMonthFile();
  const day = dateKey();
  let body = '';
  try { body = fs.readFileSync(f, 'utf8'); } catch {}
  const heading = `## ${day}`;
  const block = entries.map(e => {
    const l = e.line.replace(/^(\d{1,2}:\d{2})\s+/, '');
    return `- ${l.includes(e.time + ' ') ? '' : e.time + ' '}${l}`;
  }).join('\n');
  if (body.includes(heading)) body = body.replace(heading, `${heading}\n${block}`);
  else body = `${body.trim()}\n\n${heading}\n${block}\n`;
  fs.writeFileSync(f, body.trimStart());
  try { fs.copyFileSync(f, `${HOME}/workspace-main/memory/${qqFlatName()}`); } catch (e) { log('qq flat copy failed: ' + e.message); }
  // main 的 MEMORY.md 同步「群聊近况」区块（每回合注入，保证主位必见）
  const mf = HOME + '/workspace-main/MEMORY.md';
  let mem = '';
  try { mem = fs.readFileSync(mf, 'utf8'); } catch {}
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(l => l.startsWith('- ')).slice(-5);
  const section = `\n${QQ_MARK_BEGIN}\n## 群聊近况（QQ 公共号的见闻摘要，全文见 memory/qq-public-rana-*.md）\n${lines.join('\n')}\n${QQ_MARK_END}\n`;
  if (mem.includes(QQ_MARK_BEGIN)) {
    mem = mem.replace(new RegExp(QQ_MARK_BEGIN.replace(/[/*]/g, '\\$&') + '[\\s\\S]*?' + QQ_MARK_END.replace(/[/*]/g, '\\$&')), section.trim());
  } else {
    mem = mem.trimEnd() + '\n' + section;
  }
  fs.writeFileSync(mf, mem);
}

/* ---------- main ---------- */
const state = loadState();
const CAP = 6000;
let mainEntries = [], rpEntries = [], qqEntries = [];
let newMainTs = state.lastMainMs || 0;
let newRpTs = state.lastRpMs || 0;
let newQqTs = state.lastQqMs || 0;

try {
  const mainEvts = readNewEvents('main', state.lastMainMs || NOW - 24 * 3600e3, CAP);
  if (mainEvts.length) {
    const dialog = mainEvts.map(e => e.line).join('\n');
    // 云端提炼走 glm（aliyun token-plan 额度耗尽；apiKey 兼容 SecretRef 解析）
    // max_tokens 1500：glm-5.3 思考正文前先花几百 token 推理，500 会偶尔把正文挤空
    const g = glmChatConfig();
    const raw = await chat(g.url, g.apiKey, g.model, SYS, promptFor('工作', '工作', dialog), 1500);
    mainEntries = parseEntries(raw, '工作', mainEvts[mainEvts.length - 1].ts);
    newMainTs = mainEvts[mainEvts.length - 1].ts;
    log(`main side: ${mainEvts.length} msgs -> ${mainEntries.length} entries`);
  } else log('main side: nothing new');
} catch (e) { log('main side FAILED (will retry next run): ' + e.message); }

try {
  const rpEvts = readNewEvents('rana-rp', state.lastRpMs || NOW - 24 * 3600e3, CAP);
  if (rpEvts.length) {
    const dialog = rpEvts.map(e => e.line).join('\n');
    // RP 原文只进本地模型（跟随 agent 当前模型）
    const raw = await chat('http://127.0.0.1:1234/v1', null, RP_DISTILL_MODEL, SYS, promptFor('陪伴', 'RP', dialog), 500);
    rpEntries = parseEntries(raw, 'RP', rpEvts[rpEvts.length - 1].ts);
    newRpTs = rpEvts[rpEvts.length - 1].ts;
    if (!rpEntries.length && raw && !/^空/.test(raw)) log('rp distill raw (rejected): ' + JSON.stringify(raw.slice(0, 200)));
    log(`rp side: ${rpEvts.length} msgs -> ${rpEntries.length} entries`);
  } else log('rp side: nothing new');
} catch (e) { log('rp side FAILED (will retry next run): ' + e.message); }

try {
  // 群聊腿：只读 group 会话（排除公共号自己的 main 会话）；原文提炼走云端 glm（公共号本身就跑在云端）
  const qqEvts = readNewEvents('rana-qq-public', state.lastQqMs || NOW - 24 * 3600e3, 4000, {
    sessionFilter: (key) => key.includes('group:'),
    qqSpeaker: qqSpeakerOf,
  });
  if (qqEvts.length) {
    const dialog = qqEvts.map(e => e.line).join('\n');
    const g = glmChatConfig();
    const raw = await chat(g.url, g.apiKey, g.model, SYS, promptFor('群聊', '群聊', dialog), 1500);
    qqEntries = parseEntries(raw, '群聊', qqEvts[qqEvts.length - 1].ts);
    newQqTs = qqEvts[qqEvts.length - 1].ts;
    if (!qqEntries.length && raw && !/^空/.test(raw)) log('qq distill raw (rejected): ' + JSON.stringify(raw.slice(0, 250)));
    log(`qq side: ${qqEvts.length} msgs -> ${qqEntries.length} entries`);
  } else log('qq side: nothing new');
} catch (e) { log('qq side FAILED (will retry next run): ' + e.message); }

appendShared([...mainEntries, ...rpEntries]);
if (mainEntries.length || rpEntries.length) {
  syncMemoryMd(HOME + '/workspace-main');
  syncMemoryMd(HOME + '/workspace-rana-rp');
}
publishQqDigest(qqEntries);
publishFlatCopies(); // 无论有无新条目都确保副本存在（跨月/首次）
if (mainEntries.length || rpEntries.length || qqEntries.length) {
  saveState({ ...state, lastMainMs: newMainTs, lastRpMs: newRpTs, lastQqMs: newQqTs });
  log(`shared updated: +${mainEntries.length} work, +${rpEntries.length} rp, +${qqEntries.length} qq`);
} else {
  saveState({ ...state, lastMainMs: newMainTs || state.lastMainMs, lastRpMs: newRpTs || state.lastRpMs, lastQqMs: newQqTs || state.lastQqMs });
  log('no new shared entries');
}

// 触发双边记忆索引刷新（失败不影响主流程；索引也会按 mtime 自动重扫）
try {
  const child = spawn('G:/node/node.exe', ['--tls-max-v1-2', 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs', 'memory', 'index'], {
    env: { ...process.env, OPENCLAW_STATE_DIR: 'K:\\openclaw\\.openclaw\\.openclaw' },
    detached: true, stdio: 'ignore',
  });
  child.unref();
} catch {}
