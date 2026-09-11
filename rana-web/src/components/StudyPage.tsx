// 学习计划页：真实日期的月历课程表（不是循环课）。数据在 rana-web/.study/schedule.json，
// 页面走 /__rana/study* 接口；Rana 通过 study-planner/study-quiz skill 直接改同一份文件，
// 页面手动改动 POST /save（只提交 courses，资料登记由上传/删除接口管）。
// 顺延规则：标"没完成"→ 从明天起找第一个没有任何课的日期挪过去，其他课不动。
import { useCallback, useEffect, useMemo, useState } from "react";
import StudyQuiz from "./StudyQuiz";
import { getNotifyPref, setNotifyPref, requestNotifyPermission, notifyPermission } from "../lib/studyNotify";

export interface StudyCourse {
  id: string;
  title: string;
  date: string;
  timeStart?: string;
  timeEnd?: string;
  status: "planned" | "done";
  materialIds?: string[];
  note?: string;
  postponedCount?: number;
  quiz?: { status: "none" | "pending" | "done"; score?: number; comment?: string; at?: number };
}
export interface StudyMaterial {
  id: string;
  name: string;
  file: string;
  size: number;
  addedAt: number;
}
interface Schedule {
  version: number;
  courses: StudyCourse[];
  materials: StudyMaterial[];
  updatedAt: number;
}

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

