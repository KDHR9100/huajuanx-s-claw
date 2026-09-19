// 规划总览：整条规划链的最上层——人生目标 →（她拆解）→ 每月里程碑 →（一键转待办）→ 待办 → 课表。
// 数据：/__rana/life（life.json）+ /__rana/study（课程表，只读做统计）+ /__rana/study/goals（待办，只读计数）
// + /__rana/events（全局日历事件，今日卡与课程混排展示）。
// 拆解走 /__rana/life/goals/parse（life-planning skill 只出方案）；转待办/里程碑状态走 /__rana/life/milestones/*。
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { EVENT_META, type CalEvent } from "./CalendarPage";

export interface LifeMilestone {
  id: string;
  month: string; // YYYY-MM
  title: string;
  detail?: string;
  status: "planned" | "done";
  createdAt: number;
  todoGoalId?: string;
}
export interface LifeGoal {
  id: string;
  title: string;
  why?: string;
  horizon?: string;
  status: "active" | "done" | "archived";
  milestones: LifeMilestone[];
  analysis?: string;
  summary?: string;
  parsedAt?: number;
  createdAt: number;
  updatedAt?: number;
}
interface LifeFile {
  version: number;
  goals: LifeGoal[];
  updatedAt: number;
}
interface CourseLite {
  id: string;
  title: string;
  date: string;
  timeStart?: string;
  timeEnd?: string;
  status: "planned" | "done";
}
interface ScheduleLite {
  courses?: CourseLite[];
  streak?: { days: number; best: number };
}
interface GoalLite {
  id: string;
  text: string;
  status: string;
  lifeGoalId?: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const dateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const curMonth = () => todayStr().slice(0, 7);
const monthLabel = (m: string) => `${m.slice(0, 4)}年${Number(m.slice(5, 7))}月`;
const fmtTs = (ts: number) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};
/** 今天还没到的时刻 → 「还有 X 小时Y分」倒计时文案；已过/非今天返回空 */
const countdownLabel = (date: string, time?: string): string => {
  if (!time || date !== todayStr()) return "";
  const [h, m] = time.split(":").map(Number);
  const target = new Date();
  target.setHours(h, m, 0, 0);
  const diffMin = Math.round((target.getTime() - Date.now()) / 60000);
  if (diffMin <= 0) return "";
  if (diffMin < 60) return `还有 ${diffMin} 分`;
  const hh = Math.floor(diffMin / 60);
  const mm = diffMin % 60;
  return mm ? `还有 ${hh} 时 ${mm} 分` : `还有 ${hh} 小时`;
};
const addDaysStr = (ds: string, n: number) => {
  const [y, m, d] = ds.split("-").map(Number);
  return dateStr(new Date(y, m - 1, d + n));
};
/** 距某天还有几个整天（1=明天） */
const daysUntil = (ds: string) =>
  Math.round((new Date(ds + "T00:00:00").getTime() - new Date(todayStr() + "T00:00:00").getTime()) / 86400000);
/** 拆解用的模型：规划页自己的偏好（与内容库共用，""=跟随专用会话当前模型） */
const modelPref = () => {
  const v = localStorage.getItem("life.model.v1");
  return v ? v : undefined;
};

/** active 在前（新的在前），done/archived 沉底 */
const sortGoals = (a: LifeGoal, b: LifeGoal) => {
  if (a.status === "active" && b.status !== "active") return -1;
  if (a.status !== "active" && b.status === "active") return 1;
  return b.createdAt - a.createdAt;
};

const GOAL_STATUS: Record<LifeGoal["status"], { chip: string; label: string }> = {
  active: { chip: "", label: "🎯 进行中" },
  done: { chip: " green", label: "✅ 已达成" },
  archived: { chip: "", label: "📦 已归档" },
};

