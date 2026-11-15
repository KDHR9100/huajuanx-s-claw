// 「📊 用量」页的数据聚合纯函数——agent 库 runtime 事件行 → 日桶/会话桶，及账本每日桶的合并。
// 抽成零依赖叶模块：聚合规则（事件白名单/分桶/合并幂等）配 vitest 直测（tests/unit/usage-aggregate.test.ts）。
//
// 数据真相（2026-11-08 实查三库）：每轮 run 恰好一条 type=model.completed 事件带 usage
// （main 库 79 run=79 条，assistant.message 等其他类型也带 usage，一律不认，防双计）；
// model.completed 自身不带模型名，同 run 的 prompt.submitted 等事件顶层带 modelId，按 runId 关联。

/** 一轮模型调用的 token 用量（加法项；runs = model.completed 条数 ≈ 完成 run 数） */
export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** 事件里的 total 或 totalTokens；缺失时回退 input+output+cacheRead+cacheWrite */
  total: number;
  runs: number;
}

/** agent 库 trajectory_runtime_events 的一行（宽松形态，容错解析） */
export interface RuntimeEventRow {
  run_id?: unknown;
  event_json?: unknown;
  created_at?: unknown;
}

/** 解析后的 runtime 事件（只留聚合需要的字段） */
export interface ParsedUsageEvent {
  agentId: string;
  runId: string;
  tsMs: number;
  sessionKey: string;
  type: string;
  /** 事件顶层 modelId（prompt.submitted 等带；model.completed 不带） */
  modelId?: string;
  /** 仅 model.completed 且 usage 合法时存在 */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };
}

/** 非负整数化：undefined/负数/NaN 一律 0（usage 字段脏数据容错） */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** 解析 usage 对象（兼容 total 与 totalTokens 两种键名；total 缺失回退四项之和，与官方口径对齐） */
export function readUsage(u: unknown): ParsedUsageEvent["usage"] | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const input = num(o.input);
  const output = num(o.output);
  const cacheRead = num(o.cacheRead);
  const cacheWrite = num(o.cacheWrite);
  const reasoning = num(o.reasoningTokens);
  const rawTotal = num(o.totalTokens) || num(o.total);
  const total = rawTotal || input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, reasoning, total };
}

/**
 * 把一个 agent 库的事件行解析成聚合输入（坏行跳过）。
 * 顺序保持调用方给的（应按 created_at ASC）；模型归属在聚合时按「run 内第一条带 modelId 的事件」定。
 */
export function parseRuntimeEvents(agentId: string, rows: RuntimeEventRow[]): ParsedUsageEvent[] {
  const out: ParsedUsageEvent[] = [];
  for (const row of rows) {
    try {
      if (typeof row.event_json !== "string") continue;
      const ev = JSON.parse(row.event_json) as Record<string, unknown>;
      const type = typeof ev.type === "string" ? ev.type : "";
      if (!type) continue;
      const tsMs =
        typeof row.created_at === "number" && Number.isFinite(row.created_at) && row.created_at > 0
          ? row.created_at
          : typeof ev.ts === "string" && Date.parse(ev.ts) > 0
            ? Date.parse(ev.ts)
            : 0;
      if (!tsMs) continue;
      const runId = typeof row.run_id === "string" ? row.run_id : typeof ev.runId === "string" ? ev.runId : "";
      out.push({
        agentId,
        runId,
        tsMs,
        sessionKey: typeof ev.sessionKey === "string" ? ev.sessionKey : "",
        type,
        modelId: typeof ev.modelId === "string" && ev.modelId ? ev.modelId : undefined,
        usage: type === MODEL_COMPLETED ? readUsage(ev.data && typeof ev.data === "object" ? (ev.data as Record<string, unknown>).usage : undefined) : undefined,
      });
    } catch {
      // 单行坏 JSON 跳过，不拖垮整个库的扫描
    }
  }
  return out;
}

const MODEL_COMPLETED = "model.completed";

