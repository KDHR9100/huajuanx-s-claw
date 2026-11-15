// ⌘K 命令面板纯逻辑：条目构建（页签/最近会话/动作）+ 子串过滤与组排序。
// 组件（CommandPalette.tsx）只管键盘、浮层与执行；这里的条目全是"真实存在"的入口：
// 页签来自 NAV_TABS 单一来源，动作只放真端点/真入口——
// 设计图里的「网关重启」没有真端点且属危险动作，不造假入口（重启请走 start-gateway.cmd）。
import { NAV_TABS, type AppView, type SessionRow } from "./types";

export type PaletteGroup = "pages" | "sessions" | "actions";

/** 动作白名单：每一个都对应真实存在的端点/入口（bridge-sync 与 sessions-cleanup、usage/rebuild 三个中间件都在 server/plugins/） */
export type PaletteActionId = "bridge-sync" | "sessions-cleanup" | "usage-rebuild";

export interface PaletteItem {
  /** 全局唯一 id：page:<view> / session:<key> / action:<id> */
  id: string;
  group: PaletteGroup;
  icon: string;
  label: string;
  /** 右侧灰字：会话相对时间 / 动作一句话说明 */
  hint?: string;
  /** 过滤用的额外关键词（不参与展示） */
  keywords?: string;
  /** pages：目标页签（执行时 store.setView） */
  view?: AppView;
  /** sessions：目标会话 key（执行时 store.setCurrentKey + setView("chat")） */
  sessionKey?: string;
  /** actions：动作 id（执行语义见 CommandPalette.tsx） */
  actionId?: PaletteActionId;
}

/** 命中组的排列顺序：页签 → 会话 → 动作 */
export const GROUP_ORDER: readonly PaletteGroup[] = ["pages", "sessions", "actions"];

/** 组标题（面板分组小字，设计图同款文案） */
export const GROUP_LABELS: Record<PaletteGroup, string> = {
  pages: "页签",
  sessions: "会话 · 最近",
  actions: "动作",
};

/** NAV_TABS label（如 "💬 会话"）拆成图标 + 文案，拆不出 emoji 就整个当文案 */
export function splitTabLabel(label: string): { icon: string; text: string } {
  const m = /^(\p{Extended_Pictographic}\uFE0F?)\s*(.*)$/u.exec(label);
  if (!m) return { icon: "", text: label };
  return { icon: m[1], text: m[2] };
}

/** 页签条目：来自 NAV_TABS 单一来源（TopNav 渲染同一份），全部页签都进面板 */
export function buildPageItems(): PaletteItem[] {
  return NAV_TABS.map((t) => {
    const { icon, text } = splitTabLabel(t.label);
    return {
      id: `page:${t.id}`,
      group: "pages" as const,
      icon,
      label: text,
      keywords: t.id, // 页签 id 也可作关键词（输 "usage"/"qq" 同样能命中）
      view: t.id,
    };
  });
}

/** 会话条目最多取最近几个（设计图「会话·最近」组） */
export const SESSION_ITEMS_MAX = 5;

/** 会话条目：按 updatedAt 取最近 5 个（缺失/0 视为最旧）；now 只为测试注入 */
export function buildSessionItems(sessions: SessionRow[], now: number = Date.now()): PaletteItem[] {
  const recent = [...sessions]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, SESSION_ITEMS_MAX);
  return recent.map((s) => ({
    id: `session:${s.key}`,
    group: "sessions" as const,
    icon: "●", // 设计图同款圆点，CSS 里点成主题绿
    label: s.title || s.key,
    hint: s.updatedAt ? relativeTime(s.updatedAt, now) : undefined,
    keywords: s.key,
    sessionKey: s.key,
  }));
}

/** 相对时间（设计图同款）：刚刚 / N 分钟前 / 昨天 HH:MM / N 小时前（同日）/ M月D日 HH:MM（更早） */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const base = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const dayKey = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const yesterday = new Date(base);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return `昨天 ${hm}`;
  if (dayKey(d) === dayKey(base)) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 动作条目：只放真实存在且安全的入口——
 *  - bridge-sync：POST /__rana/bridge-sync（Topbar 的 BridgeSyncButton 同款端点与轮询）
 *  - sessions-cleanup：打开全局 SystemCleanupModal（store.setCleanupOpen，与侧栏按钮同一个入口）
 *  - usage-rebuild：POST /__rana/usage/rebuild（用量页「重建账本」同端点）
 *  网关重启不在列：没有真端点、中断所有通道约 45 秒，不造假入口。
 */
export function buildActionItems(): PaletteItem[] {
  return [
    {
      id: "action:bridge-sync",
      group: "actions",
      icon: "🔄",
      label: "记忆同步",
      hint: "云端优先 · 跑完自动卸载",
      keywords: "记忆 同步 向量 bridge sync",
      actionId: "bridge-sync",
    },
    {
      id: "action:sessions-cleanup",
      group: "actions",
      icon: "🧹",
      label: "会话清理",
      hint: "清理定时任务残留会话",
      keywords: "会话 清理 cleanup 残留 定时任务",
      actionId: "sessions-cleanup",
    },
    {
      id: "action:usage-rebuild",
      group: "actions",
      icon: "📊",
      label: "用量重建",
      hint: "重建 token 用量账本",
      keywords: "用量 账本 重建 rebuild usage",
      actionId: "usage-rebuild",
    },
  ];
}

/** 全量条目：页签 + 最近会话 + 动作（面板空输入时的默认列表） */
export function buildPaletteItems(sessions: SessionRow[], now: number = Date.now()): PaletteItem[] {
  return [...buildPageItems(), ...buildSessionItems(sessions, now), ...buildActionItems()];
}

/** 过滤：query 对 label/keywords 做不区分大小写子串匹配；空输入=原样全量；
 *  输出按 pages→sessions→actions 分组排列（稳定排序，组内保持原有顺序）。 */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const hits = q
    ? items.filter(
        (it) => it.label.toLowerCase().includes(q) || (it.keywords ?? "").toLowerCase().includes(q),
      )
    : items;
  return [...hits].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}
