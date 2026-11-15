// 「📊 用量」页的视图层纯函数——KPI 汇总/日柱/热力图网格/格式化，配单测（tests/unit/usage-view.test.ts）。
// 与服务端 usage-aggregate.ts 的分桶口径对齐：日期键一律本地时区 YYYY-MM-DD。

/** 通用 token 计数（与服务端 UsageCounts 同构） */
export interface UsageViewCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  runs: number;
}

/** 账本下发的一天（agents: agentId → 当日用量） */
export interface UsageDay {
  date: string;
  agents: Record<string, UsageViewCounts & { models?: Record<string, number> }>;
}

/** 账本下发的会话行（会话用量排行数据源） */
export interface UsageSessionRow {
  key: string;
  agentId: string;
  label?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  runs: number;
  firstTs: number;
  lastTs: number;
  models?: Record<string, number>;
}

/** /__rana/usage 的页面载荷（重建中/建账完成两种形态） */
export interface UsagePayload {
  ok: boolean;
  rebuilding?: boolean;
  progress?: { phase: string; agentId: string; rowsDone: number; rowsTotal: number; startedAt: string; error?: string };
  updatedAt?: string;
  lastEventTs?: number;
  agents: Array<{ id: string; name: string }>;
  days: UsageDay[];
  sessions: UsageSessionRow[];
}

// ===== 视图助手 =====

/** token 数格式化（与 UsagePanel 同口径：1234→1.2k，1.23M） */
export function fmtTokens(n: number | undefined): string {
  if (!n || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 本地时区日期键（与服务端 bucketDate 同口径） */
export function dayKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 近 n 天的日期键数组（今天结尾，本地时区） */
export function lastNDaysKeys(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    out.push(dayKey(d));
  }
  return out;
}

/** 区间汇总：从 days 里挑指定日期键（可再按 agent 过滤）累加（不含区间外的天） */
export function rangeTotal(
  days: UsageDay[],
  keys: Set<string> | null,
  agentFilter: string | null,
): UsageViewCounts {
  const t: UsageViewCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, runs: 0 };
  for (const d of days) {
    if (keys && !keys.has(d.date)) continue;
    for (const [aid, au] of Object.entries(d.agents)) {
      if (agentFilter && aid !== agentFilter) continue;
      t.input += au.input || 0;
      t.output += au.output || 0;
      t.cacheRead += au.cacheRead || 0;
      t.cacheWrite += au.cacheWrite || 0;
      t.reasoning += au.reasoning || 0;
      t.total += au.total || 0;
      t.runs += au.runs || 0;
      }
  }
  return t;
}

// ===== 热力图与模型构成 =====

/** agent 配色盘（按清单顺序循环取色；main=绿 / RP=粉 / QQ=琥珀的口味靠清单顺序落位） */
export const AGENT_PALETTE = ["#77dd77", "#ff97b4", "#ffc266", "#7fc4ff", "#b58cff", "#7fe0d4"];

export function agentColor(index: number): string {
  return AGENT_PALETTE[index % AGENT_PALETTE.length];
}

/** 近 8 周热力图网格：周一开头的周列，每列 7 天（周一起）；value=当日 total token */
export function heatmapGrid(days: UsageDay[]): Array<Array<{ date: string; value: number; inFuture: boolean }>> {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 周一=0
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow - 7 * 7);
  const weeks = [];
  for (let w = 0; w < 8; w++) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + w * 7 + i);
      const key = dayKey(d);
      const day = byDate.get(key);
      let value = 0;
      for (const au of Object.values(day?.agents ?? {})) value += au.total || 0;
      col.push({ date: key, value, inFuture: d > today });
  }
    weeks.push(col);
  }
  return weeks;
}

/** 近30天模型构成：合并指定日期键内、过滤 agent 后的 models 映射（模型→total） */
export function modelMix(days: UsageDay[], keys: Set<string>, agentFilter: string | null): Array<{ model: string; total: number }> {
  const mix = new Map<string, number>();
  for (const d of days) {
    if (!keys.has(d.date)) continue;
    for (const [aid, au] of Object.entries(d.agents)) {
      if (agentFilter && aid !== agentFilter) continue;
      for (const [m, t] of Object.entries(au.models ?? {})) mix.set(m, (mix.get(m) ?? 0) + t);
    }
  }
  return [...mix.entries()].map(([model, total]) => ({ model, total })).sort((a, b) => b.total - a.total);
}