/** 本地时区日期键（YYYY-MM-DD）——全本地构造，不写死 UTC 串（11-08 备份仓 CI 时区混用教训） */
export function bucketDate(tsMs: number): string {
  const d = new Date(tsMs);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 每日桶：日期 → 各 agent 的用量与模型分布 */
export type DayBuckets = Record<string, Record<string, AgentDayUsage>>;

/** 单 agent 单日用量 */
export interface AgentDayUsage extends UsageCounts {
  /** 模型 → total token（模型构成条数据源） */
  models: Record<string, number>;
}

/** 会话桶：sessionKey → 会话累计（不按天切）；label 由账本层补（agent 库 session_nodes 的显示名） */
export type SessionBuckets = Record<
  string,
  UsageCounts & { agentId: string; label?: string; firstTs: number; lastTs: number; models: Record<string, number> }
>;

/** 把 UsageCounts 的数值字段累加进目标（不动 models） */
function addCounts(target: UsageCounts, add: UsageCounts): void {
  target.input += add.input;
  target.output += add.output;
  target.cacheRead += add.cacheRead;
  target.cacheWrite += add.cacheWrite;
  target.reasoning += add.reasoning;
  target.total += add.total;
  target.runs += add.runs;
}

/** 合并两个每日桶（src 并入 dst，原对象就地改）；纯加法、幂等性由调用方保证（同事件不重复喂） */
export function mergeDayBuckets(dst: DayBuckets, src: DayBuckets): DayBuckets {
  for (const [date, agents] of Object.entries(src)) {
    const dstDay = (dst[date] ??= {});
    for (const [agentId, au] of Object.entries(agents)) {
      const dstAu = (dstDay[agentId] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, runs: 0, models: {} });
      addCounts(dstAu, au);
      for (const [m, t] of Object.entries(au.models)) dstAu.models[m] = (dstAu.models[m] ?? 0) + t;
    }
  }
  return dst;
}

/** 合并两个会话桶（src 并入 dst，原对象就地改） */
export function mergeSessionBuckets(dst: SessionBuckets, src: SessionBuckets): SessionBuckets {
  for (const [key, s] of Object.entries(src)) {
    const d = dst[key];
    if (!d) {
      dst[key] = { ...s, models: { ...s.models } };
      continue;
    }
    addCounts(d, s);
    for (const [m, t] of Object.entries(s.models)) d.models[m] = (d.models[m] ?? 0) + t;
    d.firstTs = Math.min(d.firstTs, s.firstTs);
    d.lastTs = Math.max(d.lastTs, s.lastTs);
  }
  return dst;
}

/**
 * 聚合主函数：解析后的事件数组 → 每日桶 + 会话桶。
 * 模型归属：按事件顺序（created_at ASC），run 内第一条带 modelId 的事件定该 run 的模型；
 * 归属不到的 usage 事件记到 "(unknown)"。调用方须保证同一事件不重复喂（幂等边界）。
 */
export function aggregateParsedEvents(events: ParsedUsageEvent[]): { days: DayBuckets; sessions: SessionBuckets } {
  const days: DayBuckets = {};
  const sessions: SessionBuckets = {};
  const runModels: Record<string, string> = {};
  for (const ev of events) {
    if (ev.modelId && ev.runId && !runModels[ev.runId]) runModels[ev.runId] = ev.modelId;
  }
  for (const ev of events) {
    const u = ev.usage;
    if (!u) continue;
    const modelId = (ev.runId && runModels[ev.runId]) || "(unknown)";
    // —— 日桶 ——
    const date = bucketDate(ev.tsMs);
    const day = (days[date] ??= {});
    const au = (day[ev.agentId] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, runs: 0, models: {} });
    au.input += u.input;
    au.output += u.output;
    au.cacheRead += u.cacheRead;
    au.cacheWrite += u.cacheWrite;
    au.reasoning += u.reasoning;
    au.total += u.total;
    au.runs += 1;
    au.models[modelId] = (au.models[modelId] ?? 0) + u.total;
    // —— 会话桶 ——
    if (ev.sessionKey) {
      const s = (sessions[ev.sessionKey] ??= {
        agentId: ev.agentId,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, runs: 0,
        firstTs: ev.tsMs, lastTs: ev.tsMs, models: {},
      });
      s.input += u.input;
      s.output += u.output;
      s.cacheRead += u.cacheRead;
      s.cacheWrite += u.cacheWrite;
      s.reasoning += u.reasoning;
      s.total += u.total;
      s.runs += 1;
      s.models[modelId] = (s.models[modelId] ?? 0) + u.total;
      s.firstTs = Math.min(s.firstTs, ev.tsMs);
      s.lastTs = Math.max(s.lastTs, ev.tsMs);
    }
  }
  return { days, sessions };
}
