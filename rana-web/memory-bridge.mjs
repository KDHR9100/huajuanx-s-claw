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
import { STATE_HOME, resolveApiKey, resolveOpenclawMjs } from './lib/rana-config.mjs';
import { makeParseEntries } from './memory-bridge-parse.mjs';
import { chat, cloudChat, makeLog, modelStr, readNewEvents as coreReadNewEvents } from './lib/memory-bridge-core.mjs';

// 状态目录与 SecretRef 解析统一走共享模块（env 优先，缺省回退仓库内布局）
const HOME = STATE_HOME;
const SHARED = HOME + '/shared-memory';
const CFG = JSON.parse(fs.readFileSync(HOME + '/openclaw.json', 'utf8'));
// RP 侧提炼模型：只用 LM Studio 当前"已加载"的模型（14B 优先——7B 实测会主客颠倒/编造场景时间；7B 只兜底），绝不 JIT 拉起新模型挤显存。
// 2026-10 RP 上云后 agent 配置已是云端模型名，不能再当本地模型名用——那正是 RP 腿断管的根因之一
async function pickRpDistillModel() {
  let ids = [];
  try {
    const res = await fetch('http://127.0.0.1:1234/v1/models', { signal: AbortSignal.timeout(5000) });
    ids = ((await res.json()).data || []).map((m) => m && m.id).filter(Boolean);
  } catch (e) {
    throw new Error('LM Studio 服务不可达（' + (e && e.message ? e.message : e) + '）');
  }
  for (const pref of ['rana-rp-14b', 'rana-v4-7b']) if (ids.includes(pref)) return pref;
  const llm = ids.find((id) => !/embed/i.test(id));
  if (llm) return llm;
  throw new Error('本地无已加载模型（RP 页按「🔗记忆同步」可自动拉起，跑完自动卸载）');
}
const NOW = Date.now();
// 本地兜底过滤表（privacy-patterns 文件含私人词表，不入公开仓库；缺文件时兜底跳过，提示词层防护仍在）
const LOCAL_FILTERS = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./memory-bridge.privacy-patterns.json', import.meta.url), 'utf8'));
  } catch { return {}; }
})();
// 主人对内称呼与群内化名外置（identity 文件不入公开仓库；缺文件回退中性称呼，不影响桥运行）
const IDENTITY = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('./memory-bridge.identity.json', import.meta.url), 'utf8')); } catch { return {}; }
})();
const OWNER_NAME = IDENTITY.realName || '主人';
const OWNER_ALIAS = IDENTITY.groupAlias || '群主';

/** 云端提炼统一走 glm（aliyun token-plan 额度耗尽 + glm 是 main 现役主力） */
function glmChatConfig() {
  const p = CFG.models.providers['glm'];
  const m = modelStr(CFG.agents?.entries?.['rana-qq-public']?.model);
  // qq agent 换非 glm 模型后不能直接拿它的名字发到智谱端点（1211 模型不存在），回退到 provider 自带模型列表
  const model = m.startsWith('glm/') ? m.split('/').pop() : (p.models?.[0]?.id || 'glm-5.3-flash');
  return { url: p.baseUrl, apiKey: resolveApiKey(p.apiKey), model };
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

const log = makeLog(SHARED + '/.bridge.log');

const loadState = () => {
  try { return JSON.parse(fs.readFileSync(SHARED + '/.bridge-state.json', 'utf8')); } catch { return {}; }
};
const saveState = (s) => fs.writeFileSync(SHARED + '/.bridge-state.json', JSON.stringify(s, null, 1));

/* ---------- 1. 读取各侧新增对话 ---------- */
function readNewEvents(agentId, sinceMs, capChars, opts = {}) {
  // 机制收拢在 lib/memory-bridge-core.mjs；腿语义（cron/评估会话过滤、清洗链、说话人）在此注入
  return coreReadNewEvents({
    home: HOME, agentId, sinceMs, capChars,
    sessionFilter: (key) => !key.includes(':cron:') && !key.includes(':eval-'), // 系统会话与 RP 评估会话不进共享记忆
    cleanText: (t) => t.replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```[\s\S]*?```/g, '') // RP 侧舞台指令块不是叙事内容
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图]') // QQ 图片转占位
      .replace(/\[Chat history (begins|ends)\]/g, '')
      .trim(),
    present: opts.qqSpeaker
      ? (text, role, key) => {
          const speaker = opts.qqSpeaker(text);
          const stripped = text.replace(/^\[[^\]]*\]\s*/, '').trim(); // 去掉 [名字 (id)] 前缀行
          if (!stripped) return null;
          return { text: stripped, speaker, tag: ` [${groupAlias(key)}]` };
        }
      : (text, role) => ({ text, speaker: role === 'user' ? OWNER_NAME : 'Rana', tag: '' }),
  });
}

/** QQ 群消息的发言者：从正文里的 [名字 (OPENID)] 抠；主人 openid → 群内化名（identity 文件） */
function qqSpeakerOf(text) {
  const m = text.match(/\[([^\](]{1,24}?)\s*\(([0-9A-F]{32})\)\]/);
  if (!m) return '群友';
  if (QQ_LOCAL.ownerOpenId && m[2].toUpperCase() === QQ_LOCAL.ownerOpenId.toUpperCase()) return OWNER_ALIAS;
  return m[1].trim();
}

