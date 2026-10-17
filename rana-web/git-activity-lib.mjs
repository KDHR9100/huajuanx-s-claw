// git-activity-lib.mjs — git-activity.mjs 的纯函数抽取（函数体逐字搬移、零改写，供单测 import）
// 原脚本是 cron 直跑的生产脚本，顶层有副作用（argv 解析→git 统计→写报告）；
// 本文件只承载其中无副作用的纯函数。口径说明见 git-activity.mjs 头注。

// ---------- 常量 ----------
const AUTO_PREFIXES = [/^sync:/i, /^backup[\s]/i]; // 自动提交特征（push-public / backup-private）

// ---------- 时间边界（本地时区） ----------
export function periodRange(period, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  if (period === "today") {
    const start = new Date(y, m, now.getDate());
    return { start, end: new Date(y, m, now.getDate() + 1) };
  }
  if (period === "week") {
    // 本周一 00:00 为终点；往前 7 天为起点（= 上周一 00:00）
    const dow = (now.getDay() + 6) % 7; // 周一=0 ... 周日=6
    const thisMonday = new Date(y, m, now.getDate() - dow);
    return { start: new Date(thisMonday.getTime() - 7 * 864e5), end: thisMonday };
  }
  // month：上月 1 日 00:00 ~ 本月 1 日 00:00
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}

// ---------- 工具 ----------
export function isAutoCommit(subject) {
  return AUTO_PREFIXES.some((re) => re.test(subject));
}
