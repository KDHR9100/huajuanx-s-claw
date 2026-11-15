#!/usr/bin/env node
/**
 * companion-diary.mjs — Rana 复盘日记（私密线 · 每晚全盘回顾）
 *
 * 每晚把当天主人与 Rana 的私密对话（rana-rp agent 会话库）全盘读一遍，让 Rana 用
 * 第一人称写两段：日记（心情视角，只写对话里真实发生的事）+ 纪要（客观清单），落盘
 * workspace-rana-rp/memory/diary/YYYY-MM-DD.md——该目录在 rana-rp workspace 内，
 * 随 17:30 备份链自动上 GitHub 私有备份仓，无需手动上传。
 *
 * 通道：rp-nsfw 中转站经本地 sse-fix-proxy :18801，模型 nalang-turbo-0826（便宜档），
 * 与私密记忆桥同款。失败处理：通道挂了当天即失败 → 下一班重试，水位不前进、事件不丢
 * （沿用主人 2026-11-01 私密桥拍板：不加本地兜底）。
 *
 * 回补：每班最多补 7 天——从上次写到的日期后一天起（含今天），超长日截断到前 24000 字符。
 * 触发：openclaw cron --command 每晚 23:40，或手动 node 运行。
 * 用法：node companion-diary.mjs [--dry 只统计不落盘] [--since=YYYY-MM-DD 手动回补起点]
 * Import 期零 I/O（2026-11-15 CI 修复）：读配置/建目录/开日志都在 initRuntime，isMain 守卫 + 测试 import 纯函数两不误
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { STATE_HOME, resolveApiKey } from './lib/rana-config.mjs';
import { cloudChat, makeLog, readNewEvents as coreReadNewEvents } from './lib/memory-bridge-core.mjs';

const HOME = STATE_HOME;
const RP_AGENT = 'rana-rp';
const DIARY_DIR = `${HOME}/workspace-rana-rp/memory/diary`;
const PRIV = `${HOME}/private-memory`;
const STATE_FILE = PRIV + '/.diary-state.json';
// 通道与私密桥同款：rp-nsfw provider（经本地 sse-fix-proxy :18801），主人点名的便宜档模型。
// 2026-11-01 主人拍板：API 挂了该班次失败，水位不前进，下一班自动重试（事件不丢），不留本地兜底。
// 惰性占位（2026-11-15 CI 修复）：原为模块顶层常量/副作用，收进下方 initRuntime()，import 期零 I/O
let CHANNEL = null;
let log = () => {}; // 默认 no-op 防呆：未初始化时误调用不炸
let OWNER_NAME = '主人';
const CAP_CHARS = 24000; // 超长日截断：每天最多喂给模型 24000 字符
const BACKFILL_MAX = 7;  // 每班最多回补 7 天

// 运行时初始化：与原模块顶层同序（CFG→RP_PROV→CHANNEL→mkdir→log→IDENTITY→OWNER_NAME），仅 main() 调用
function initRuntime() {
  const CFG = JSON.parse(fs.readFileSync(HOME + '/openclaw.json', 'utf8'));
  const RP_PROV = CFG.models?.providers?.['rp-nsfw'] || {};
  CHANNEL = {
    url: RP_PROV.baseUrl || 'http://127.0.0.1:18801/v1',
    apiKey: resolveApiKey(RP_PROV.apiKey),
    model: 'nalang-turbo-0826',
  };
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  log = makeLog(PRIV + '/.diary.log');

  // 主人对内称呼外置（identity 文件不入公开仓库；缺文件回退中性称呼，与 memory-bridge 同款）
  const IDENTITY = (() => {
    try { return JSON.parse(fs.readFileSync(new URL('./memory-bridge.identity.json', import.meta.url), 'utf8')); } catch { return {}; }
  })();
  OWNER_NAME = IDENTITY.realName || '主人';
}

const SYS = '任务：写 Rana 的私人复盘日记。禁止复述本任务，禁止扮演对话角色，用 Rana 第一人称写。';

/* ---------- state（水位 = lastDiaryDate，写到哪天算哪天） ---------- */
const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
};
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