/** 从 from 的第二天起，找第一个当天没有任何课的日期 */
function nextFreeDate(courses: StudyCourse[], from: string): string {
  const taken = new Set(courses.map((c) => c.date));
  let d = addDays(from, 1);
  for (let i = 0; i < 400; i++) {
    if (!taken.has(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

export default function StudyPage() {
  const [sched, setSched] = useState<Schedule | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() + 1 };
  });
  const [selDate, setSelDate] = useState(todayStr());
  const [quizId, setQuizId] = useState<string | null>(null);
  // 手动加课表单
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ title: "", date: todayStr(), timeStart: "", timeEnd: "", note: "" });
  const [addMats, setAddMats] = useState<string[]>([]);
  // 资料上传 + 排课
  const [uploading, setUploading] = useState(false);
  const [planReq, setPlanReq] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planMsg, setPlanMsg] = useState("");
  // "现在该学什么"每分钟刷新一次
  const [, setTick] = useState(0);

  // 到点弹窗提醒开关（点一次重算一次状态）
  const [, setNotifyVersion] = useState(0);
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

  const load = useCallback(async () => {
    try {
      const r = await fetch("/__rana/study");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSched((await r.json()) as Schedule);
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

  const saveCourses = useCallback(
    async (next: StudyCourse[]) => {
      setSaving(true);
      setError("");
      setSched((s) => (s ? { ...s, courses: next } : s)); // 先改本地，失败再回滚重载
      try {
        const r = await fetch("/__rana/study/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ courses: next }),
        });
        const j = (await r.json()) as { ok?: boolean; error?: string; updatedAt?: number };
        if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        if (j.updatedAt) setSched((s) => (s ? { ...s, updatedAt: j.updatedAt! } : s));
      } catch (e) {
        setError(`保存失败：${(e as Error).message}`);
        void load();
      } finally {
        setSaving(false);
      }
    },
    [load],
  );

  const setCourse = (id: string, patch: Partial<StudyCourse>) =>
    void saveCourses(courses.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const markDone = (c: StudyCourse) => setCourse(c.id, { status: "done", quiz: { status: "pending" } });
  const postpone = (c: StudyCourse) => {
    const d = nextFreeDate(courses, todayStr());
    setCourse(c.id, { date: d, postponedCount: (c.postponedCount ?? 0) + 1 });
    setSelDate(d);
  };
  const delCourse = (c: StudyCourse) => {
    if (!window.confirm(`删掉「${c.title}」？删了就没了。`)) return;
    void saveCourses(courses.filter((x) => x.id !== c.id));
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
      quiz: { status: "none" },
      ...(addForm.timeStart ? { timeStart: addForm.timeStart } : {}),
      ...(addForm.timeEnd ? { timeEnd: addForm.timeEnd } : {}),
      ...(addMats.length ? { materialIds: [...addMats] } : {}),
      ...(addForm.note.trim() ? { note: addForm.note.trim() } : {}),
    };
    void saveCourses([...courses, c]);
    setSelDate(addForm.date);
    setAddForm({ title: "", date: addForm.date, timeStart: "", timeEnd: "", note: "" });
    setAddMats([]);
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
        body: JSON.stringify({ requirements: planReq }),
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

  // ---- 派生数据 ----
  const byDate = useMemo(() => {
    const map = new Map<string, StudyCourse[]>();
    for (const c of courses) {
      const list = map.get(c.date) ?? [];
      list.push(c);
      map.set(c.date, list);
    }
    for (const list of map.values()) list.sort(byDateTime);
    return map;
  }, [courses]);

  const t = todayStr();
  const hm = nowHM();
  const todays = byDate.get(t) ?? [];
  const plannedToday = todays.filter((c) => c.status === "planned");
  const overdue = courses.filter((c) => c.status === "planned" && c.date < t);
  const doneCount = courses.filter((c) => c.status === "done").length;
  const nowCourse =
    plannedToday.find((c) => c.timeStart && c.timeEnd && c.timeStart <= hm && hm <= c.timeEnd) ??
    plannedToday.find((c) => c.timeStart && !c.timeEnd && c.timeStart <= hm) ??
    plannedToday.find((c) => !c.timeStart);
  const nextCourse = courses
    .filter((c) => c.status === "planned" && (c.date > t || (c.date === t && c.timeStart && c.timeStart > hm)))
    .sort(byDateTime)[0];
  const selCourses = byDate.get(selDate) ?? [];
  const matName = (id: string) => materials.find((m) => m.id === id)?.name ?? id;

  const shiftMonth = (delta: number) => {
    setCursor(({ y, m }) => {
      const d = new Date(y, m - 1 + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() + 1 };
    });
  };

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 1100 }}>
        <div className="page-intro">
          <h2>学习计划</h2>
          <p>
            真实日期的课程表 · 没完成的课自动顺延到下一个空位 · 学完点「出题测验」，她出题她判分
            {saving && " · 保存中…"}
            {error && <span className="sys-err">（{error}）</span>}
          </p>
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
            <button
              className={`btn ghost sm${notifyOn ? " notify-on" : ""}`}
              onClick={() => void toggleNotify()}
              title="到点的课弹一条浏览器通知（只提醒设了时段的课；网页开着才有效）"
            >
              {notifyOn ? "🔔 到点弹窗：开" : "🔔 到点弹窗：关"}
            </button>
          </div>
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
              <div className="k">进度</div>
              <div className="v">
                {doneCount}/{courses.length} <small>学完</small>
              </div>
            </div>
          </div>
        </div>

        <div className="study-layout">
          {/* 月历 */}
          <div className="card study-cal">
            <div className="cal-nav">
              <button className="btn ghost sm" onClick={() => shiftMonth(-1)}>
                ‹
              </button>
              <b>
                {cursor.y} 年 {cursor.m} 月
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
                  今天
                </button>
                <button className="btn ghost sm" onClick={() => shiftMonth(1)}>
                  ›
                </button>
              </div>
            </div>
            <div className="cal-week">
              {WEEK.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <div className="cal-grid">
              {monthCells(cursor.y, cursor.m).map((cell) => {
                const cs = byDate.get(cell.date) ?? [];
                const hasLate = cs.some((c) => c.status === "planned" && cell.date < t);
                const show = cs.slice(0, 2);
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
                      {hasLate && <i className="late-dot" title="有逾期未完成的课" />}
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
                    {cs.length > 2 && <span className="cal-more">+{cs.length - 2}</span>}
                  </button>
                );
              })}
            </div>
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
                const mats = (c.materialIds ?? []).filter((id) => materials.some((m) => m.id === id));
                return (
                  <article key={c.id} className={`course-card ${c.status}${late ? " late" : ""}`}>
                    <div className="cc-head">
                      <b>{c.title}</b>
                      <span className="chip">{c.timeStart ? `${c.timeStart}${c.timeEnd ? `~${c.timeEnd}` : ""}` : "全天可学"}</span>
                      {c.status === "done" && <span className="chip green">✓ 学完</span>}
                      {late && <span className="chip warn">逾期</span>}
                      {(c.postponedCount ?? 0) > 0 && <span className="chip">顺延×{c.postponedCount}</span>}
                    </div>
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
                          <button className="btn sm" onClick={() => markDone(c)}>
                            ✅ 学完了
                          </button>
                          <button className="btn ghost sm" onClick={() => postpone(c)} title={`顺延到 ${nextFreeDate(courses, t)}`}>
                            ⏭ 没完成，顺延
                          </button>
                        </>
                      )}
                      {c.status === "done" && c.quiz?.status !== "done" && (
                        <button className="btn sm" onClick={() => setQuizId(quizId === c.id ? null : c.id)}>
                          📝 {c.quiz?.status === "pending" ? "出题测验" : "再考一次"}
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
                    {quizId === c.id && (
                      <StudyQuiz courseId={c.id} onClose={() => setQuizId(null)} onGraded={() => void load()} />
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
              🗓 让 Rana 排课 <small>她读上面的资料，把课排进日历（每天几节、哪天休息，写清楚）</small>
            </h3>
            <textarea
              className="set-input plan-req"
              placeholder="例：从明天开始，每天 2 节，晚上学，周日休息，10 月 1 号前学完"
              value={planReq}
              onChange={(e) => setPlanReq(e.target.value)}
            />
            <div className="cc-acts" style={{ marginTop: 8 }}>
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
