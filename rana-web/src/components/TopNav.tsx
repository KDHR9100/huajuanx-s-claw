// 顶部导航：品牌（铃铛+Rana+异色瞳双色点）、页面页签（可按住左右拖动换位，顺序记在本地）、
// 连接状态、设置、昼夜切换。
// 拖拽：pointer 事件自写——跟手横移，中心点越过相邻页签中点即换位（其余页签 FLIP 动画让位，
// 拖拽中的页签以「新槽位与当前视觉位置之差」重定基准，始终贴着指针走）；松手弹回槽位并持久化。
// 位移 <4px 视为点击切页；键盘 Enter 走 onClick 兜底。
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import type { AppView } from "../lib/types";
import { Bell } from "./RanaArt";

const TABS: Array<{ id: AppView; label: string }> = [
  { id: "chat", label: "💬 会话" },
  { id: "sys", label: "💠 Rana 的状态" },
  { id: "cron", label: "⏰ 定时任务" },
  { id: "news", label: "📰 早报" },
  { id: "study", label: "📚 学习计划" },
  { id: "apps", label: "🧰 程序" },
];

const CLICK_SLOP = 4; // 位移小于此值视为点击而非拖拽
const FLIP_MS = 230;

export default function TopNav() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const conn = useAppStore((s) => s.conn);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const tabOrder = useAppStore((s) => s.tabOrder);
  const setTabOrder = useAppStore((s) => s.setTabOrder);

  const ordered = useMemo(
    () => tabOrder.map((id) => TABS.find((t) => t.id === id)).filter((t): t is { id: AppView; label: string } => Boolean(t)),
    [tabOrder],
  );

  // ---- 拖拽换位 ----
  const tabRefs = useRef(new Map<AppView, HTMLButtonElement | null>());
  const prevRects = useRef(new Map<AppView, { left: number }>());
  const drag = useRef<{ id: AppView; startX: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [dragId, setDragId] = useState<AppView | null>(null);
  const [dragDx, setDragDx] = useState(0);
  const reducedMotion = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);

  // FLIP：顺序变化后，未拖拽的页签从旧位置滑到新位置
  useLayoutEffect(() => {
    for (const [id, el] of tabRefs.current) {
      if (!el) continue;
      const left = el.getBoundingClientRect().left;
      const prev = prevRects.current.get(id);
      if (prev && Math.abs(prev.left - left) > 1 && id !== dragId && !reducedMotion) {
        el.animate([{ transform: `translateX(${prev.left - left}px)` }, { transform: "translateX(0)" }], {
          duration: FLIP_MS,
          easing: "cubic-bezier(.2,.85,.25,1.15)",
        });
      }
      prevRects.current.set(id, { left });
    }
  }, [tabOrder, dragId, reducedMotion]);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: AppView) => {
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 合成事件/浏览器不支持时没有指针捕获，move/up 事件照收（handler 挂在按钮上）
    }
    drag.current = { id, startX: e.clientX, moved: false };
    setDragId(id);
    setDragDx(0);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const el = tabRefs.current.get(d.id);
    if (!el) return;

    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < CLICK_SLOP) return;
    d.moved = true;
    setDragDx(dx);

    // 拖拽页签（含 transform）的当前视觉中心
    const rect = el.getBoundingClientRect();
    const center = rect.left + rect.width / 2;

    const idx = tabOrder.indexOf(d.id);
    const dir = dx > 0 ? 1 : -1;
    const nIdx = idx + dir;
    const neighbor = nIdx >= 0 && nIdx < tabOrder.length ? tabOrder[nIdx] : null;
    const nEl = neighbor ? tabRefs.current.get(neighbor) : null;
    if (!neighbor || !nEl) return;
    const nRect = nEl.getBoundingClientRect(); // 邻居没在拖，rect 即布局位置
    const nCenter = nRect.left + nRect.width / 2;

    if ((dir > 0 && center > nCenter) || (dir < 0 && center < nCenter)) {
      const next = tabOrder.slice();
      next[idx] = neighbor;
      next[nIdx] = d.id;
      setTabOrder(next);
      // 换位后新布局位置 ≈ 邻居旧槽位：把拖拽基准挪过去，页签继续贴着指针
      const dxNew = rect.left - nRect.left;
      drag.current = { id: d.id, startX: e.clientX - dxNew, moved: true };
      setDragDx(dxNew);
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    const wasMoved = d.moved;
    drag.current = null;
    setDragId(null);
    setDragDx(0); // 松手：transform 清零 = 弹回自己的槽位（CSS transition 做回弹）
    if (wasMoved) {
      suppressClick.current = true; // 拖拽结束会紧跟一次 click，吞掉
    } else {
      setView(d.id);
    }
  };

  const dot = conn === "connected" ? "ok" : conn === "connecting" ? "wait" : "err";

  return (
    <header className="topnav">
      <div className="brand" title="Rana · 要乐奈">
        <span className="brand-bell">
          <Bell size={24} />
        </span>
        Rana
        <span className="twin" title="异色瞳：左蓝右黄">
          <i />
          <i />
        </span>
      </div>
      <nav className="tabs" title="页签可以按住左右拖动换位置">
        {ordered.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current.set(t.id, el);
            }}
            className={`tab${view === t.id ? " on" : ""}${dragId === t.id ? " dragging" : ""}`}
            style={dragId === t.id ? { transform: `translateX(${dragDx}px)` } : undefined}
            onPointerDown={(e) => onPointerDown(e, t.id)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              setView(t.id); // 键盘 Enter 的兜底路径（鼠标点击在 pointerup 已处理）
            }}
          >
            {t.label}
          </button>
        ))}
        <button className="tab plus" disabled title="以后再加点什么…">
          ✚
        </button>
      </nav>
      <div className="nav-right">
        <span className={`conn-dot ${dot}`} title={`gateway ${conn}`} />
        <button className="nav-btn" title="外观设置" onClick={() => setSettingsOpen(true)}>
          🎨
        </button>
        <button
          className="nav-btn"
          title={settings.mode === "dark" ? "切到白天" : "切到夜间"}
          onClick={() => updateSettings({ mode: settings.mode === "dark" ? "light" : "dark" })}
        >
          {settings.mode === "dark" ? "☀️" : "🌙"}
        </button>
      </div>
    </header>
  );
}
