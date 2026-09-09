// <think> 标签解析：把模型输出拆成 思考过程 + 正文。
// 适配 OpenClaw reasoning=stream/on 时内联的 <think>...</think>，
// 以及流式期间只出现了开标签（仍在思考）的情况。
export interface SplitReasoning {
  /** 思考过程（不含标签）；流式未闭合时为已生成的思考片段 */
  reasoning: string;
  thinking: boolean;
  /** 去除思考后的正文 */
  text: string;
}

const OPEN = "<think>";
const CLOSE = "</think>";

export function splitReasoning(raw: string): SplitReasoning {
  if (!raw) return { reasoning: "", thinking: false, text: "" };
  const start = raw.indexOf(OPEN);
  if (start === -1) return { reasoning: "", thinking: false, text: raw };
  const before = raw.slice(0, start).trim();
  const end = raw.indexOf(CLOSE, start);
  if (end === -1) {
    // 未闭合：仍在思考
    return { reasoning: raw.slice(start + OPEN.length).trim(), thinking: true, text: before };
  }
  const reasoning = raw.slice(start + OPEN.length, end).trim();
  const after = raw.slice(end + CLOSE.length).trim();
  return { reasoning, thinking: false, text: [before, after].filter(Boolean).join("\n\n") };
}