/* ---------- 2. 提炼（各侧各自的模型） ---------- */
const SYS = '任务：从对话片段提炼共享记忆纪要。禁止复述本任务，禁止扮演对话角色，直接输出纪要行。';

function promptFor(side, tag, dialog) {
  // RP 侧私密内容一律不进共享记忆（云端可见）——由 private-memory-bridge 负责保管
  const privacy = tag === 'RP' ? '\n私密、亲密、身体相关的内容一律跳过不记（由私密记忆单独负责，共享记忆绝不收录）。' : '';
  // 工作侧心跳/备份等运维自活动对陪伴侧毫无价值（heartbeat target=last 直接混在主会话里）
  const ops = tag === '工作' ? `\n跳过 Rana 自己的运维活动（心跳检查、备份、git/推送、巡检、监控、排障、重启重载、定时任务）——除非${OWNER_NAME}本人有明显情绪或做了决定，否则一律不记。` : '';
  const qq = tag === '群聊' ? `\n这是 QQ 群里公共版 Rana 的聊天，群用 群A/群B 区分。跳过纯表情包、图片、寒暄刷屏；重点记：有人聊了有意思的话题、群友（点名）说了什么值得记的、${OWNER_ALIAS}在群里的动态（群主在群里叫${OWNER_ALIAS}，群聊纪要一律写${OWNER_ALIAS}）、公共号 Rana 的表现。涉隐私的私事不记。` : '';
  return `【${side}侧对话片段】\n${dialog}\n---\n从上面对话提炼 1-3 条纪要（合并相似内容；${tag === '群聊' ? '群里有互动就至少记一条' : '陪伴对话哪怕小事也至少记一条'}；实在没有才输出：空）。\n每条一行，格式：HH:MM [${tag}] 内容\n时间必须照抄对话行首的 [HH:MM] 标记，禁止自己编时间。\n示例：09:30 [${tag}] ${OWNER_NAME}修完微信bug后疲惫，Rana 陪他休息了一会儿\n规则：内容≤60字；记一起做的事、聊的话题、${tag === '群聊' ? '谁（用群友名字）' : OWNER_NAME}的状态情绪、重要事实；陈述句。${privacy}${ops}${qq}`;
}

const parseEntries = makeParseEntries({ OWNER_NAME, OWNER_ALIAS, LOCAL_FILTERS });

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
  const lines = month.split('\n').filter(l => l.startsWith('- ')).slice(-15); // 最近 15 条必见（2026-10-06 应主人要求从 6 加大）
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
    const prompt = promptFor('陪伴', 'RP', dialog);
    // 云端优先（2026-10-06 实测通过，主人拍板）：RP 原文本就经过该中转站（聊天本体同通道），提炼无新增暴露；
    // 失败（链路抖/超时/账户问题）才回落本地——本地路径只用已加载的模型（14B 优先），绝不 JIT 拉起挤显存
    let raw = null;
    try {
      const rpProv = CFG.models?.providers?.['rp-nsfw'] || {};
      const cloudKey = resolveApiKey(rpProv.apiKey);
      if (cloudKey) {
        const cloudModel = modelStr(CFG.agents?.entries?.['rana-rp']?.model).split('/').pop() || 'nalang-turbo-1115';
        raw = await cloudChat(rpProv.baseUrl || 'http://127.0.0.1:18801/v1', cloudKey, cloudModel, SYS, prompt);
        log('rp distill model: cloud:' + cloudModel);
      } else log('rp cloud skipped: rp-nsfw 配置里没有 apiKey');
    } catch (e) {
      log('rp cloud distill FAILED, falling back to local: ' + e.message);
      raw = null;
    }
    if (raw === null) {
      const rpModel = await pickRpDistillModel();
      log('rp distill model: local:' + rpModel);
      // 积压多天的对话很长，本地 7B/14B prefill 慢，超时放宽到 8 分钟（120s 会撞死）
      raw = await chat('http://127.0.0.1:1234/v1', null, rpModel, SYS, prompt, 500, 480000);
    }
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

/* ---------- 4b. 晚报安全版摘要（绕开 private-memory-gate，供云端晚报任务读取） ---------- */
// 背景：晚报（云端 glm）读 shared-rana 被 private-memory-gate 硬拦（10-01 亲密内容触发云端审查后装的闸），陪伴侧 10-02 起每晚「暂缺」。
// 修法（2026-10-06 主人拍板）：桥把当天 [RP] 行交给 RP 模型（云端 nalang 优先、本地已加载模型兜底）软化成中性散文，
// 写到文件名不含 shared-rana 字样的独立文件——闸门按路径拦截，新文件不命中。
const DIGEST_FILE = `${HOME}/workspace-main/memory/evening-digest.md`;
const DIGEST_STATE = `${SHARED}/.digest-state.json`;

