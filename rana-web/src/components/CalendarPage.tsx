// 全局日历页：面试/事务/Live·活动/游戏/截止六类日程一个地方看（工作包 B）。
// 数据分离：事件存 .life/events.json（/__rana/events 读写），课程是从 /__rana/study 拉来
// 当日镜像合并展示的（不双写——课表仍是学习域，管理去「📅 课表」页签）。
// 到点提醒走 studyNotify 引擎（App 根部挂着，事件按 remindMin 提前量弹通知）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJsonRetry } from "../lib/fetchRetry";
import { useAppStore } from "../store/useAppStore";

export type EventType = "interview" | "appointment" | "activity" | "game" | "deadline";

export interface CalEvent {
  id: string;
  title: string;
  type: EventType;
  date: string;
  timeStart?: string;
  timeEnd?: string;
  /** 提前多少分钟提醒（默认 30） */
  remindMin?: number;
  location?: string;
  note?: string;
  done?: boolean;
  createdAt: number;
}
interface EventsFile {
  version: number;
  events: CalEvent[];
  updatedAt: number;
}
interface CourseMirror {
  id: string;
  title: string;
  date: string;
  timeStart?: string;
  timeEnd?: string;
  status: "planned" | "done";
}

/** 类型 → 图标/标签/样式类（course 是镜像专用，不在事件类型里） */
export const EVENT_META: Record<EventType, { icon: string; label: string; cls: string }> = {
  interview: { icon: "🎯", label: "面试", cls: "ev-interview" },
  appointment: { icon: "📌", label: "事务", cls: "ev-appointment" },
  activity: { icon: "🎤", label: "Live/活动", cls: "ev-activity" },
  game: { icon: "🎮", label: "游戏", cls: "ev-game" },
  deadline: { icon: "⏰", label: "截止", cls: "ev-deadline" },
};
const COURSE_META = { icon: "📖", label: "课程", cls: "ev-course" };

