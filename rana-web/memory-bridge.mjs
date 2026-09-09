#!/usr/bin/env node
/**
 * memory-bridge.mjs — Rana 双 agent 共享记忆桥
 *
 * 把 main（云端工作体）与 rana-rp（本地陪伴体）的新增对话分别提炼成
 * 简短纪要，写入共享目录（经 NTFS junction 同时挂在两个 workspace 的
 * memory/shared 下，双边记忆索引都能检索到），并同步一份"共享近况"
 * 到两边 MEMORY.md 的标记区块（MEMORY.md 每回合整体注入，保证必见）。
 *
 * 隐私边界：RP 侧原文只送本地 LM Studio（rana-rp-7b）提炼；
 *          工作侧原文送云端 flash（本来就在云端）。
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

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  try { fs.appendFileSync(SHARED + '/.bridge.log', line + '\n'); } catch {}
  console.log(line);
};

const loadState = () => {
  try { return JSON.parse(fs.readFileSync(SHARED + '/.bridge-state.json', 'utf8')); } catch { return {}; }
};
const saveState = (s) => fs.writeFileSync(SHARED + '/.bridge-state.json', JSON.stringify(s, null, 1));

/* ---------- 1. 读取两侧新增对话 ---------- */
function readNewEvents(agentId, sinceMs, capChars) {
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
      .trim();
    if (!text || text.startsWith('/')) continue; // 斜杠命令跳过
    const line = `[${new Date(r.created_at).toTimeString().slice(0, 5)}] ${role === 'user' ? '轩瑜' : 'Rana'}: ${text.replace(/\s+/g, ' ').slice(0, 500)}`;
    if (chars + line.length > capChars) break; // 本次装不下，state 停在上一条，下次接着来
    chars += line.length;
    out.push({ ts: r.created_at, line });
  }
  return out;
}

/* ---------- 2. 提炼（两侧各自的模型） ---------- */
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
  return (j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const SYS = '任务：从对话片段提炼共享记忆纪要。禁止复述本任务，禁止扮演对话角色，直接输出纪要行。';
function promptFor(side, tag, dialog) {
  // RP 侧私密内容一律不进共享记忆（云端可见）——由 private-memory-bridge 负责保管
  const privacy = tag === 'RP' ? '\n私密、亲密、身体相关的内容一律跳过不记（由私密记忆单独负责，共享记忆绝不收录）。' : '';
  return `【${side}侧对话片段】\n${dialog}\n---\n从上面对话提炼 1-3 条纪要（合并相似内容；陪伴对话哪怕小事也至少记一条；实在没有才输出：空）。\n每条一行，格式：HH:MM [${tag}] 内容\n时间必须照抄对话行首的 [HH:MM] 标记，禁止自己编时间。\n示例：09:30 [${tag}] 轩瑜修完微信bug后疲惫，Rana 陪他休息了一会儿\n规则：内容≤60字；记一起做的事、聊的话题、轩瑜的状态情绪、重要事实；陈述句。${privacy}`;
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
    if (!/轩瑜|Rana/.test(ln)) continue; // 纪要必须提到他们俩之一
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

/* ---------- main ---------- */
const state = loadState();
const CAP = 6000;
let mainEntries = [], rpEntries = [];
let newMainTs = state.lastMainMs || 0;
let newRpTs = state.lastRpMs || 0;

try {
  const mainEvts = readNewEvents('main', state.lastMainMs || NOW - 24 * 3600e3, CAP);
  if (mainEvts.length) {
    const dialog = mainEvts.map(e => e.line).join('\n');
    const raw = await chat(CFG.models.providers['aliyun-maas'].baseUrl, CFG.models.providers['aliyun-maas'].apiKey, 'qwen3.8-flash', SYS, promptFor('工作', '工作', dialog), 500);
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

appendShared([...mainEntries, ...rpEntries]);
if (mainEntries.length || rpEntries.length) {
  syncMemoryMd(HOME + '/workspace-main');
  syncMemoryMd(HOME + '/workspace-rana-rp');
}
publishFlatCopies(); // 无论有无新条目都确保副本存在（跨月/首次）
if (mainEntries.length || rpEntries.length) {
  syncMemoryMd(HOME + '/workspace-main');
  syncMemoryMd(HOME + '/workspace-rana-rp');
  saveState({ ...state, lastMainMs: newMainTs, lastRpMs: newRpTs });
  log(`shared updated: +${mainEntries.length} work, +${rpEntries.length} rp`);
} else {
  saveState({ ...state, lastMainMs: newMainTs || state.lastMainMs, lastRpMs: newRpTs || state.lastRpMs });
  log('no new shared entries');
}

// 触发双边记忆索引刷新（失败不影响主流程；索引也会按 mtime 自动重扫）
try {
  const child = spawn('G:/node/node.exe', ['--tls-max-v1.2', 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs', 'memory', 'index'], {
    env: { ...process.env, OPENCLAW_STATE_DIR: 'K:\\openclaw\\.openclaw\\.openclaw' },
    detached: true, stdio: 'ignore',
  });
  child.unref();
} catch {}