function todayRpDigestSource() {
  try {
    const month = fs.readFileSync(monthFile(), 'utf8');
    const today = dateKey();
    const out = [];
    let inToday = false;
    for (const ln of month.split('\n')) {
      if (ln.startsWith('## ')) { inToday = ln.includes(today); continue; }
      if (inToday && ln.startsWith('- ') && ln.includes('[RP]')) out.push(ln.replace(/^-\s*/, '').trim());
    }
    return out;
  } catch { return []; }
}

async function generateEveningDigest() {
  const rpLines = todayRpDigestSource();
  const sourceKey = rpLines.join('\n');
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(DIGEST_STATE, 'utf8')); } catch {}
  if (prev.sourceKey === sourceKey && fs.existsSync(DIGEST_FILE)) return; // 当天内容没变不重做（省额度）
  const fallback = rpLines.length
    ? `今日陪伴侧共 ${rpLines.length} 条记录（细节只在本地保留，想听直接问我）。`
    : '今日陪伴侧暂无记录。';
  let body = fallback;
  if (rpLines.length) {
    const softenSys = '任务：把陪伴侧纪要改写成给主人的晚报摘要。禁止扮演对话角色，直接输出摘要文本。';
    const softenPrompt = [
      '把下面的陪伴侧纪要改写成晚报摘要：',
      '①只保留日常层面：聊了什么话题、做了什么日常互动、彼此的状态情绪；',
      '②任何身体、亲密、私密细节一律省略或模糊成「亲密陪伴」级别，绝不复述；',
      '③2-3 句中文散文，不超过 80 字，不要列表不要格式；',
      '④若纪要基本全是私密内容，就输出：今日主要是亲密陪伴。',
      '纪要：',
      sourceKey,
    ].join('\n');
    try {
      const rpProv = CFG.models?.providers?.['rp-nsfw'] || {};
      const cloudKey = resolveApiKey(rpProv.apiKey);
      if (cloudKey) {
        const cloudModel = modelStr(CFG.agents?.entries?.['rana-rp']?.model).split('/').pop() || 'nalang-turbo-1115';
        body = await cloudChat(rpProv.baseUrl || 'http://127.0.0.1:18801/v1', cloudKey, cloudModel, softenSys, softenPrompt, 60000);
        log('digest softened by cloud:' + cloudModel);
      } else throw new Error('rp-nsfw 配置无 apiKey');
    } catch (e) {
      try {
        const m = await pickRpDistillModel(); // 本地兜底：只用已加载的，绝不 JIT 拉起
        body = await chat('http://127.0.0.1:1234/v1', null, m, softenSys, softenPrompt, 500, 480000);
        log('digest softened by local:' + m);
      } catch (e2) {
        log('digest soften FAILED (cloud & local), fallback line used: ' + e2.message);
        body = fallback;
      }
    }
    // 隐私兜底：软化结果只要还带敏感词，整段降级为计数行
    const nets = [LOCAL_FILTERS.rpPrivacy, '内射|做爱|抽插|阴道|阴茎|乳房|处女'].filter(Boolean);
    const dirty = nets.some((n) => { try { return new RegExp(n).test(body); } catch { return false; } });
    if (dirty) {
      log('digest soften output failed privacy net, downgraded');
      body = fallback;
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 200) || fallback;
  }
  try {
    const stamp = new Date().toTimeString().slice(0, 5);
    fs.writeFileSync(DIGEST_FILE, `# 陪伴侧日报摘要（晚报专用，已脱敏）\n\n（记忆桥自动生成，最后更新今天 ${stamp}；细节只在本地共享记忆里，不要去找原文）\n\n${body}\n`);
    fs.writeFileSync(DIGEST_STATE, JSON.stringify({ sourceKey, at: NOW }));
    log(`evening digest updated (${rpLines.length} rp lines)`);
  } catch (e) { log('digest write failed: ' + e.message); }
}

appendShared([...mainEntries, ...rpEntries]);
if (mainEntries.length || rpEntries.length) {
  syncMemoryMd(HOME + '/workspace-main');
  syncMemoryMd(HOME + '/workspace-rana-rp');
}
publishQqDigest(qqEntries);
publishFlatCopies(); // 无论有无新条目都确保副本存在（跨月/首次）
await generateEveningDigest(); // 晚报安全摘要（内容没变则跳过）
if (mainEntries.length || rpEntries.length || qqEntries.length) {
  saveState({ ...state, lastMainMs: newMainTs, lastRpMs: newRpTs, lastQqMs: newQqTs });
  log(`shared updated: +${mainEntries.length} work, +${rpEntries.length} rp, +${qqEntries.length} qq`);
} else {
  saveState({ ...state, lastMainMs: newMainTs || state.lastMainMs, lastRpMs: newRpTs || state.lastRpMs, lastQqMs: newQqTs || state.lastQqMs });
  log('no new shared entries');
}

// 触发双边记忆索引刷新（失败不影响主流程；索引也会按 mtime 自动重扫）
try {
  const child = spawn(process.execPath, ['--tls-max-v1.2', resolveOpenclawMjs(), 'memory', 'index'], {
    env: { ...process.env, OPENCLAW_STATE_DIR: STATE_HOME },
    detached: true, stdio: 'ignore',
  });
  child.unref();
} catch {}
