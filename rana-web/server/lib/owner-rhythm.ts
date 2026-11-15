// 主人作息卡纯函数（2026-11-15 作息卡）：把哨兵三份账本（owner-usage / owner-watch-state /
// owner-status.config）聚合成 QQ陪伴页「🌙 今日作息」要的 rhythm 形状。
// 纪律：零依赖叶模块（不 import node 内置），输入是三个解析好的对象 + 注入的 now（可测性）；
// 数据端「有什么画什么」——文件缺/字段缺一律降级，绝不编造窗口时刻。
// 真实字段来源：owner-status.mjs 的 updateUsage / updateStreaks / recordNag / rolloverIfNeeded。

export interface RhythmFocusItem {
  name: string;
  minutes: number;
}

/** 近 7 天热力的一个槽位：totalFocusMinutes=null 表示这天没账（前端画灰格「未积累」） */
export interface RhythmWeekDay {
  day: string;
  totalFocusMinutes: number | null;
}

/** 昨晚块：游戏连跑（streak）与深夜窗口的交集；windowLabel 形如 "23:40-01:20" */
export interface RhythmLastNight {
  game: string;
  minutes: number;
  windowLabel: string;
}

export interface OwnerRhythm {
  day: string;
  /** 键鼠空闲超线（分钟）不计专注，来自 config.focusIdleSkipMinutes，缺省 15 */
  idleSkipMinutes: number;
  focusTop5: RhythmFocusItem[];
  yesterday: { day: string; top: RhythmFocusItem[] } | null;
  lastNight: RhythmLastNight | null;
  /** 催睡次数 = ledger.nags 里落在昨晚窗口内的条数（独立于游戏块存在与否） */
  nagsLastNight: number;
  /** 每次催睡的本地时刻 "HH:MM"（时间升序，与 nags 记账顺序一致） */
  nagTimes: string[];
  /** 近 7 天（今天在最后） */
  weekHistory: RhythmWeekDay[];
  updatedAt: string | null;
}

/** 哨兵侧的原始形状（只挑用得到的字段，多余字段忽略） */
interface UsageRaw {
  day?: string;
  updatedAt?: string | null;
  focusSeconds?: Record<string, unknown>;
  focusMinutes?: Record<string, unknown>;
  yesterday?: { day?: string; top?: Array<{ name?: string; minutes?: number }> } | null;
  history?: Array<{ day?: string; totalFocusMinutes?: number }>;
}
interface StateRaw {
  streaks?: Record<string, unknown>;
  ledger?: { nags?: Array<{ at?: string; game?: string }> };
}
interface ConfigRaw {
  nightStart?: string;
  nightEnd?: string;
  focusIdleSkipMinutes?: number;
}

const NIGHT_START_DEFAULT = "23:00";
const NIGHT_END_DEFAULT = "03:00";
const IDLE_SKIP_DEFAULT = 15;
const WEEK_DAYS = 7;

/** "HH:MM" -> 分钟数；非法返回 null */
function toMinutes(hhmm: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ""));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 24 * 60 ? v : null;
}

/** 本地 "YYYY-MM-DD"（与哨兵 localDateKey 同语义） */
function dateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "HH:MM"（本地钟） */
function hm(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 与 now 同钟构造「昨晚」的深夜窗口；起止相同/非法 = 永不（返回 null），跨零点默认结束在今天。 */
export function nightWindowBefore(now: Date, nightStart: unknown, nightEnd: unknown): { start: Date; end: Date } | null {
  const startMin = toMinutes(nightStart ?? NIGHT_START_DEFAULT);
  const endMin = toMinutes(nightEnd ?? NIGHT_END_DEFAULT);
  if (startMin === null || endMin === null || startMin === endMin) return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, Math.floor(startMin / 60), startMin % 60);
  const end =
    endMin > startMin
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, Math.floor(endMin / 60), endMin % 60)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(endMin / 60), endMin % 60);
  return { start, end };
}

/** 程序分钟表：优先 focusMinutes（问候模型好读版），空了退回 focusSeconds 换算 */
function focusMapOf(usage: UsageRaw): Array<{ name: string; minutes: number }> {
  const fromMinutes = usage.focusMinutes;
  if (fromMinutes && typeof fromMinutes === "object" && Object.keys(fromMinutes).length > 0) {
    return Object.entries(fromMinutes)
      .map(([name, minutes]) => ({ name, minutes: Number(minutes) }))
      .filter((x) => x.name && Number.isFinite(x.minutes) && x.minutes > 0);
  }
  const fromSeconds = usage.focusSeconds;
  if (!fromSeconds || typeof fromSeconds !== "object") return [];
  return Object.entries(fromSeconds)
    .map(([name, sec]) => ({ name, minutes: Math.round(Number(sec) / 60) }))
    .filter((x) => x.name && Number.isFinite(x.minutes) && x.minutes > 0);
}

