// 记忆时间线纯函数（2026-11-15 时间线卡）：把三类记忆事件——复盘日记 / 人物图谱 / 记忆文件改动——
// 聚合成一条按时间倒序的流（cap 50），外加按天分组的展示辅助。
// 纪律：零依赖叶模块（不 import node 内置），前端可安全复用；输入是插件侧收集好的原始条目列表，
// 缺哪类源就少哪类，绝不编造条目。
// 真实数据语义（对拍过 server/plugins/memory.ts 与 person-graph-parse.ts）：
// - 复盘日记：workspace-rana-rp/memory/diary/*.md，标题取首个 # 行，key=diary:<文件名>（在记忆白名单内可展开）
// - 人物图谱：workspace-main/personal/graph.md 一份文件装三张表（人物节点/事节点/连线），
//   事件表没有 ts 字段 -> 整份文件用 mtime 作时间戳；graph.md 不在记忆白名单 -> 无 key，只读展示
// - 记忆文件：memory.ts 白名单各组全部文件的 mtime，title=key（指回 /__rana/memory/read）

export type TimelineSource = "diary" | "graph" | "memory";

export interface TimelineItem {
  /** 毫秒时间戳 */
  ts: number;
  source: TimelineSource;
  title: string;
  /** 记忆白名单 key（/__rana/memory/read 可取原文）；graph 条目没有 -> 只读展示 */
  key?: string;
  /** 一行摘要（日记取正文首行；其余源可空） */
  excerpt?: string;
}

export interface TimelineDayGroup {
  /** "YYYY-MM-DD"（本地钟） */
  day: string;
  /** 今天 / 昨天 / MM-DD */
  label: string;
  items: TimelineItem[];
}

const DEFAULT_CAP = 50;
const EXCERPT_MAX = 80;

function isValidSource(s: unknown): s is TimelineSource {
  return s === "diary" || s === "graph" || s === "memory";
}

/** 一行摘要截断（省略号收尾） */
export function truncateLine(s: string, max = EXCERPT_MAX): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 聚合入口：三类原始条目列表（哪类没有传 null/空数组都行），按 ts 降序、截断 cap 条。
 * 非法条目（ts 非法 / 标题空白 / 来源未知）静默剔除，永不 throw。
 * 同 ts 保持传入顺序（稳定排序：diary -> graph -> memory）。
 */
export function buildTimeline(
  raw: { diary?: TimelineItem[] | null; graph?: TimelineItem[] | null; memory?: TimelineItem[] | null },
  cap = DEFAULT_CAP,
): TimelineItem[] {
  const all = [...(raw.diary ?? []), ...(raw.graph ?? []), ...(raw.memory ?? [])];
  const valid = all.filter(
    (it) =>
      it &&
      typeof it === "object" &&
      Number.isFinite(it.ts) &&
      it.ts > 0 &&
      isValidSource(it.source) &&
      typeof it.title === "string" &&
      it.title.trim() !== "",
  );
  valid.sort((a, b) => b.ts - a.ts);
  return valid.slice(0, Math.max(0, cap));
}

/** 本地 "YYYY-MM-DD"（与 server 侧 dateKey 语义一致） */
function dateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 按天分组（时间线卡的日期头）：组按天降序；label 今天/昨天/MM-DD。
 * 输入假定已是 ts 降序（buildTimeline 的输出），组内顺序原样保留；ts 非法的条目跳过。
 */
export function groupTimelineByDay(items: TimelineItem[], now: Date): TimelineDayGroup[] {
  const todayKey = dateKey(now);
  const yKey = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const map = new Map<string, TimelineItem[]>();
  for (const it of items) {
    if (!it || !Number.isFinite(it.ts) || it.ts <= 0) continue;
    const k = dateKey(new Date(it.ts));
    const bucket = map.get(k);
    if (bucket) bucket.push(it);
    else map.set(k, [it]);
  }
  return [...map.keys()]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((day) => ({
      day,
      label: day === todayKey ? "今天" : day === yKey ? "昨天" : `${day.slice(5, 7)}-${day.slice(8, 10)}`,
      items: map.get(day) ?? [],
    }));
}

/**
 * 复盘日记条目：标题=文件内首个 "# " 行（没有就退回文件名），前缀「复盘日记：」；
 * 摘要=首个非标题非空行截断。mtime 非法（读不到文件）返回 null。
 */
export function diaryTimelineItem(key: string, name: string, mtime: number, content: string): TimelineItem | null {
  if (!Number.isFinite(mtime) || mtime <= 0) return null;
  const text = String(content ?? "");
  const heading = /^#\s+(.+)$/m.exec(text);
  const head = heading ? heading[1].trim() : "";
  let excerpt = "";
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    excerpt = truncateLine(t);
    break;
  }
  return { ts: mtime, source: "diary", title: `复盘日记：${head || name}`, key, excerpt };
}

/**
 * 人物图谱条目：graph.md 一份文件 = 三张表，事件表没有 ts -> 整份用 mtime。
 * 标题贴真实字段（表行数计数）；摘要带「最后核对」日期（有才给）。
 */
export function graphTimelineItem(
  mtime: number,
  parsed: { people?: unknown[]; events?: unknown[]; links?: unknown[]; lastChecked?: string | null },
): TimelineItem | null {
  if (!Number.isFinite(mtime) || mtime <= 0) return null;
  const nPeople = Array.isArray(parsed?.people) ? parsed.people.length : 0;
  const nEvents = Array.isArray(parsed?.events) ? parsed.events.length : 0;
  const nLinks = Array.isArray(parsed?.links) ? parsed.links.length : 0;
  const checked = typeof parsed?.lastChecked === "string" && parsed.lastChecked ? ` · 最后核对 ${parsed.lastChecked}` : "";
  return {
    ts: mtime,
    source: "graph",
    title: `人物图谱更新：人物 ${nPeople} · 事件 ${nEvents} · 连线 ${nLinks}${checked}`,
    excerpt: "",
  };
}
