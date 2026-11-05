// 日期/时间格式化统一出口（2026-11-06 收拢：此前散在 8+ 个组件里各抄一份）。
// 各函数与原手抄版逐字等价，仅集中定义；fateCore 的命理 pad2 保留不动，勿合并。

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** "M/D HH:MM"：月/日不补 0、时分补 0（本机惯用格式） */
export const fmtDayTime = (ts: number) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** fmtDayTime 的守卫版：falsy 显示占位符（QQ陪伴页原语义 "—"） */
export const fmtDayTimeOr = (ms?: number, empty = "—") => (!ms ? empty : fmtDayTime(ms));

/** ISO 字符串入参版：空或非法返回占位符（过程页原语义） */
export const fmtIsoTime = (iso?: string, empty = "") => {
  if (!iso) return empty;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? empty : fmtDayTime(d.getTime());
};

/** "HH:MM"（补 0） */
export const fmtHm = (ts: number) => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** fmtHm 守卫版：falsy→占位符（聊天流/早报原语义） */
export const fmtHmOr = (ts?: number, empty = "") => (!ts ? empty : fmtHm(ts));

/** 近期时间：今天显示 HH:MM，更早显示 M/D HH:MM（侧栏会话列表原语义） */
export const fmtSmartTime = (ts?: number, empty = "") => {
  if (!ts) return empty;
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? fmtHm(ts) : fmtDayTime(ts);
};

/** 相对时间：X 分钟/小时前，超过一天 X 天前（天数向下取整） */
export const fmtAgo = (ts?: number, empty = "") => {
  if (!ts) return empty;
  const min = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (min < 60) return `${min} 分钟前`;
  if (min < 60 * 24) return `${Math.round(min / 60)} 小时前`;
  return `${Math.floor(min / 60 / 24)} 天前`;
};

/** "YYYY-MM-DD"（补 0） */
export const dateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 今天 "YYYY-MM-DD" */
export const todayStr = () => dateStr(new Date());

/** "YYYY-M-D"（不补 0，内容库沿用旧格式） */
export const fmtDateYMD = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** ds("YYYY-MM-DD") 平移 n 天 */
export const addDays = (ds: string, n: number) => {
  const [y, m, d] = ds.split("-").map(Number);
  return dateStr(new Date(y, m - 1, d + n));
};
