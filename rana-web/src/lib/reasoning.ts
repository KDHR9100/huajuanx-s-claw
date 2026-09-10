// 思考过程解析：把模型输出拆成 思考过程 + 正文。
// 适配三类来源：
// 1. OpenClaw reasoning=stream/on 时内联的 <think>...</think>（含流式未闭合）；
// 2. 多个 <think> 块（部分本地模型分段输出）；
// 3. 本地 RP 微调模型把伪思维链写进 <details><summary>xx分析</summary>…</details> 块。
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const DETAILS_RE = /<details[^>]*>\s*<summary[^>]*>\s*([^<]*)<\/summary>/i;
// summary 含这些关键词的 details 块才当作思考过程折叠（普通折叠内容照常显示）
const DETAILS_REASON_HINT = /分析|思考|思緒|思绪|reason|think|plan|深究/i;

export interface SplitReasoning {
  /** 思考过程（不含标签）；流式未闭合时为已生成的思考片段 */
  reasoning: string;
  thinking: boolean;
  /** 去除思考后的正文 */
  text: string;
}

function indexOfTag(hay: string, needle: string, from: number): number {
  // 标签名大小写不敏感（<Think> 也算），标签内内容保持原样
  const lower = hay.toLowerCase();
  return lower.indexOf(needle, from);
}

interface DetailsHit {
  start: number;
  /** summary 结束位置（思考正文从这里开始） */
  bodyStart: number;
  end: number; // -1 表示未闭合
}

function findDetails(text: string, from: number): DetailsHit | null {
  const re = new RegExp(DETAILS_RE.source, "i");
  re.lastIndex = from;
  const rest = text.slice(from);
  const m = re.exec(rest);
  if (!m || !DETAILS_REASON_HINT.test(m[1] ?? "")) return null;
  const start = from + m.index;
  const bodyStart = start + m[0].length;
  const close = indexOfTag(text, "</details>", bodyStart);
  return { start, bodyStart, end: close };
}

export function splitReasoning(raw: string): SplitReasoning {
  if (!raw) return { reasoning: "", thinking: false, text: "" };
  const thinks: string[] = [];
  const texts: string[] = [];
  let thinking = false;
  let pos = 0;
  for (let guard = 0; guard < 24; guard++) {
    const t = indexOfTag(raw, THINK_OPEN, pos);
    const d = findDetails(raw, pos);
    // 取更早出现的那个标记
    const useThink = t !== -1 && (d === null || t <= d.start);
    if (useThink) {
      texts.push(raw.slice(pos, t));
      const bodyStart = t + THINK_OPEN.length;
      const close = indexOfTag(raw, THINK_CLOSE, bodyStart);
      if (close === -1) {
        thinks.push(raw.slice(bodyStart));
        thinking = true;
        pos = raw.length;
        break;
      }
      thinks.push(raw.slice(bodyStart, close));
      pos = close + THINK_CLOSE.length;
      continue;
    }
    if (d) {
      texts.push(raw.slice(pos, d.start));
      if (d.end === -1) {
        thinks.push(raw.slice(d.bodyStart));
        thinking = true;
        pos = raw.length;
        break;
      }
      thinks.push(raw.slice(d.bodyStart, d.end));
      pos = d.end + "</details>".length;
      continue;
    }
    break;
  }
  // 收尾：最后一个思考块之后的正文尾巴
  texts.push(raw.slice(pos));
  if (!thinks.length) return { reasoning: "", thinking: false, text: raw };
  const text = texts.map((s) => s.trim()).filter(Boolean).join("\n\n");
  const reasoning = thinks.map((s) => s.trim()).filter(Boolean).join("\n\n");
  return { reasoning, thinking, text };
}

// OpenClaw 运行时封套回显剥离：模型偶尔会把注入的 <!-- openclaw:attempt:... --> 指令块
// 原样吐进正文（压缩前记忆冲刷回合最易触发）。剥掉封套块；整条只剩封套 → echo=true，
// 前端折叠成占位行。封套出现在正文中间/前后有真实内容时只剥不折叠。
const ENVELOPE_OPEN_RE = /<!--\s*openclaw:attempt[^>]*-->/i;

export interface StripEnvelope {
  /** true = 整条消息只是封套回显，没有真实回复 */
  echo: boolean;
  /** 剥离封套后的正文（可能为空） */
  text: string;
}

export function stripOpenclawEnvelope(raw: string): StripEnvelope {
  if (!raw) return { echo: false, text: raw };
  let out = raw;
  for (let guard = 0; guard < 8; guard++) {
    const m = ENVELOPE_OPEN_RE.exec(out);
    if (!m) break;
    const start = m.index;
    const closeIdx = out.toLowerCase().indexOf("<!-- /openclaw:attempt", start + m[0].length);
    if (closeIdx === -1) {
      // 未闭合（流式中）：从开标签起整段按封套处理
      out = out.slice(0, start);
      break;
    }
    const closeEnd = out.indexOf("-->", closeIdx);
    out = out.slice(0, start) + (closeEnd === -1 ? "" : out.slice(closeEnd + 3));
  }
  // 每回合注入的内部上下文块（<<<BEGIN/END_OPENCLAW_INTERNAL_CONTEXT>>>）偶尔被模型抄进回复
  out = out.replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, "");
  // RP 模型偶发的元块模仿：```代码块里装 "## Chat history"/"## Memory" 等档案结构
  out = out.replace(/```[a-z]*\n## (?:Chat history|Memory|Private|Runtime)[\s\S]*?```/gi, "");
  // 回复开头的日期/时间标题头（"## Fri 2026-09-10 …" / "## [23:04 RP]"）
  out = out.replace(/^(?:#{1,3} \[?\d{1,2}:\d{2}[^\n]*|#{1,3} (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\n]*)\n+/gim, "");
  const text = out.replace(/<!--\s*\/?\s*openclaw:attempt[^>]*-->/gi, "").replace(/^\s+|\s+$/g, "");
  return { echo: !text, text };
}