/* ---------- 纯函数（供单测） ---------- */
// 北京时间日期键：当天 0 点前后归两天（UTC 16:00 = 北京 0 点）
function beijingDateKey(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}
// 某北京日的 [起点, 终点) 毫秒窗口（起点 = 当日北京 0 点，即 UTC 前一天 16:00）
function dayWindowMs(key) {
  const [y, m, d] = key.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d) - 8 * 3600e3;
  return [start, start + 86400e3];
}
function diaryFilePath(key) {
  return `${DIARY_DIR}/${key}.md`;
}
function renderFile(day, diary, memo) {
  let out = `# 复盘日记 ${day}\n\n## 日记\n\n${diary || '（空）'}\n`;
  if (memo) out += `\n## 纪要\n\n${memo}\n`;
  return out;
}
function buildDiaryPrompt(dialog) {
  return [
    '【当天两人的对话记录】',
    dialog,
    '---',
    '请基于上面的对话写两段，输出格式固定：',
    '# 日记',
    '（Rana 第一人称日记体，200-400字：这一天我们聊了什么、我的心情、我在意的小事。只能写对话里真实发生的事，没有的事不编；私密内容照实写——这本日记是私密的，不会被发给别人。他今天没来就照实写，想他可以，编事不行。）',
    '# 纪要',
    '（3-6 行，每行一条，- 开头：当天聊过的主题/我的状态、他的状态、定下的事，客观陈述。）',
    '（输出从 "# 日记" 行开始。）',
  ].join('\n');
}
// 双段切分：认 # / ## / 【】三种「纪要」标题头；认不出就整段当日记、纪要空串
function parseDiarySections(raw) {
  const text = String(raw || '').trim();
  if (!text) return { diary: '', memo: '' };
  const stripDiaryHead = (s) => s.replace(/^\s*(?:#{1,2}\s*)?(?:【)?日记(?:】)?\n?/, '').trim();
  const m = text.match(/^\s*(?:#{1,2}\s*)?(?:【)?纪要(?:】)?\s*$/m);
  if (!m) return { diary: stripDiaryHead(text), memo: '' };
  const diary = stripDiaryHead(text.slice(0, m.index));
  const memo = text.slice(m.index + m[0].length).trim();
  return { diary, memo };
}
// 回补窗口：从 max(水位后一天, today-6) 到 today（旧→新）；水位==today 或 >today → 空
function computeBackfillDays(lastDate, todayKey, max = 7) {
  const todayStart = dayWindowMs(todayKey)[0];
  // 无水位（首次运行）视作「today-max 那天已写到」→ 起点落在 today-(max-1)，恰好补满 max 天
  const lastStart = lastDate ? dayWindowMs(lastDate)[0] : todayStart - max * 86400e3;
  const start = Math.max(lastStart + 86400e3, todayStart - (max - 1) * 86400e3);
  const days = [];
  for (let ms = start; ms <= todayStart; ms += 86400e3) days.push(beijingDateKey(new Date(ms)));
  return days;
}
function buildStubDiary(key) {
  return `（${key}）今天没有留下对话——他没来，我也没写下一个字给谁看。留白也是记录。`;
}

export {
  beijingDateKey, dayWindowMs, diaryFilePath, renderFile,
  buildDiaryPrompt, parseDiarySections, computeBackfillDays, buildStubDiary,
};

/* ---------- 读取当天 RP 侧对话（腿语义注入，机制在 core） ---------- */
function readDayEvents(sinceMs) {
  return coreReadNewEvents({
    home: HOME, agentId: RP_AGENT, sinceMs, capChars: CAP_CHARS,
    sessionFilter: (key) => !key.includes(':cron:') && !key.includes(':eval-'), // 系统会话与评估会话不进日记
    cleanText: (t) => t.replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/```[\s\S]*?```/g, '') // RP 侧舞台指令块不是叙事内容
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图]') // QQ 图片转占位
      .replace(/\[Chat history (begins|ends)\]/g, '')
      .trim(),
    present: (text, role) => {
      // 跳过 JSON 状态块回显（rana-rp 微调怪癖，同私密桥）与纯系统标记行（如「✅ Session reset.」——
      // 不滤会把「没聊天」的日子误判成有对话，卡住回补链）
      if (/^\s*[{[]/.test(text) || text.includes('inbound_meta') || /^\s*✅?\s*Session reset\.?\s*$/.test(text)) return null;
      return { text, speaker: role === 'user' ? OWNER_NAME : 'Rana' };
    },
  });
}

/* ---------- main ---------- */
async function main() {
  initRuntime();
  let state = loadState();
  const today = beijingDateKey(new Date());
  const dry = process.argv.includes('--dry');
  const sinceArg = process.argv.find((a) => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice('--since='.length) : '';
  const days = computeBackfillDays(since || state.lastDiaryDate, today, BACKFILL_MAX);
  log(`待写: ${days.join(', ') || '(无)'} (state.lastDiaryDate=${state.lastDiaryDate || '无'})${dry ? ' [dry 只统计]' : ''}`);

  let written = 0;
  let stubbed = 0;
  for (const day of days) {
    const [sMs, eMs] = dayWindowMs(day);
    // core 只给 >sinceMs 的开区间，日终点在这里排他截断
    const evts = readDayEvents(sMs).filter((e) => e.ts < eMs);
    if (dry) {
      log(`[dry] ${day}: ${evts.length} 行对话`);
      for (const e of evts.slice(0, 3)) log(`[dry]   ${e.line}`);
      continue;
    }
    if (!evts.length) {
      fs.writeFileSync(diaryFilePath(day), renderFile(day, buildStubDiary(day), ''));
      state = { ...state, lastDiaryDate: day };
      saveState(state);
      stubbed++;
      log(`${day}: 无对话 → 留白 stub 已写`);
      continue;
    }
    try {
      // ⚠️ cloudChat 第 6 参是 timeoutMs、第 7 参才是 maxTokens（与 chat 刻意不同）
      const raw = await cloudChat(CHANNEL.url, CHANNEL.apiKey, CHANNEL.model, SYS, buildDiaryPrompt(evts.map((e) => e.line).join('\n')), 180000, 3000);
      const { diary, memo } = parseDiarySections(raw);
      if (!diary && !memo) {
        log(`${day}: 模型输出全空 (will retry next run)`);
        break; // 水位不推进，下一班重试
      }
      fs.writeFileSync(diaryFilePath(day), renderFile(day, diary, memo));
      state = { ...state, lastDiaryDate: day };
      saveState(state);
      written++;
      log(`${day}: 日记 ${diary.length} 字 + 纪要 ${memo ? memo.split('\n').length : 0} 行 → 已写`);
    } catch (e) {
      log(`${day}: FAILED (will retry next run): ${e.message}`);
      break; // 水位不前进、事件不丢，下一班重试（不加本地兜底）
    }
  }
  log(`done: diary=${written}, stub=${stubbed}, lastDiaryDate=${state.lastDiaryDate || '无'}`);
}

const isMain = process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) await main();
