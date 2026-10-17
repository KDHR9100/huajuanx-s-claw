// memory-bridge-parse.mjs — memory-bridge.mjs 的 parseEntries 纯函数抽取（供单测 import）
//
// 函数体来自 memory-bridge.mjs L227 逐字搬移（L228-248，一个字符不改，含原缩进——
// 所以闭包内的缩进与工厂嵌套不齐，是刻意的，供逐字节审计）。
// 原函数引用模块级状态 OWNER_NAME / OWNER_ALIAS / LOCAL_FILTERS（来自 gitignored 的
// identity/privacy-patterns 文件），故以工厂注入——原脚本行为与之前完全一致。
// memory-bridge.mjs 是 cron 直跑的生产脚本（记忆系统心脏），验证走单测，不跑原脚本。

export function makeParseEntries({ OWNER_NAME, OWNER_ALIAS, LOCAL_FILTERS }) {
  return function parseEntries(raw, tag, fallbackTs) {
  if (!raw || (/空/.test(raw) && raw.length < 10)) return [];
  const entries = [];
  for (let ln of raw.split('\n')) {
    ln = ln.replace(/^[-*\s]+/, '').trim();
    if (!ln || /^(空|无)/.test(ln)) continue;
    // 防模型复述任务/角色扮演/舞台指令/照抄对话（本地 7B 常见毛病）
    if (/记忆提炼器|共享记忆纪要|禁止复述|```|坐姿[:：]|^\*?\*?-(坐姿|状态|行为)/.test(ln)) continue;
    if (new RegExp(`${OWNER_NAME}:|Rana:|\\[\\d{1,2}:\\d{2}\\]`).test(ln)) continue; // 原文回声
    // 隐私兜底/运维噪音兜底：正则表放本地 privacy-patterns 文件（不入公开仓库），缺文件时跳过
    if (tag === 'RP' && LOCAL_FILTERS.rpPrivacy && new RegExp(LOCAL_FILTERS.rpPrivacy).test(ln)) continue;
    if (tag === '工作' && LOCAL_FILTERS.opsNoise && new RegExp(LOCAL_FILTERS.opsNoise, 'i').test(ln)) continue;
    if (tag !== '群聊' && !new RegExp(`${OWNER_ALIAS}|${OWNER_NAME}|Rana`).test(ln)) continue; // 纪要必须提到主人或 Rana（群聊侧人名不限）
    if (tag === '群聊' && !/[\u4e00-\u9fa5]/.test(ln)) continue; // 群聊纪要至少得有中文
    ln = ln.replace(/刘南|刘娜/g, 'Rana'); // 7B 微调残留的错误自称，入库前统一改回
    const m = ln.match(/^(\d{1,2}:\d{2})\s*\[/);
    const time = m ? m[1] : new Date(fallbackTs).toTimeString().slice(0, 5);
    if (!ln.includes(`[${tag}]`)) ln = `${time} [${tag}] ${ln.replace(/^(\d{1,2}:\d{2})?\s*/, '')}`;
    if (ln.length > 15) entries.push({ time, line: ln.slice(0, 120) });
  }
  return entries.slice(0, 3);
}
}
