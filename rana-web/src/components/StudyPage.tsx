// 学习计划页 v2：真实日期的月历课程表（不是循环课）。数据在 rana-web/.study/schedule.json，
// 页面走 /__rana/study* 接口；Rana 通过 study-planner/study-quiz skill 直接改同一份文件。
// v2 新增：多计划并行、错题本（判分自动回收/重考销账）、连续打卡与里程碑评语、学习契约、
// 周报展示、期末考、复习课展示、课程依赖（等前置）、负荷视图、"今天不想学"一键顺延。
import { useCallback, useEffect, useMemo, useState } from "react";
import StudyQuiz, { type QuizMode } from "./StudyQuiz";
import { getNotifyPref, setNotifyPref, requestNotifyPermission, notifyPermission } from "../lib/studyNotify";
import { gateway } from "../lib/gateway";
import { useAppStore } from "../store/useAppStore";
import { modelSuffix } from "../lib/types";

/** 排课/出题/判分共用的专用会话 key（study-agent.mjs 里的 SESSION_KEY 同款） */
const STUDY_SESSION_KEY = "agent:main:study-planner";
const MODEL_PREF_KEY = "study.model.v1";

export interface StudyCourse {
  id: string;
  title: string;
  date: string;
  timeStart?: string;
  timeEnd?: string;
  status: "planned" | "done";
  kind?: "lesson" | "review";
  reviewOf?: string;
  reviewGap?: number;
  planId?: string;
  dependsOn?: string[];
  estMin?: number;
  materialIds?: string[];
  note?: string;
  postponedCount?: number;
  doneAt?: number;
  quiz?: { status: "none" | "pending" | "done"; score?: number; comment?: string; at?: number };
}
export interface StudyMaterial {
  id: string;
  name: string;
  file: string;
  size: number;
  addedAt: number;
}
export interface StudyPlan {
  id: string;
  name: string;
  createdAt: number;
  lastFinal?: { score: number; comment: string; at: number };
}
export interface StudyMistake {
  id: string;
  courseId?: string;
  courseTitle: string;
  q: string;
  myAnswer: string;
  review?: string;
  addedAt: number;
  resolvedAt?: number;
}
export interface StudyReport {
  id: string;
  kind: "weekly";
  title: string;
  text: string;
  at: number;
}
interface Schedule {
  version: number;
  plans: StudyPlan[];
  courses: StudyCourse[];
  materials: StudyMaterial[];
  mistakes: StudyMistake[];
  reports: StudyReport[];
  streak: { days: number; best: number; lastDay: string; comment?: string; commentDay?: string };
  contract?: { text: string; updatedAt: number };
  updatedAt: number;
}

const DEFAULT_PLAN = "p-default";
const pad2 = (n: number) => String(n).padStart(2, "0");
const dateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const nowHM = () => {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const addDays = (ds: string, n: number) => {
  const [y, m, d] = ds.split("-").map(Number);
  return dateStr(new Date(y, m - 1, d + n));
};
const byDateTime = (a: StudyCourse, b: StudyCourse) =>
  a.date.localeCompare(b.date) || (a.timeStart ?? "").localeCompare(b.timeStart ?? "") || a.id.localeCompare(b.id);

/** 月历格子：周一开头，固定 6 行（42 格），含前后月补位 */
function monthCells(y: number, m: number): Array<{ date: string; inMonth: boolean }> {
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const start = new Date(y, m - 1, 1 - lead);
  const cells: Array<{ date: string; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ date: dateStr(d), inMonth: d.getMonth() === m - 1 });
  }
  return cells;
}