/** 全程序合计专注分钟（今天槽位与日切封账同口径：秒合计再取整分钟） */
function totalFocusMinutesOf(usage: UsageRaw): number {
  const sec = usage.focusSeconds;
  if (sec && typeof sec === "object" && Object.keys(sec).length > 0) {
    const total = Object.values(sec).reduce((sum: number, v) => sum + (Number(v) || 0), 0);
    return Math.round(total / 60);
  }
  return focusMapOf(usage).reduce((sum, x) => sum + x.minutes, 0);
}

/**
 * 聚合入口：usage/state/config 三个解析好的对象（读不到传 null）+ now（测试注入）。
 * usage 不可读 -> null（整卡空态由前端兜）。其余字段缺一律降级成空值，不编数据。
 */
export function buildOwnerRhythm({
  usage,
  state,
  config,
  now,
}: {
  usage: UsageRaw | null;
  state: StateRaw | null;
  config: ConfigRaw | null;
  now: Date;
}): OwnerRhythm | null {
  if (!usage || typeof usage !== "object") return null;

  // 今日专注 Top5：降序截断
  const focusTop5 = focusMapOf(usage)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 5);

  // 昨晚窗口（跨零点）+ 游戏 streak 交集 + 催睡记账过滤
  const win = nightWindowBefore(now, config?.nightStart, config?.nightEnd);
  const nags = Array.isArray(state?.ledger?.nags) ? state!.ledger!.nags! : [];
  const inWindowNags = win
    ? nags.filter((n) => {
        const t = Date.parse(String(n?.at ?? ""));
        return Number.isFinite(t) && t >= win.start.getTime() && t <= win.end.getTime();
      })
    : [];
  const nagTimes = inWindowNags.map((n) => hm(new Date(Date.parse(String(n.at)))));

  let lastNight: RhythmLastNight | null = null;
  if (win) {
    // streaks: {游戏名: 起始ISO}；取与昨晚窗口交集最大的那个（实践中 updateStreaks 只留一个）
    let best: { game: string; minutes: number; windowLabel: string } | null = null;
    for (const [game, since] of Object.entries(state?.streaks ?? {})) {
      const t = Date.parse(String(since ?? ""));
      if (!Number.isFinite(t)) continue;
      const overlapStart = Math.max(t, win.start.getTime());
      const overlapEnd = Math.min(now.getTime(), win.end.getTime());
      if (overlapEnd <= overlapStart) continue;
      const minutes = Math.max(1, Math.round((overlapEnd - overlapStart) / 60000));
      const label = `${hm(new Date(overlapStart))}-${hm(new Date(overlapEnd))}`;
      if (!best || minutes > best.minutes) best = { game, minutes, windowLabel: label };
    }
    lastNight = best;
  }

  // 近 7 天：今天 = focusMinutes 合计；其余从日切封账 history 里查（没有积累的日子给 null）
  const historyMap = new Map<string, number>();
  for (const h of Array.isArray(usage.history) ? usage.history : []) {
    if (h && typeof h.day === "string" && Number.isFinite(Number(h.totalFocusMinutes))) {
      historyMap.set(h.day, Number(h.totalFocusMinutes));
    }
  }
  const today = dateKey(now);
  const weekHistory: RhythmWeekDay[] = [];
  for (let i = WEEK_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dateKey(d);
    if (usage.day === key) weekHistory.push({ day: key, totalFocusMinutes: totalFocusMinutesOf(usage) });
    else if (historyMap.has(key)) weekHistory.push({ day: key, totalFocusMinutes: historyMap.get(key) ?? 0 });
    else weekHistory.push({ day: key, totalFocusMinutes: null });
  }

  // 昨日 Top3 透传（形状对才给）
  const y = usage.yesterday;
  const yesterday =
    y && typeof y === "object" && typeof y.day === "string" && Array.isArray(y.top)
      ? {
          day: y.day,
          top: y.top
            .filter((x) => x && typeof x.name === "string" && Number.isFinite(Number(x.minutes)))
            .map((x) => ({ name: String(x.name), minutes: Number(x.minutes) })),
        }
      : null;

  return {
    day: typeof usage.day === "string" && usage.day ? usage.day : today,
    idleSkipMinutes: Number.isFinite(Number(config?.focusIdleSkipMinutes))
      ? Number(config?.focusIdleSkipMinutes)
      : IDLE_SKIP_DEFAULT,
    focusTop5,
    yesterday,
    lastNight,
    nagsLastNight: inWindowNags.length,
    nagTimes,
    weekHistory,
    updatedAt: typeof usage.updatedAt === "string" ? usage.updatedAt : null,
  };
}