export default function PlanningOverview() {
  const setPlanningTab = useAppStore((s) => s.setPlanningTab);

  const [life, setLife] = useState<LifeFile | null>(null);
  const [courses, setCourses] = useState<CourseLite[]>([]);
  const [todos, setTodos] = useState<GoalLite[]>([]);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  const [horizon, setHorizon] = useState("");
  const [adding, setAdding] = useState(false);
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [busyMsId, setBusyMsId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rLife, rStudy, rGoals, rEvents] = await Promise.all([
        fetch("/__rana/life"),
        fetch("/__rana/study"),
        fetch("/__rana/study/goals"),
        fetch("/__rana/events"),
      ]);
      if (!rLife.ok) throw new Error(`life HTTP ${rLife.status}`);
      const jLife = (await rLife.json()) as LifeFile;
      setLife(jLife);
      if (rStudy.ok) {
        const jStudy = (await rStudy.json()) as ScheduleLite;
        setCourses(Array.isArray(jStudy.courses) ? jStudy.courses : []);
      }
      if (rGoals.ok) {
        const jGoals = (await rGoals.json()) as { goals?: GoalLite[] };
        setTodos(Array.isArray(jGoals.goals) ? jGoals.goals : []);
      }
      if (rEvents.ok) {
        const jEvents = (await rEvents.json()) as { events?: CalEvent[] };
        setEvents(Array.isArray(jEvents.events) ? jEvents.events : []);
      }
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyLife = (next: LifeFile) => setLife({ ...next, goals: [...next.goals].sort(sortGoals) });

  const add = async () => {
    if (adding) return;
    setAdding(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/__rana/life/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, why, horizon }),
      });
      const j = (await r.json()) as { ok?: boolean; life?: LifeFile; error?: string };
      if (!r.ok || !j.ok || !j.life) throw new Error(j.error ?? `HTTP ${r.status}`);
      applyLife(j.life);
      setTitle("");
      setWhy("");
      setHorizon("");
    } catch (e) {
      setError(`没记上：${(e as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  const parse = async (goal: LifeGoal) => {
    if (parsingId) return;
    setParsingId(goal.id);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/__rana/life/goals/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goalId: goal.id, model: modelPref() }),
      });
      const j = (await r.json()) as { ok?: boolean; life?: LifeFile; error?: string };
      if (!r.ok || !j.ok || !j.life) throw new Error(j.error ?? `HTTP ${r.status}`);
      applyLife(j.life);
    } catch (e) {
      setError(`拆解失败：${(e as Error).message}`);
    } finally {
      setParsingId(null);
    }
  };

  const delGoal = async (goal: LifeGoal) => {
    const msg = goal.milestones.length
      ? `删掉目标「${goal.title.slice(0, 20)}」？已经转出去的待办和课程不受影响。`
      : `删掉目标「${goal.title.slice(0, 20)}」？`;
    if (!window.confirm(msg)) return;
    try {
      const r = await fetch(`/__rana/life/goals?id=${encodeURIComponent(goal.id)}`, { method: "DELETE" });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setLife((l) => (l ? { ...l, goals: l.goals.filter((g) => g.id !== goal.id) } : l));
    } catch (e) {
      setError(`删除失败：${(e as Error).message}`);
    }
  };

  const setGoalStatus = async (goal: LifeGoal, status: LifeGoal["status"]) => {
    try {
      const r = await fetch("/__rana/life/goals/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goalId: goal.id, status }),
      });
      const j = (await r.json()) as { ok?: boolean; life?: LifeFile; error?: string };
      if (!r.ok || !j.ok || !j.life) throw new Error(j.error ?? `HTTP ${r.status}`);
      applyLife(j.life);
    } catch (e) {
      setError(`操作失败：${(e as Error).message}`);
    }
  };

  const msToTodo = async (goal: LifeGoal, ms: LifeMilestone) => {
    if (busyMsId) return;
    setBusyMsId(ms.id);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/__rana/life/milestones/todo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goalId: goal.id, milestoneId: ms.id }),
      });
      const j = (await r.json()) as { ok?: boolean; life?: LifeFile; error?: string };
      if (!r.ok || !j.ok || !j.life) throw new Error(j.error ?? `HTTP ${r.status}`);
      applyLife(j.life);
      setNotice(`已转成待办「${ms.title.slice(0, 18)}」，去「📝 待办」让她拆成课`);
    } catch (e) {
      setError(`转待办失败：${(e as Error).message}`);
    } finally {
      setBusyMsId(null);
    }
  };

  const setMsStatus = async (goal: LifeGoal, ms: LifeMilestone, status: LifeMilestone["status"]) => {
    if (busyMsId) return;
    setBusyMsId(ms.id);
    setError("");
    try {
      const r = await fetch("/__rana/life/milestones/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goalId: goal.id, milestoneId: ms.id, status }),
      });
      const j = (await r.json()) as { ok?: boolean; life?: LifeFile; error?: string };
      if (!r.ok || !j.ok || !j.life) throw new Error(j.error ?? `HTTP ${r.status}`);
      applyLife(j.life);
    } catch (e) {
      setError(`操作失败：${(e as Error).message}`);
    } finally {
      setBusyMsId(null);
    }
  };

  const goals = [...(life?.goals ?? [])].sort(sortGoals);
  const t = todayStr();
  const cm = curMonth();

  // 本月聚焦的数据
  const monthMilestones = goals.flatMap((g) =>
    g.milestones.filter((m) => m.month === cm).map((m) => ({ goal: g, ms: m })),
  );
  const monthCourses = courses.filter((c) => c.date.startsWith(cm));
  const monthDone = monthCourses.filter((c) => c.status === "done").length;

  // 今日的数据：课程 + 日历事件混成一条时间线（没时段的沉底）
  const todayCourses = courses
    .filter((c) => c.date === t)
    .map((c) => ({
      key: `c:${c.id}`,
      icon: "📖",
      cls: "ev-course",
      label: "课程",
      time: c.timeStart ?? "",
      title: c.title,
      done: c.status === "done",
      location: "",
    }));
  const todayEvents = events
    .filter((e) => e.date === t)
    .map((e) => {
      const meta = EVENT_META[e.type] ?? EVENT_META.appointment;
      return {
        key: `e:${e.id}`,
        icon: meta.icon,
        cls: meta.cls,
        label: meta.label,
        time: e.timeStart ?? "",
        title: e.title,
        done: Boolean(e.done),
        location: e.location ?? "",
      };
    });
  const todayAll = [...todayCourses, ...todayEvents].sort((a, b) => {
    if (a.time && b.time) return a.time.localeCompare(b.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return a.title.localeCompare(b.title);
  });
  const overdue = courses.filter((c) => c.status === "planned" && c.date < t);
  const openTodos = todos.filter((g) => g.status === "open");

  // 接下来 14 天内的活动/游戏/面试（今日卡的远期倒计时，Live/漫展/开活动前心里有数）
  const upcoming = events
    .filter((e) => !e.done && e.date > t && e.date <= addDaysStr(t, 14))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.timeStart ?? "99:99").localeCompare(b.timeStart ?? "99:99"))
    .slice(0, 3);

  return (
    <>
      {notice && (
        <div className="set-ok" style={{ marginBottom: 14 }}>
          {notice}{" "}
          <button className="btn ghost sm" onClick={() => setPlanningTab("goals")}>
            去待办 →
          </button>
        </div>
      )}

      {/* 写下人生目标 */}
      <div className="card goal-input" style={{ marginBottom: 16 }}>
        <div className="pg-new">
          <input
            className="set-input"
            placeholder="人生目标，比如：三年内转行做 AI 应用工程师"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            className="set-input"
            placeholder="时间跨度（可选），比如：3年 / 2027年底"
            value={horizon}
            maxLength={40}
            onChange={(e) => setHorizon(e.target.value)}
          />
        </div>
        <textarea
          className="set-input goal-textarea"
          placeholder="为什么想达成？（可选）写给她看，她拆的时候会结合这个"
          value={why}
          maxLength={500}
          onChange={(e) => setWhy(e.target.value)}
        />
        <div className="cc-acts">
          <button className="btn sm" onClick={() => void add()} disabled={adding || !title.trim()}>
            {adding ? "记下了…" : "🎯 记下这个目标"}
          </button>
          <span className="tune-hint">先记着，想拆的时候点卡片上的「让Rana拆解」</span>
        </div>
      </div>

      {/* 目标卡片 */}
      {goals.length === 0 && (
        <div className="card pending" style={{ marginBottom: 16 }}>
          <p className="pending-text">
            还没有人生目标。上面写一个，她帮你拆成每月的里程碑，再一步步落到每天的课。
            {error && <span className="sys-err">（{error}）</span>}
          </p>
        </div>
      )}
      {goals.map((goal) => {
        const st = GOAL_STATUS[goal.status] ?? GOAL_STATUS.active;
        const busyParsing = parsingId === goal.id;
        return (
          <article key={goal.id} className="card plan-goal-card">
            <div className="pg-head">
              <span className={`chip${st.chip}`}>{st.label}</span>
              {goal.horizon && <span className="chip">⏳ {goal.horizon}</span>}
              <p className="pg-title">{goal.title}</p>
              <button className="btn ghost sm" onClick={() => void delGoal(goal)} title="删除这个目标">
                🗑
              </button>
            </div>
            {goal.why && <p className="pg-why">{goal.why}</p>}

            {goal.status === "active" && (
              <div className="cc-acts">
                <button className="btn sm" onClick={() => void parse(goal)} disabled={busyParsing || parsingId !== null}>
                  {busyParsing
                    ? "她在结合你的情况和内容库想……（可能一两分钟）"
                    : goal.milestones.length
                      ? "🔄 重新拆解"
                      : "🗺 让Rana拆解成月度里程碑"}
                </button>
                <button className="btn ghost sm" onClick={() => void setGoalStatus(goal, "done")} title="整条链走完了">
                  ✅ 目标达成
                </button>
              </div>
            )}
            {goal.status === "done" && (
              <div className="cc-acts">
                <button className="btn ghost sm" onClick={() => void setGoalStatus(goal, "active")}>
                  ↩ 重新进行
                </button>
              </div>
            )}

            {goal.analysis && goal.parsedAt && (
              <div className="pg-analysis">
                「{goal.analysis}」<small>—— {fmtTs(goal.parsedAt)} 拆解</small>
              </div>
            )}

            {goal.milestones.length > 0 && (
              <div className="plan-ms">
                {goal.milestones.map((ms) => (
                  <div key={ms.id} className={`plan-ms-row${ms.status === "done" ? " done" : ""}`}>
                    <span className="plan-ms-month">{monthLabel(ms.month)}</span>
                    <div className="plan-ms-main">
                      <div className="plan-ms-title">
                        {ms.status === "done" ? "✅ " : ""}
                        {ms.title}
                      </div>
                      {ms.detail && <div className="plan-ms-detail">{ms.detail}</div>}
                    </div>
                    <div className="plan-ms-acts">
                      {ms.todoGoalId ? (
                        <span className="chip" title="已在待办里">
                          📝 已转待办
                        </span>
                      ) : (
                        <button
                          className="btn ghost sm"
                          onClick={() => void msToTodo(goal, ms)}
                          disabled={busyMsId !== null}
                          title="转成一条待办，走「她拆解→排进课表」的老流程"
                        >
                          → 转待办
                        </button>
                      )}
                      <button
                        className="btn ghost sm"
                        onClick={() => void setMsStatus(goal, ms, ms.status === "done" ? "planned" : "done")}
                        disabled={busyMsId !== null}
                      >
                        {ms.status === "done" ? "↩" : "✓"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </article>
        );
      })}

      {/* 本月聚焦 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>
          <span className="ic">🗓</span> 本月聚焦<small>{monthLabel(cm)}</small>
        </h3>
        {monthMilestones.length ? (
          monthMilestones.map(({ goal, ms }) => (
            <div key={ms.id} className="plan-focus-row">
              <span className="chip">{goal.title.slice(0, 10)}{goal.title.length > 10 ? "…" : ""}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {ms.status === "done" ? "✅ " : ""}
                {ms.title}
              </span>
            </div>
          ))
        ) : (
          <p className="pending-text" style={{ margin: 0 }}>
            这个月没有里程碑——上面的目标还没拆，或者拆出来的月份不在这个月。
          </p>
        )}
        <div className="plan-stats">
          <span className="chip">
            📅 本月课 {monthCourses.length} 节（已学 {monthDone}）
          </span>
          <span className="chip">📝 待拆待办 {openTodos.length} 条</span>
          <button className="btn ghost sm" onClick={() => setPlanningTab("schedule")}>
            去课表 →
          </button>
          <button className="btn ghost sm" onClick={() => setPlanningTab("goals")}>
            去待办 →
          </button>
        </div>
      </div>

      {/* 今日：课 + 事件一条时间线 */}
      <div className="card">
        <h3>
          <span className="ic">☀️</span> 今日<small>{todayStr()}</small>
        </h3>
        {overdue.length > 0 && (
          <div className="plan-focus-row" style={{ color: "var(--danger)" }}>
            有 {overdue.length} 节逾期没学完（最早 {overdue[0].date}），去课表补上
          </div>
        )}
        {todayAll.length ? (
          todayAll.map((it) => {
            const cd = countdownLabel(t, it.time);
            return (
              <div key={it.key} className="plan-focus-row">
                <span className={`cal-course ${it.cls}`} style={{ flex: "none" }}>
                  {it.icon} {it.label}
                </span>
                <span className="chip" style={{ flex: "none" }}>
                  {it.time || "—"}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {it.done ? "✅ " : ""}
                  {it.title}
                  {cd && !it.done ? <span className="tune-hint"> · {cd}</span> : null}
                  {it.location && <span className="tune-hint"> · {it.location}</span>}
                </span>
              </div>
            );
          })
        ) : (
          <p className="pending-text" style={{ margin: 0 }}>
            今天没有课，也没有日程。
          </p>
        )}
        {upcoming.length > 0 && (
          <div style={{ borderTop: "1.5px dashed var(--border)", marginTop: 8, paddingTop: 8 }}>
            {upcoming.map((e) => {
              const meta = EVENT_META[e.type] ?? EVENT_META.appointment;
              const dd = daysUntil(e.date);
              return (
                <div key={e.id} className="plan-focus-row">
                  <span className={`cal-course ${meta.cls}`} style={{ flex: "none" }}>
                    {meta.icon} {meta.label}
                  </span>
                  <span className="chip" style={{ flex: "none" }}>
                    {e.date}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {e.title}
                    <span className="tune-hint">
                      {" · "}
                      {dd === 1 ? "明天" : `${dd} 天后`}
                      {e.location ? ` · ${e.location}` : ""}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="plan-stats">
          <button className="btn ghost sm" onClick={() => setPlanningTab("calendar")}>
            去日历 →
          </button>
          <button className="btn ghost sm" onClick={() => setPlanningTab("schedule")}>
            去课表 →
          </button>
        </div>
      </div>
    </>
  );
}
