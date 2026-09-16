// 待办页：写大方向学习目标 → 让Rana拆解（study-goal skill，她只出方案不改文件）→ 确认后一键排进学习计划课程表。
// 数据在 .study/goals.json（与课程表分开存）；排入走 /__rana/study/goals/push：
// 服务端统一生成课程 id、挂默认计划、拆解后已过期的日期自动顺延到明天起第一个没课的日子。
import { useCallback, useEffect, useState } from "react";

export interface GoalPlanCourse {
  title: string;
  date: string;
  timeStart?: string;
  timeEnd?: string;
  estMin?: number;
  note?: string;
}
export interface StudyGoal {
  id: string;
  text: string;
  createdAt: number;
  status: "open" | "planned";
  plan?: { analysis: string; summary: string; courses: GoalPlanCourse[] } | null;
  pushedCourseIds?: string[];
  pushedAt?: number;
  /** 从规划页里程碑转来时带的归属（未知字段原样保留，旧数据没有） */
  lifeGoalId?: string;
  milestoneId?: string;
}
interface GoalsFile {
  version: number;
  goals: StudyGoal[];
  updatedAt: number;
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const weekdayOf = (ds: string) => {
  const [y, m, d] = ds.split("-").map(Number);
  return WEEK[new Date(y, m - 1, d).getDay()] ?? "";
};
const fmtTs = (ts: number) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
/** 拆解/排入用的模型：沿用学习计划页排课框的偏好（""=跟随专用会话当前模型） */
const modelPref = () => localStorage.getItem("study.model.v1") || undefined;

/** open 在前（新的在前），planned 沉底（新排的在前） */
const sortGoals = (a: StudyGoal, b: StudyGoal) => {
  if (a.status !== b.status) return a.status === "open" ? -1 : 1;
  return b.createdAt - a.createdAt;
};

/** embedded：作为「🗺 规划」页的子页渲染时为 true——去掉自带的外层滚动壳，逻辑零改动 */
export default function StudyGoalsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [goals, setGoals] = useState<StudyGoal[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/__rana/study/goals");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as GoalsFile;
      setGoals([...j.goals].sort(sortGoals));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (adding) return;
    setAdding(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/__rana/study/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setText("");
      await load();
    } catch (e) {
      setError(`没记上：${(e as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  const patchGoal = (next: StudyGoal) =>
    setGoals((list) => list.map((g) => (g.id === next.id ? next : g)).sort(sortGoals));

  const parse = async (goal: StudyGoal) => {
    if (parsingId) return;
    setParsingId(goal.id);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/__rana/study/goals/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goalId: goal.id, model: modelPref() }),
      });
      const j = (await r.json()) as { ok?: boolean; goal?: StudyGoal; error?: string };
      if (!r.ok || !j.ok || !j.goal) throw new Error(j.error ?? `HTTP ${r.status}`);
      patchGoal(j.goal);
      setFolded((s) => {
        const n = new Set(s);
        n.delete(goal.id);
        return n;
      });
    } catch (e) {
      setError(`拆解失败：${(e as Error).message}`);
    } finally {
      setParsingId(null);
    }
  };

  const push = async (goal: StudyGoal) => {
    if (pushingId) return;
    setPushingId(goal.id);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/__rana/study/goals/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goalId: goal.id }),
      });
      const j = (await r.json()) as { ok?: boolean; added?: number; shifted?: number; goals?: GoalsFile; error?: string };
      if (!r.ok || !j.ok || !j.goals) throw new Error(j.error ?? `HTTP ${r.status}`);
      setGoals([...j.goals.goals].sort(sortGoals));
      setNotice(
        `已把「${goal.text.slice(0, 16)}${goal.text.length > 16 ? "…" : ""}」的 ${j.added ?? 0} 节课排进课表` +
          (j.shifted ? `（${j.shifted} 节过期日期自动顺延）` : "") +
          "，去「📅 课表」看日程。",
      );
    } catch (e) {
      setError(`排入失败：${(e as Error).message}`);
    } finally {
      setPushingId(null);
    }
  };

  const del = async (goal: StudyGoal) => {
    const msg =
      goal.status === "planned"
        ? `删掉这条已排的待办？已排进课程表的课不受影响，还在学习计划里。`
        : `删掉「${goal.text.slice(0, 20)}${goal.text.length > 20 ? "…" : ""}」？`;
    if (!window.confirm(msg)) return;
    try {
      const r = await fetch(`/__rana/study/goals?id=${encodeURIComponent(goal.id)}`, { method: "DELETE" });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setGoals((list) => list.filter((g) => g.id !== goal.id));
    } catch (e) {
      setError(`删除失败：${(e as Error).message}`);
    }
  };

  const toggleFold = (id: string) =>
    setFolded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const openCount = goals.filter((g) => g.status === "open").length;

  const content = (
    <>
      <div className="page-intro">
        <h2>待办</h2>
          <p>
            大方向记这儿，她拆成具体的课，你点头才进课程表
            {goals.length > 0 && ` · 待拆 ${openCount} 条`}
            {error && <span className="sys-err">（{error}）</span>}
          </p>
        </div>

        {notice && <div className="set-ok" style={{ marginBottom: 14 }}>{notice}</div>}

        {/* 写下大方向 */}
        <div className="card goal-input" style={{ marginBottom: 16 }}>
          <textarea
            className="set-input goal-textarea"
            placeholder="写个大方向，比如：想转行做后端，把数据库和网络基础补扎实 / 想看懂经典的机器学习算法"
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="cc-acts">
            <button className="btn sm" onClick={() => void add()} disabled={adding || !text.trim()}>
              {adding ? "记下了…" : "✏️ 记下这条"}
            </button>
            <span className="tune-hint">先记着就行，想拆的时候点卡片上的「让Rana拆解」</span>
          </div>
        </div>

        {/* 待办卡片 */}
        {goals.length === 0 && (
          <div className="card pending">
            <p className="pending-text">还没有待办。上面写一条大方向，剩下的交给她。</p>
          </div>
        )}
        {goals.map((goal) => {
          const busyParsing = parsingId === goal.id;
          const busyPushing = pushingId === goal.id;
          const plan = goal.plan;
          const foldedPlan = folded.has(goal.id);
          return (
            <article key={goal.id} className={`card goal-card${goal.status === "planned" ? " done" : ""}`}>
              <div className="gc-head">
                <span className={`chip${goal.status === "planned" ? " green" : ""}`}>
                  {goal.status === "planned" ? "✅ 已排进课程表" : "⏳ 待拆解"}
                </span>
                {goal.lifeGoalId && (
                  <span className="chip" title="从规划页的人生目标里程碑转来的">
                    🗺 人生目标
                  </span>
                )}
                <p className="gc-text">{goal.text}</p>
                <button className="btn ghost sm" onClick={() => void del(goal)} title="删除这条待办">
                  🗑
                </button>
              </div>
              <div className="gc-meta">记于 {fmtTs(goal.createdAt)}</div>

              {goal.status === "planned" && (
                <div className="gc-planned">
                  已排 {goal.pushedCourseIds?.length ?? 0} 节 · {goal.pushedAt ? fmtTs(goal.pushedAt) : ""}
                  ｜课程在「📅 课表」，学没学、顺延都在那边操作
                </div>
              )}

              {goal.status === "open" && !plan && (
                <div className="cc-acts">
                  <button className="btn sm" onClick={() => void parse(goal)} disabled={busyParsing || parsingId !== null}>
                    {busyParsing ? "她在结合你的情况想……（可能一两分钟）" : "🔍 让Rana拆解"}
                  </button>
                </div>
              )}

              {goal.status === "open" && plan && (
                <div className="gc-plan">
                  {foldedPlan ? (
                    <div className="cc-acts">
                      <button className="btn ghost sm" onClick={() => toggleFold(goal.id)}>
                        📋 展开方案（{plan.courses.length} 节）
                      </button>
                    </div>
                  ) : (
                    <>
                      {plan.analysis && <p className="gc-analysis">「{plan.analysis}」</p>}
                      <div className="gc-courses">
                        {plan.courses.map((c, i) => (
                          <div key={i} className="gc-course">
                            <span className="gc-date">
                              {c.date.slice(5)} {weekdayOf(c.date)}
                              {c.timeStart ? ` ${c.timeStart}${c.timeEnd ? `~${c.timeEnd}` : ""}` : ""}
                            </span>
                            <span className="gc-title">
                              {c.title}
                              {c.estMin ? <small>（约 {c.estMin} 分钟）</small> : null}
                              {c.note && <small className="gc-note">{c.note}</small>}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="cc-acts">
                        <button className="btn sm" onClick={() => void push(goal)} disabled={busyPushing || pushingId !== null}>
                          {busyPushing ? "排入中…" : `📚 全部排进学习计划（${plan.courses.length} 节）`}
                        </button>
                        <button className="btn ghost sm" onClick={() => void parse(goal)} disabled={parsingId !== null}>
                          🔄 重新拆解
                        </button>
                        <button className="btn ghost sm" onClick={() => toggleFold(goal.id)}>
                          收起
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}
    </>
  );
  // 嵌入「🗺 规划」页：吐内容并保持原本的 900 宽度；独立渲染时保留原滚动壳
  if (embedded) {
    return <div className="board-inner" style={{ maxWidth: 900 }}>{content}</div>;
  }
  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 900 }}>{content}</div>
    </div>
  );
}