/** 从 from 的第二天起，找第一个当天没有任何课的日期（跨计划一起算，避免撞车） */
function nextFreeDate(courses: StudyCourse[], from: string): string {
  const taken = new Set(courses.map((c) => c.date));
  let d = addDays(from, 1);
  for (let i = 0; i < 400; i++) {
    if (!taken.has(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}

/** 周视图格子：某天所在周的周一到周日（7 格） */
function weekCells(ds: string): Array<{ date: string; inMonth: boolean }> {
  const [y, m, d] = ds.split("-").map(Number);
  const lead = (new Date(y, m - 1, d).getDay() + 6) % 7;
  const start = addDays(ds, -lead);
  return Array.from({ length: 7 }, (_, i) => ({ date: addDays(start, i), inMonth: true }));
}

/** 负荷：一天的课程数与预估总时长；重了（>3节 或 >180分钟）算超载 */
function dayLoad(courses: StudyCourse[]): { count: number; minutes: number; heavy: boolean } {
  const minutes = courses.reduce((n, c) => n + (c.estMin ?? 0), 0);
  const heavy = courses.length > 3 || minutes > 180;
  return { count: courses.length, minutes, heavy };
}

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}` : `${m}m`);

export default function StudyPage() {
  const [sched, setSched] = useState<Schedule | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() + 1 };
  });
  const [selDate, setSelDate] = useState(todayStr());
  // 月/周视图切换（记住上次的偏好）
  const [calMode, setCalMode] = useState<"month" | "week">(() => {
    try {
      return localStorage.getItem("study.calMode") === "week" ? "week" : "month";
    } catch {
      return "month";
    }
  });
  const toggleCalMode = () =>
    setCalMode((m) => {
      const next = m === "month" ? "week" : "month";
      try {
        localStorage.setItem("study.calMode", next);
      } catch {
        /* 存不进就算了 */
      }
      return next;
    });
  const [quizMode, setQuizMode] = useState<QuizMode | null>(null);
  // 计划
  const [planId, setPlanId] = useState(DEFAULT_PLAN);
  const [newPlan, setNewPlan] = useState("");
  // 手动加课表单
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ title: "", date: todayStr(), timeStart: "", timeEnd: "", note: "", estMin: "" });
  const [addMats, setAddMats] = useState<string[]>([]);
  const [addDep, setAddDep] = useState("");
  // 资料上传 + 排课
  const [uploading, setUploading] = useState(false);
  const [planReq, setPlanReq] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planMsg, setPlanMsg] = useState("");
  // 契约
  const [contractText, setContractText] = useState<string | null>(null);
  const [lazyDay, setLazyDay] = useState("");
  // 到点弹窗提醒开关
  const [, setNotifyVersion] = useState(0);
  // 排课/出题用的模型（""=跟随专用会话当前模型；选择存 localStorage，会话已存在时立即热切）
  const [pickModel, setPickModel] = useState(() => {
    try {
      return localStorage.getItem(MODEL_PREF_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const models = useAppStore((s) => s.models);
  const sessions = useAppStore((s) => s.sessions);
  const studySession = sessions.find((s) => s.key === STUDY_SESSION_KEY);
  const modelGroups = useMemo(() => {
    const g = new Map<string, typeof models>();
    for (const m of models) {
      const k = m.provider ?? "其他";
      g.set(k, [...(g.get(k) ?? []), m]);
    }
    return [...g.entries()];
  }, [models]);
  const changeModel = (id: string) => {
    setPickModel(id);
    try {
      localStorage.setItem(MODEL_PREF_KEY, id);
    } catch { /* 存不进就算了 */ }
    // 会话已在：立即切，侧栏和这里同步显示；还没建会话：下次排课时生效
    if (id && studySession) void gateway.setModel(STUDY_SESSION_KEY, id).catch(() => {});
  };
  // "现在该学什么"每分钟刷新一次
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/__rana/study");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Schedule;
      setSched(j);
      setContractText((prev) => (prev === null || prev === j.contract?.text ? j.contract?.text ?? "" : prev));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, [load]);

  const courses = sched?.courses ?? [];
  const materials = sched?.materials ?? [];
  const plans = sched?.plans ?? [];
  const mistakes = sched?.mistakes ?? [];
  const openMistakes = useMemo(() => mistakes.filter((m) => !m.resolvedAt), [mistakes]);
  const latestReport = useMemo(() => [...(sched?.reports ?? [])].sort((a, b) => b.at - a.at)[0], [sched?.reports]);

  /** 通用保存：courses / plans / contract 任意组合 */
  const save = useCallback(
    async (patch: { courses?: StudyCourse[]; plans?: StudyPlan[]; contract?: { text: string } }) => {
      setSaving(true);
      setError("");
      if (patch.courses) setSched((s) => (s ? { ...s, courses: patch.courses! } : s));
      if (patch.plans) setSched((s) => (s ? { ...s, plans: patch.plans! } : s));
      try {
        const r = await fetch("/__rana/study/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const j = (await r.json()) as { ok?: boolean; error?: string; streak?: Schedule["streak"] };
        if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        // 服务端可能补了 doneAt/复习课/打卡，重新拉一遍真数据
        await load();
        return true;
      } catch (e) {
        setError(`保存失败：${(e as Error).message}`);
        await load();
        return false;
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  const planCourses = useMemo(
    () => courses.filter((c) => (c.planId ?? DEFAULT_PLAN) === planId),
    [courses, planId],
  );

  const setCourse = (id: string, patch: Partial<StudyCourse>) =>
    void save({ courses: courses.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  const markDone = (c: StudyCourse) => void save({ courses: courses.map((x) => (x.id === c.id ? { ...x, status: "done" as const, quiz: { status: "pending" as const } } : x)) });
  const postpone = (c: StudyCourse) => {
    const d = nextFreeDate(courses, todayStr());
    setCourse(c.id, { date: d, postponedCount: (c.postponedCount ?? 0) + 1 });
    setSelDate(d);
  };
  const delCourse = (c: StudyCourse) => {
    if (!window.confirm(`删掉「${c.title}」？删了就没了。`)) return;
    void save({ courses: courses.filter((x) => x.id !== c.id) });
  };

  /** "今天不想学"：今天的课（当前计划）逐节顺延到空位（后面的课排队往后找） */
  const lazyToday = () => {
    const t = todayStr();
    const todayPlanned = planCourses.filter((c) => c.status === "planned" && c.date === t);
    if (!todayPlanned.length) {
      setLazyDay("今天本来就没课。");
      return;
    }
    if (!window.confirm(`把今天的 ${todayPlanned.length} 节课全部顺延？她会记着的。`)) return;
    let next = [...courses];
    for (const c of todayPlanned) {
      const d = nextFreeDate(next, t);
      next = next.map((x) => (x.id === c.id ? { ...x, date: d, postponedCount: (x.postponedCount ?? 0) + 1 } : x));
    }
    void save({ courses: next });
    setLazyDay(`……偷懒。${todayPlanned.length} 节课挪到后面了。`);
  };

  const addCourse = () => {
    const title = addForm.title.trim();
    if (!title || !addForm.date) {
      setError("加课至少要标题和日期。");
      return;
    }
    const c: StudyCourse = {
      id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      date: addForm.date,
      status: "planned",
      kind: "lesson",
      planId,
      quiz: { status: "none" },
      ...(addForm.timeStart ? { timeStart: addForm.timeStart } : {}),
      ...(addForm.timeEnd ? { timeEnd: addForm.timeEnd } : {}),
      ...(addForm.estMin && Number(addForm.estMin) > 0 ? { estMin: Math.round(Number(addForm.estMin)) } : {}),
      ...(addDep ? { dependsOn: [addDep] } : {}),
      ...(addMats.length ? { materialIds: [...addMats] } : {}),
      ...(addForm.note.trim() ? { note: addForm.note.trim() } : {}),
    };
    void save({ courses: [...courses, c] });
    setSelDate(addForm.date);
    setAddForm({ title: "", date: addForm.date, timeStart: "", timeEnd: "", note: "", estMin: "" });
    setAddMats([]);
    setAddDep("");
  };

  const addPlan = () => {
    const name = newPlan.trim();
    if (!name) return;
    const p: StudyPlan = { id: `p-${Date.now().toString(36)}`, name, createdAt: Date.now() };
    void save({ plans: [...plans, p] }).then(() => setPlanId(p.id));
    setNewPlan("");
  };
  const delPlan = (p: StudyPlan) => {
    if (courses.some((c) => (c.planId ?? DEFAULT_PLAN) === p.id)) {
      setError(`计划「${p.name}」里还有课，删课之后才能删计划。`);
      return;
    }
    if (!window.confirm(`删掉计划「${p.name}」？`)) return;
    void save({ plans: plans.filter((x) => x.id !== p.id) });
    setPlanId(DEFAULT_PLAN);
  };

  const upload = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      const r = await fetch(`/__rana/study/material?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: await file.arrayBuffer(),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(`上传失败：${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const delMaterial = async (m: StudyMaterial) => {
    if (!window.confirm(`删掉资料「${m.name}」？`)) return;
    try {
      const r = await fetch(`/__rana/study/material?id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(`删除失败：${(e as Error).message}`);
    }
  };

  const runPlan = async () => {
    if (planning) return;
    setPlanning(true);
    setPlanMsg("");
    setError("");
    try {
      const r = await fetch("/__rana/study/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requirements: planReq, ...(pickModel ? { model: pickModel } : {}) }),
      });
      const j = (await r.json()) as { ok?: boolean; summary?: string; error?: string };
      setPlanMsg(j.ok ? j.summary ?? "排好了。" : j.error ?? j.summary ?? "她没排成，看下面错误。");
      if (!j.ok) setError(j.error ?? "");
      await load();
    } catch (e) {
      setError(`排课失败：${(e as Error).message}`);
    } finally {
      setPlanning(false);
    }
  };

  // ---- 到点弹窗开关 ----
  const notifyOn = getNotifyPref() && notifyPermission() === "granted";
  const toggleNotify = async () => {
    if (notifyOn) {
      setNotifyPref(false);
    } else {
      const perm = await requestNotifyPermission();
      if (perm === "granted") setNotifyPref(true);
      else
        setError(
          perm === "unsupported"
            ? "这个浏览器不支持通知。"
            : "浏览器没给通知权限：地址栏左侧的锁/ⓘ 图标里把通知设为允许，再回来打开。",
        );
    }
    setNotifyVersion((v) => v + 1);
  };

  // ---- 派生数据 ----
  const byDate = useMemo(() => {
    const map = new Map<string, StudyCourse[]>();
    for (const c of planCourses) {
      const list = map.get(c.date) ?? [];
      list.push(c);
      map.set(c.date, list);
    }
    for (const list of map.values()) list.sort(byDateTime);
    return map;
  }, [planCourses]);

  const doneIds = useMemo(() => new Set(planCourses.filter((c) => c.status === "done").map((c) => c.id)), [planCourses]);
  /** 前置课没全完成的课（等前置） */
  const blockedOf = (c: StudyCourse) => (c.dependsOn ?? []).filter((id) => !doneIds.has(id));

  const t = todayStr();
  const hm = nowHM();
  const todays = byDate.get(t) ?? [];
  const plannedToday = todays.filter((c) => c.status === "planned");
  const overdue = planCourses.filter((c) => c.status === "planned" && c.date < t);
  const doneCount = planCourses.filter((c) => c.status === "done").length;
  const donePct = planCourses.length ? Math.round((doneCount / planCourses.length) * 100) : 0;
  const quizScores = planCourses.map((c) => c.quiz?.score).filter((x): x is number => typeof x === "number");
  const quizAvg = quizScores.length ? Math.round(quizScores.reduce((a, b) => a + b, 0) / quizScores.length) : null;
  const nowCourse =
    plannedToday.find((c) => c.timeStart && c.timeEnd && c.timeStart <= hm && hm <= c.timeEnd) ??
    plannedToday.find((c) => c.timeStart && !c.timeEnd && c.timeStart <= hm) ??
    plannedToday.find((c) => !c.timeStart);
  const nextCourse = planCourses
    .filter((c) => c.status === "planned" && (c.date > t || (c.date === t && c.timeStart && c.timeStart > hm)))
    .sort(byDateTime)[0];
  const selCourses = byDate.get(selDate) ?? [];
  const matName = (id: string) => materials.find((m) => m.id === id)?.name ?? id;
  const streak = sched?.streak ?? { days: 0, best: 0, lastDay: "" };
  const curPlan = plans.find((p) => p.id === planId);

  const shiftMonth = (delta: number) => {
    setCursor(({ y, m }) => {
      const d = new Date(y, m - 1 + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() + 1 };
    });
  };
  /** ‹ › 在月视图翻月、周视图挪一周 */
  const shiftCal = (delta: number) => {
    if (calMode === "month") shiftMonth(delta);
    else setSelDate((d) => addDays(d, delta * 7));
  };

  /** 日历格子渲染：月视图每格最多 2 条课，周视图整列放开显示 */
  const renderCalCell = (cell: { date: string; inMonth: boolean }, showAll: boolean) => {
    const cs = byDate.get(cell.date) ?? [];
    const load = dayLoad(cs);
    const hasLate = cs.some((c) => c.status === "planned" && cell.date < t);
    const show = showAll ? cs : cs.slice(0, 2);
    return (
      <button
        key={cell.date}
        type="button"
        className={[
          "cal-cell",
          cell.inMonth ? "" : "other",
          cell.date === t ? "today" : "",
          cell.date === selDate ? "sel" : "",
          load.heavy ? "heavy" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => setSelDate(cell.date)}
      >
        <span className="cd">
          {Number(cell.date.slice(8))}
          {hasLate && <i className="late-dot" title="有逾期未完成的课" />}
          {load.count > 0 && load.minutes > 0 && <i className="load-min">≈{fmtMin(load.minutes)}</i>}
        </span>
        {show.map((c) => (
          <span
            key={c.id}
            className={`cal-course ${c.status === "done" ? "done" : cell.date < t ? "late" : ""}`}
            title={c.title}
          >
            {c.status === "done" ? "✓" : ""} {c.title}
          </span>
        ))}
        {!showAll && cs.length > 2 && <span className="cal-more">+{cs.length - 2}</span>}
      </button>
    );
  };

  const weekCellsNow = weekCells(selDate);

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 1100 }}>
        <div className="page-intro">
          <h2>学习计划</h2>
          <p>
            真实日期的课程表 · 没完成的课自动顺延 · 学完出题判分 · 错题自动收进错题本
            {saving && " · 保存中…"}
            {error && <span className="sys-err">（{error}）</span>}
          </p>
        </div>

        {/* 计划条：多计划并行 + 打卡 + 期末考 */}
        <div className="study-planbar">
          <div className="plan-chips">
            {plans.map((p) => {
              const n = courses.filter((c) => (c.planId ?? DEFAULT_PLAN) === p.id).length;
              return (
                <span key={p.id} className={`plan-chip${p.id === planId ? " on" : ""}`}>
                  <button type="button" className="pc-btn" onClick={() => setPlanId(p.id)}>
                    {p.name} <i>{n}</i>
                  </button>
                  {p.id !== DEFAULT_PLAN && n === 0 && (
                    <button type="button" className="pc-del" title="删掉空计划" onClick={() => delPlan(p)}>
                      ✕
                    </button>
                  )}
                </span>
              );
            })}
            <span className="plan-chip add">
              <input
                className="pc-input"
                placeholder="新计划名…"
                value={newPlan}
                onChange={(e) => setNewPlan(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addPlan()}
              />
              <button type="button" className="pc-btn" onClick={addPlan} title="新增并行计划">
                ＋
              </button>
            </span>
          </div>
          <div className="plan-right">
            <span className="chip green" title={`历史最长 ${streak.best} 天`}>
              🔥 连续打卡 {streak.days} 天
            </span>
            {quizAvg !== null && (
              <span className="chip" title="当前计划已考过的测验平均分">
                📊 测验均分 {quizAvg}
              </span>
            )}
            <button
              className="btn ghost sm"
              onClick={() => setQuizMode({ kind: "final", planId, title: curPlan?.name ?? "期末考" })}
              title="综合整个计划的资料出一张 10 题大卷"
            >
              🎓 期末考{curPlan?.lastFinal ? `（上次 ${curPlan.lastFinal.score} 分）` : ""}
            </button>
          </div>
        </div>

        {/* 现在该学什么 */}
        <div className="card study-today" style={{ marginBottom: 16 }}>
          <div className="st-top">
            <div className="st-now">
              <span className="st-label">现在</span>
              {nowCourse ? (
                <b>{nowCourse.title}</b>
              ) : overdue.length ? (
                <b>
                  有 {overdue.length} 节没完成，先补上（最早 {overdue[0].date}）
                </b>
              ) : (
                <b>现在没安排{nextCourse ? `，下一节 ${nextCourse.date} ${nextCourse.timeStart ?? ""}` : ""}</b>
              )}
            </div>
            <button className="btn ghost sm" onClick={lazyToday} title="把今天（当前计划）没学的课全部顺延到后面的空位">
              😴 今天不想学
            </button>
            <button
              className={`btn ghost sm${notifyOn ? " notify-on" : ""}`}
              onClick={() => void toggleNotify()}
              title="到点的课弹一条浏览器通知（只提醒设了时段的课；网页开着才有效）"
            >
              {notifyOn ? "🔔 弹窗：开" : "🔔 弹窗：关"}
            </button>
          </div>
          {lazyDay && <p className="plan-result">{lazyDay}</p>}
          {streak.comment && streak.commentDay === t && (
            <p className="plan-result" title={`连续 ${streak.days} 天`}>
              「{streak.comment}」
            </p>
          )}
          <div className="st-grid">
            <div className="st-cell">
              <div className="k">接下来</div>
              <div className="v">{nextCourse ? `${nextCourse.date} · ${nextCourse.title}` : "—"}</div>
            </div>
            <div className="st-cell">
              <div className="k">今天</div>
              <div className="v">
                {todays.length} 节<small>（待学 {plannedToday.length}）</small>
              </div>
            </div>
            <div className="st-cell">
              <div className="k">逾期未完成</div>
              <div className={`v${overdue.length ? " warn" : ""}`}>{overdue.length} 节</div>
            </div>
            <div className="st-cell">
              <div className="k">完成率</div>
              <div className="v">
                {donePct}% <small>（{doneCount}/{planCourses.length}）</small>
              </div>
              <div className="bar st-bar">
                <i style={{ width: `${donePct}%` }} />
              </div>
            </div>
          </div>
        </div>

        <div className="study-layout">
          {/* 日历（月视图 / 周视图切换；含负荷标注） */}
          <div className="card study-cal">
            <div className="cal-nav">
              <button className="btn ghost sm" onClick={() => shiftCal(-1)}>
                ‹
              </button>
              <b>
                {calMode === "month"
                  ? `${cursor.y} 年 ${cursor.m} 月`
                  : `${weekCellsNow[0].date} ～ ${weekCellsNow[6].date}`}
              </b>
              <div className="cal-btns">
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    const d = new Date();
                    setCursor({ y: d.getFullYear(), m: d.getMonth() + 1 });
                    setSelDate(todayStr());
                  }}
                >
                  {calMode === "month" ? "今天" : "本周"}
                </button>
                <button className="btn ghost sm" onClick={toggleCalMode} title="月视图看全局，周视图看这一周的每节课">
                  {calMode === "month" ? "📆 周视图" : "🗓 月视图"}
                </button>
                <button className="btn ghost sm" onClick={() => shiftCal(1)}>
                  ›
                </button>
              </div>
            </div>
            <div className="cal-week">
              {WEEK.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <div className={`cal-grid${calMode === "week" ? " wk" : ""}`}>
              {(calMode === "month" ? monthCells(cursor.y, cursor.m) : weekCellsNow).map((cell) =>
                renderCalCell(cell, calMode === "week"),
              )}
            </div>
            <p className="cal-legend">格子右上 ≈ 时长是当天预估总负荷；偏红 = 超载（多于 3 节或超过 3 小时），找她重排吧。</p>
          </div>

          <div className="study-side">
            {/* 当日课程 */}
            <div className="card study-day">
              <h3>
                {selDate === t ? "今天" : selDate} 的课
                <small>
                  {selCourses.length} 节{selCourses.length ? "" : " · 点左边日历挑一天"}
                </small>
              </h3>
              {selCourses.map((c) => {
                const late = c.status === "planned" && c.date < t;
                const blocked = blockedOf(c);
                const mats = (c.materialIds ?? []).filter((id) => materials.some((m) => m.id === id));
                return (
                  <article key={c.id} className={`course-card ${c.status}${late ? " late" : ""}`}>
                    <div className="cc-head">
                      <b>{c.title}</b>
                      <span className="chip">{c.timeStart ? `${c.timeStart}${c.timeEnd ? `~${c.timeEnd}` : ""}` : "全天可学"}</span>
                      {c.kind === "review" && <span className="chip">🔁 复习+{c.reviewGap}天</span>}
                      {c.status === "planned" && typeof c.quiz?.score === "number" && (
                        <span className="chip warn" title="上次测验没到 60 分，这节打回重学了">
                          ↩ 重学（上次 {c.quiz.score} 分）
                        </span>
                      )}
                      {c.estMin ? <span className="chip">≈{c.estMin}分钟</span> : null}
                      {c.status === "done" && <span className="chip green">✓ 学完</span>}
                      {late && <span className="chip warn">逾期</span>}
                      {(c.postponedCount ?? 0) > 0 && <span className="chip">顺延×{c.postponedCount}</span>}
                    </div>
                    {blocked.length > 0 && (
                      <p className="cc-block">
                        ⛔ 等前置：{blocked.map((id) => courses.find((x) => x.id === id)?.title ?? id).join("、")}
                      </p>
                    )}
                    {c.note && <p className="cc-note">{c.note}</p>}
                    {mats.length > 0 && (
                      <div className="cc-mats">
                        {mats.map((id) => (
                          <span key={id} className="chip">
                            📄 {matName(id)}
                          </span>
                        ))}
                      </div>
                    )}
                    {c.status === "done" && c.quiz?.status === "done" && (
                      <div className="cc-quiz-res">
                        测验 <b>{c.quiz.score}</b> 分 · {c.quiz.comment}
                      </div>
                    )}
                    <div className="cc-acts">
                      {c.status === "planned" && (
                        <>
                          <button
                            className="btn sm"
                            onClick={() => markDone(c)}
                            disabled={blocked.length > 0}
                            title={blocked.length ? "前置课没完成，先学前置" : "标记学完，自动安排复习课"}
                          >
                            ✅ 学完了
                          </button>
                          <button className="btn ghost sm" onClick={() => postpone(c)} title={`顺延到 ${nextFreeDate(courses, t)}`}>
                            ⏭ 没完成，顺延
                          </button>
                        </>
                      )}
                      {c.status === "done" && c.quiz?.status !== "done" && (
                        <button
                          className="btn sm"
                          onClick={() => setQuizMode(quizMode?.kind === "course" && quizMode.courseId === c.id ? null : { kind: "course", courseId: c.id, title: c.title })}
                        >
                          📝 {c.quiz?.status === "pending" ? (c.kind === "review" ? "复习测验" : "出题测验") : "再考一次"}
                        </button>
                      )}
                      <label className="cc-date">
                        改日期
                        <input
                          type="date"
                          value={c.date}
                          onChange={(e) => e.target.value && setCourse(c.id, { date: e.target.value })}
                        />
                      </label>
                      <button className="btn ghost sm" onClick={() => delCourse(c)}>
                        🗑
                      </button>
                    </div>
                    {quizMode?.kind === "course" && quizMode.courseId === c.id && (
                      <StudyQuiz mode={quizMode} model={pickModel || undefined} onClose={() => setQuizMode(null)} onGraded={() => void load()} />
                    )}
                  </article>
                );
              })}
              {selCourses.length === 0 && <p className="pending-text">这天没排课。</p>}
            </div>

            {/* 手动加课 */}
            <div className="card study-add">
              <h3>
                ✏️ 自己加一节课
                <small>
                  <button className="btn ghost sm" onClick={() => setAddOpen(!addOpen)}>
                    {addOpen ? "收起" : "展开"}
                  </button>
                </small>
              </h3>
              {addOpen && (
                <div className="study-form">
                  <input
                    className="set-input"
                    placeholder="课程标题（如：第3课 线性回归）"
                    value={addForm.title}
                    onChange={(e) => setAddForm({ ...addForm, title: e.target.value })}
                  />
                  <div className="sf-row">
                    <input
                      className="set-input"
                      type="date"
                      value={addForm.date}
                      onChange={(e) => setAddForm({ ...addForm, date: e.target.value })}
                    />
                    <input
                      className="set-input"
                      type="time"
                      value={addForm.timeStart}
                      onChange={(e) => setAddForm({ ...addForm, timeStart: e.target.value })}
                    />
                    <input
                      className="set-input"
                      type="time"
                      value={addForm.timeEnd}
                      onChange={(e) => setAddForm({ ...addForm, timeEnd: e.target.value })}
                    />
                  </div>
                  <div className="sf-row">
                    <input
                      className="set-input"
                      type="number"
                      min={5}
                      max={600}
                      placeholder="预计几分钟（可选）"
                      value={addForm.estMin}
                      onChange={(e) => setAddForm({ ...addForm, estMin: e.target.value })}
                    />
                    <select
                      className="set-input"
                      value={addDep}
                      onChange={(e) => setAddDep(e.target.value)}
                      title="这节课要等哪节课学完才能学（可选）"
                    >
                      <option value="">不等前置课</option>
                      {planCourses
                        .filter((c) => c.status === "planned")
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            等前置：{c.title}
                          </option>
                        ))}
                    </select>
                  </div>
                  <input
                    className="set-input"
                    placeholder="笔记（可选）：这节课要掌握什么"
                    value={addForm.note}
                    onChange={(e) => setAddForm({ ...addForm, note: e.target.value })}
                  />
                  {materials.length > 0 && (
                    <div className="cc-mats">
                      {materials.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className={`mat-check${addMats.includes(m.id) ? " on" : ""}`}
                          onClick={() =>
                            setAddMats((ids) => (ids.includes(m.id) ? ids.filter((x) => x !== m.id) : [...ids, m.id]))
                          }
                        >
                          📄 {m.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div>
                    <button className="btn sm" onClick={addCourse}>
                      加进课程表
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 期末考面板 */}
        {quizMode?.kind === "final" && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3>🎓 期末考 · {curPlan?.name}</h3>
            <StudyQuiz mode={quizMode} model={pickModel || undefined} onClose={() => setQuizMode(null)} onGraded={() => void load()} />
          </div>
        )}

        {/* 错题重考面板 */}
        {quizMode?.kind === "drill" && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3>🔁 错题重考</h3>
            <StudyQuiz mode={quizMode} model={pickModel || undefined} onClose={() => setQuizMode(null)} onGraded={() => void load()} />
          </div>
        )}

        {/* 错题本 */}
        <div className="card study-mistakes" style={{ marginBottom: 16 }}>
          <h3>
            ❌ 错题本 <small>测验里答错/半对的题自动收进来，重考答对自动销账</small>
          </h3>
          {openMistakes.length === 0 ? (
            <p className="pending-text">
              {mistakes.length > 0 ? `没有未解决的错题（累计收过 ${mistakes.length} 道，都销账了）。` : "还没收过错题——考砸了才会有。"}
            </p>
          ) : (
            <>
              <div className="cc-acts" style={{ marginTop: 0, marginBottom: 10 }}>
                <button
                  className="btn sm"
                  onClick={() => setQuizMode({ kind: "drill", mistakeIds: openMistakes.slice(0, 10).map((m) => m.id), title: `${openMistakes.length} 道错题` })}
                >
                  🔁 再考这些错题（{Math.min(openMistakes.length, 10)}）
                </button>
              </div>
              {openMistakes.map((m) => (
                <div key={m.id} className="mis-row">
                  <div className="mis-q">{m.q}</div>
                  <div className="mis-meta">
                    <span>{m.courseTitle}</span>
                    <span>你答过：{m.myAnswer || "（空）"}</span>
                    {m.review && <span>她说：{m.review}</span>}
                    <span>{new Date(m.addedAt).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* 契约 + 周报 双栏 */}
        <div className="study-duo">
          <div className="card study-contract">
            <h3>🤝 学习契约 <small>立个约，她睡前小结和周报都会对照着说进度</small></h3>
            <textarea
              className="set-input"
              style={{ minHeight: 64 }}
              placeholder="例：本周学完机器学习入门全部课程，没完成周末不许碰游戏"
              value={contractText ?? ""}
              onChange={(e) => setContractText(e.target.value)}
            />
            <div className="cc-acts">
              <button className="btn sm" onClick={() => void save({ contract: { text: contractText ?? "" } })}>
                立约
              </button>
              <span className="tune-hint">在聊天里跟她说"立个约：…"也一样</span>
            </div>
          </div>
          <div className="card study-report">
            <h3>📋 学习周报 <small>每周日 21:00 她写一篇并推给你</small></h3>
            {latestReport ? (
              <>
                <div className="rp-title">{latestReport.title}</div>
                <p className="rp-text">{latestReport.text}</p>
              </>
            ) : (
              <p className="pending-text">还没有周报，等第一个周日。</p>
            )}
          </div>
        </div>

        {/* 资料库 + 让Rana排课 */}
        <div className="card study-mats">
          <h3>
            📚 学习资料 <small>任务书发这儿或直接微信发给她都行，她排课用同一份</small>
          </h3>
          {materials.length === 0 && <p className="pending-text">资料库还是空的。传一份任务书，然后点下面的「让Rana排课」。</p>}
          {materials.map((m) => (
            <div key={m.id} className="mat-row">
              <span className="mr-name">📄 {m.name}</span>
              <span className="mr-meta">
                {(m.size / 1024).toFixed(0)} KB · {new Date(m.addedAt).toLocaleDateString()}
              </span>
              <button className="btn ghost sm" onClick={() => void delMaterial(m)}>
                删
              </button>
            </div>
          ))}
          <div className="cc-acts" style={{ marginTop: 4 }}>
            <label className="btn ghost sm">
              {uploading ? "上传中…" : "＋ 上传资料"}
              <input
                type="file"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void upload(f);
                }}
              />
            </label>
          </div>

          <div className="plan-box">
            <h3>
              🗓 让 Rana 排课 <small>她读上面的资料，把课排进日历（估时、超90分钟自动拆分、每天不超3节）</small>
            </h3>
            <textarea
              className="set-input plan-req"
              placeholder="例：从明天开始，每天 2 节，晚上学，周日休息，10 月 1 号前学完，有依赖的课标前置"
              value={planReq}
              onChange={(e) => setPlanReq(e.target.value)}
            />
            <div className="cc-acts" style={{ marginTop: 8 }}>
              <select
                className="set-input study-model"
                value={pickModel || studySession?.model || ""}
                onChange={(e) => changeModel(e.target.value)}
                title="排课/出题/判分用哪个脑子（作用于「📚 学习计划」专用会话，选完立即生效）"
              >
                <option value="">
                  跟随会话{studySession?.model ? `（${modelSuffix(studySession.model)}）` : "（她的默认）"}
                </option>
                {modelGroups.map(([provider, items]) => (
                  <optgroup key={provider} label={provider}>
                    {items.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || modelSuffix(m.id)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button className="btn" onClick={() => void runPlan()} disabled={planning}>
                {planning ? "她在看资料排课……可能一两分钟" : "让Rana排课"}
              </button>
            </div>
            {planMsg && <p className="plan-result">{planMsg}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