/** 统一条目：日历格子和当日详情都用这个渲染 */
interface DayItem {
  key: string;
  kind: "event" | "course";
  icon: string;
  cls: string;
  typeLabel: string;
  title: string;
  date: string;
  timeStart?: string;
  timeEnd?: string;
  done: boolean;
  location?: string;
  note?: string;
  remindMin?: number;
  /** 事件条目的原始数据（课程镜像没有），完成/删除直接用它 */
  raw?: CalEvent;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const dateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const addDays = (ds: string, n: number) => {
  const [y, m, d] = ds.split("-").map(Number);
  return dateStr(new Date(y, m - 1, d + n));
};
const hmToMin = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};
function monthCells(y: number, m: number): Array<{ date: string; inMonth: boolean }> {
  const first = new Date(y, m - 1, 1);
  const start = addDays(dateStr(first), -((first.getDay() + 6) % 7)); // 周一开头
  const out: Array<{ date: string; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    out.push({ date: d, inMonth: Number(d.slice(5, 7)) === m });
  }
  return out;
}
function weekCells(ds: string): Array<{ date: string; inMonth: boolean }> {
  const start = addDays(ds, -((new Date(ds + "T00:00:00").getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => ({ date: addDays(start, i), inMonth: true }));
}

/** 同日、双方都有完整时段、区间相交 → 两条都算撞了（⚠ 标注，不做调度） */
function findConflicts(items: DayItem[]): Set<string> {
  const hit = new Set<string>();
  const withRange = items.filter((it) => it.timeStart && it.timeEnd);
  for (let i = 0; i < withRange.length; i++) {
    for (let j = i + 1; j < withRange.length; j++) {
      const a = withRange[i];
      const b = withRange[j];
      if (a.timeStart! < b.timeEnd! && b.timeStart! < a.timeEnd!) {
        hit.add(a.key);
        hit.add(b.key);
      }
    }
  }
  return hit;
}

const fmtRange = (it: DayItem) =>
  it.timeStart ? `${it.timeStart}${it.timeEnd ? `~${it.timeEnd}` : ""}` : "";

export default function CalendarPage() {
  const setPlanningTab = useAppStore((s) => s.setPlanningTab);

  const [events, setEvents] = useState<CalEvent[]>([]);
  const [courses, setCourses] = useState<CourseMirror[]>([]);
  const [error, setError] = useState("");

  const [cursor, setCursor] = useState(() => {
    const t = todayStr();
    return { y: Number(t.slice(0, 4)), m: Number(t.slice(5, 7)) };
  });
  const [selDate, setSelDate] = useState(todayStr());
  const [calMode, setCalMode] = useState<"month" | "week">(() =>
    localStorage.getItem("cal.view.v1") === "week" ? "week" : "month",
  );

  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const emptyForm = () => ({
    title: "",
    type: "interview" as EventType,
    date: selDate,
    timeStart: "",
    timeEnd: "",
    remindMin: "30",
    location: "",
    note: "",
  });
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(async () => {
    try {
      const [ev, st] = await Promise.all([
        fetchJsonRetry<EventsFile>("/__rana/events"),
        fetchJsonRetry<{ courses?: CourseMirror[] }>("/__rana/study"),
      ]);
      setEvents(Array.isArray(ev.events) ? ev.events : []);
      setCourses(Array.isArray(st.courses) ? st.courses : []);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setMode = (m: "month" | "week") => {
    setCalMode(m);
    try {
      localStorage.setItem("cal.view.v1", m);
    } catch {
      /* 存不进去就算了 */
    }
  };

  /** 全部条目（事件 + 课程镜像）拼成统一 DayItem，供格子/详情/冲突检测共用 */
  const allItems: DayItem[] = useMemo(() => {
    const fromEvents: DayItem[] = events.map((e) => {
      const meta = EVENT_META[e.type] ?? EVENT_META.appointment;
      return {
        key: `e:${e.id}`,
        kind: "event",
        icon: meta.icon,
        cls: meta.cls,
        typeLabel: meta.label,
        title: e.title,
        date: e.date,
        timeStart: e.timeStart,
        timeEnd: e.timeEnd,
        done: Boolean(e.done),
        location: e.location,
        note: e.note,
        remindMin: e.remindMin,
        raw: e,
      };
    });
    const fromCourses: DayItem[] = courses.map((c) => ({
      key: `c:${c.id}`,
      kind: "course",
      icon: COURSE_META.icon,
      cls: COURSE_META.cls,
      typeLabel: COURSE_META.label,
      title: c.title,
      date: c.date,
      timeStart: c.timeStart,
      timeEnd: c.timeEnd,
      done: c.status === "done",
    }));
    return [...fromEvents, ...fromCourses];
  }, [events, courses]);

  const byDate = useMemo(() => {
    const m = new Map<string, DayItem[]>();
    for (const it of allItems) {
      if (!m.has(it.date)) m.set(it.date, []);
      m.get(it.date)!.push(it);
    }
    for (const [, list] of m) {
      list.sort((a, b) => hmToMin(a.timeStart ?? "24:00") - hmToMin(b.timeStart ?? "24:00"));
    }
    return m;
  }, [allItems]);

  const conflicts = useMemo(() => {
    const set = new Set<string>();
    for (const [, list] of byDate) {
      for (const k of findConflicts(list)) set.add(k);
    }
    return set;
  }, [byDate]);

  const t = todayStr();
  const selItems = byDate.get(selDate) ?? [];
  const monthLabel = `${cursor.y}年${cursor.m}月`;

  const shiftCal = (delta: number) => {
    if (calMode === "month") {
      setCursor((c) => {
        const d = new Date(c.y, c.m - 1 + delta, 1);
        return { y: d.getFullYear(), m: d.getMonth() + 1 };
      });
    } else {
      setSelDate((d) => addDays(d, delta * 7));
    }
  };

  const addEvent = async () => {
    if (saving || !form.title.trim()) return;
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/__rana/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          type: form.type,
          date: form.date,
          timeStart: form.timeStart || undefined,
          timeEnd: form.timeEnd || undefined,
          remindMin: form.remindMin || undefined,
          location: form.location || undefined,
          note: form.note || undefined,
        }),
      });
      const j = (await r.json()) as { ok?: boolean; events?: CalEvent[]; error?: string };
      if (!r.ok || !j.ok || !j.events) throw new Error(j.error ?? `HTTP ${r.status}`);
      setEvents(j.events);
      setSelDate(form.date);
      setForm(emptyForm());
      setAddOpen(false);
    } catch (e) {
      setError(`没记上：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleDone = async (ev: CalEvent) => {
    try {
      const r = await fetch("/__rana/events/done", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ev.id, done: !ev.done }),
      });
      const j = (await r.json()) as { ok?: boolean; events?: CalEvent[]; error?: string };
      if (!r.ok || !j.ok || !j.events) throw new Error(j.error ?? `HTTP ${r.status}`);
      setEvents(j.events);
    } catch (e) {
      setError(`操作失败：${(e as Error).message}`);
    }
  };

  const delEvent = async (ev: CalEvent) => {
    if (!window.confirm(`删掉「${ev.title.slice(0, 24)}」？`)) return;
    try {
      const r = await fetch(`/__rana/events?id=${encodeURIComponent(ev.id)}`, { method: "DELETE" });
      const j = (await r.json()) as { ok?: boolean; events?: CalEvent[]; error?: string };
      if (!r.ok || !j.ok || !j.events) throw new Error(j.error ?? `HTTP ${r.status}`);
      setEvents(j.events);
    } catch (e) {
      setError(`删除失败：${(e as Error).message}`);
    }
  };

  /** 日历格子渲染：月视图每格最多 3 条，周视图整列放开 */
  const renderCalCell = (cell: { date: string; inMonth: boolean }, showAll: boolean) => {
    const items = byDate.get(cell.date) ?? [];
    const show = showAll ? items : items.slice(0, 3);
    const cellConflict = items.some((it) => conflicts.has(it.key));
    return (
      <button
        key={cell.date}
        type="button"
        className={[
          "cal-cell",
          cell.inMonth ? "" : "other",
          cell.date === t ? "today" : "",
          cell.date === selDate ? "sel" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => setSelDate(cell.date)}
      >
        <span className="cd">
          {Number(cell.date.slice(8))}
          {cellConflict && (
            <i className="late-dot" title="这天有时段重叠的事件" />
          )}
        </span>
        {show.map((it) => (
          <span
            key={it.key}
            className={`cal-course ${it.cls}${it.done ? " done" : ""}`}
            title={`${it.typeLabel} · ${it.title}${conflicts.has(it.key) ? "（⚠ 时段重叠）" : ""}`}
          >
            {conflicts.has(it.key) ? "⚠" : it.icon} {it.title}
          </span>
        ))}
        {!showAll && items.length > 3 && <span className="cal-more">+{items.length - 3}</span>}
      </button>
    );
  };

  const weekCellsNow = weekCells(selDate);

  return (
    <>
      <div className="page-intro">
        <h2>日历</h2>
        <p>
          面试 / 事务 / Live·活动 / 游戏 / 截止 都记这里 · 课程自动带过来 · 重叠标 ⚠ ·
          到点前弹提醒（浏览器通知，开关在「📅 课表」页）
          {error && (
            <span className="sys-err" style={{ cursor: "pointer" }} onClick={() => void load()} title="点一下重试">
              （{error} · 点击重试）
            </span>
          )}
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="cal-bar" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <button className="btn ghost sm" onClick={() => shiftCal(-1)}>
            ‹
          </button>
          <strong style={{ minWidth: 110 }}>
            {calMode === "month" ? monthLabel : `${weekCellsNow[0].date} ～ ${weekCellsNow[6].date}`}
          </strong>
          <button className="btn ghost sm" onClick={() => shiftCal(1)}>
            ›
          </button>
          <button
            className="btn ghost sm"
            onClick={() => {
              const n = todayStr();
              setSelDate(n);
              setCursor({ y: Number(n.slice(0, 4)), m: Number(n.slice(5, 7)) });
            }}
          >
            {calMode === "month" ? "今天" : "本周"}
          </button>
          <button className="btn ghost sm" onClick={() => setMode(calMode === "month" ? "week" : "month")}>
            {calMode === "month" ? "📆 周视图" : "🗓 月视图"}
          </button>
          <span style={{ flex: 1 }} />
          <button
            className="btn sm"
            onClick={() => {
              if (!addOpen) setForm((f) => ({ ...f, date: selDate }));
              setAddOpen((v) => !v);
            }}
          >
            {addOpen ? "收起" : "＋ 记一件事"}
          </button>
        </div>

        {addOpen && (
          <div className="card ev-form" style={{ marginBottom: 10, padding: 12 }}>
            <div className="pg-new">
              <input
                className="set-input"
                placeholder="标题，比如：xx公司一面 / 明日方舟新赛季"
                value={form.title}
                maxLength={80}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
              <select
                className="set-input"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as EventType })}
              >
                {Object.entries(EVENT_META).map(([k, m]) => (
                  <option key={k} value={k}>
                    {m.icon} {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="pg-new">
              <input
                className="set-input"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
              <input
                className="set-input"
                type="time"
                value={form.timeStart}
                onChange={(e) => setForm({ ...form, timeStart: e.target.value })}
              />
              <span className="tune-hint">到</span>
              <input
                className="set-input"
                type="time"
                value={form.timeEnd}
                onChange={(e) => setForm({ ...form, timeEnd: e.target.value })}
              />
              <input
                className="set-input"
                type="number"
                min={0}
                max={1440}
                value={form.remindMin}
                onChange={(e) => setForm({ ...form, remindMin: e.target.value })}
                title="提前多少分钟提醒"
              />
              <span className="tune-hint">分钟前提醒</span>
            </div>
            <div className="pg-new">
              <input
                className="set-input"
                placeholder="地点 / 链接（可选）"
                value={form.location}
                maxLength={200}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
              />
            </div>
            <textarea
              className="set-input goal-textarea"
              placeholder="备注（可选）"
              value={form.note}
              maxLength={500}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
            <div className="cc-acts">
              <button className="btn sm" onClick={() => void addEvent()} disabled={saving || !form.title.trim()}>
                {saving ? "记着…" : "记上"}
              </button>
              <span className="tune-hint">不填时段也行（只按日期记）；提醒只在填了开始时间时才弹</span>
            </div>
          </div>
        )}

        <div className="cal-week" style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 4 }}>
          {["一", "二", "三", "四", "五", "六", "日"].map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className={`cal-grid${calMode === "week" ? " wk" : ""}`}>
          {(calMode === "month" ? monthCells(cursor.y, cursor.m) : weekCellsNow).map((cell) =>
            renderCalCell(cell, calMode === "week"),
          )}
        </div>
      </div>

      {/* 当日详情：选中日的全部条目（事件 + 课程镜像），按时间排序 */}
      <div className="card">
        <h3>
          <span className="ic">📋</span> {selDate === t ? "今天" : selDate}
          <small>{selItems.length} 条</small>
        </h3>
        {selItems.length ? (
          selItems.map((it) => (
            <div key={it.key} className="plan-focus-row" style={{ gap: 8 }}>
              <span className={`cal-course ${it.cls}`} style={{ flex: "none" }}>
                {it.icon} {it.typeLabel}
              </span>
              <span className="chip" style={{ flex: "none" }}>
                {fmtRange(it) || "—"}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {it.done ? "✅ " : ""}
                {it.title}
                {conflicts.has(it.key) && (
                  <span style={{ color: "var(--danger)" }}> ⚠ 时段重叠</span>
                )}
                {it.location && <span className="tune-hint"> · {it.location}</span>}
                {it.note && <span className="tune-hint"> · {it.note}</span>}
              </span>
              {it.kind === "event" && it.raw ? (
                <>
                  <button className="btn ghost sm" onClick={() => void toggleDone(it.raw!)} title="完成/重开">
                    {it.done ? "↩" : "✓"}
                  </button>
                  <button className="btn ghost sm" onClick={() => void delEvent(it.raw!)} title="删除">
                    🗑
                  </button>
                </>
              ) : (
                <button className="btn ghost sm" onClick={() => setPlanningTab("schedule")} title="课程管理去课表页">
                  去课表 →
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="pending-text" style={{ margin: 0 }}>
            这天没有任何日程。点上面的「＋ 记一件事」。
          </p>
        )}
      </div>
    </>
  );
}
