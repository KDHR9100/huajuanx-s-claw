// 学习计划的答题面板 v2：三种模式共用一套流程——
// 日常测验（某节课）/ 错题重考（针对薄弱点）/ 期末考（整计划大卷）。
// 出题和判分都真的过 Rana（专用会话 + study-quiz skill）；选项在页面侧打乱显示（防背位置），
// 判分按选项内容不按位置，所以乱序不影响判卷。
import { useMemo, useState } from "react";

export interface QuizQuestion {
  idx: number;
  type: "choice" | "short";
  q: string;
  options?: string[];
  targetMistake?: string;
}
interface QuizVerdict {
  idx: number;
  correct: boolean | string;
  review?: string;
}
interface GradeResult {
  score: number;
  comment?: string;
  verdicts?: QuizVerdict[];
}

/** 三种出题模式：判分参数不一样，其余流程完全一致 */
export type QuizMode =
  | { kind: "course"; courseId: string; title: string }
  | { kind: "drill"; mistakeIds: string[]; title: string }
  | { kind: "final"; planId: string; title: string };

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const MODE_LABEL = { course: "测验", drill: "错题重考", final: "期末考" } as const;

function VerdictMark({ correct }: { correct: boolean | string }) {
  if (correct === true) return <span className="ok">✓ 对</span>;
  if (correct === "partial") return <span className="half">◐ 半对</span>;
  return <span className="bad">✗ 不对</span>;
}

/** Fisher-Yates 洗牌（选项乱序用） */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function StudyQuiz({
  mode,
  model,
  onClose,
  onGraded,
}: {
  mode: QuizMode;
  model?: string;
  onClose: () => void;
  onGraded: () => void;
}) {
  const [phase, setPhase] = useState<"gen" | "answer" | "grading" | "result">("gen");
  const [req, setReq] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [result, setResult] = useState<GradeResult | null>(null);

  const gen = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const payload =
        mode.kind === "course"
          ? { courseId: mode.courseId, requirements: req, ...(model ? { model } : {}) }
          : mode.kind === "drill"
            ? { mistakeIds: mode.mistakeIds, ...(model ? { model } : {}) }
            : { planId: mode.planId, final: true, ...(model ? { model } : {}) };
      const r = await fetch("/__rana/study/quiz-gen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await r.json()) as { ok?: boolean; questions?: QuizQuestion[]; error?: string };
      if (!r.ok || !j.ok || !j.questions?.length) throw new Error(j.error ?? `HTTP ${r.status}`);
      // 选择题选项当场打乱（重考同一课时顺序不一样，防背位置）
      setQuestions(
        j.questions.map((q) => (q.type === "choice" && q.options?.length ? { ...q, options: shuffle(q.options) } : q)),
      );
      setAnswers({});
      setPhase("answer");
    } catch (e) {
      setError(`出题失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (questions.some((q) => !(answers[q.idx] ?? "").trim())) {
      setError("还有题没答完。");
      return;
    }
    setPhase("grading");
    setError("");
    try {
      const payload =
        mode.kind === "course"
          ? { courseId: mode.courseId, questions, answers: toAnswerArray(), ...(model ? { model } : {}) }
          : mode.kind === "drill"
            ? { drill: true, questions, answers: toAnswerArray(), ...(model ? { model } : {}) }
            : { forPlanId: mode.planId, questions, answers: toAnswerArray(), ...(model ? { model } : {}) };
      const r = await fetch("/__rana/study/quiz-grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await r.json()) as { ok?: boolean; verdict?: GradeResult; error?: string };
      if (!r.ok || !j.ok || !j.verdict) throw new Error(j.error ?? `HTTP ${r.status}`);
      setResult(j.verdict);
      setPhase("result");
      onGraded();
    } catch (e) {
      setError(`判分失败：${(e as Error).message}`);
      setPhase("answer");
    }
  };

  const toAnswerArray = () => questions.map((q) => ({ idx: q.idx, answer: answers[q.idx] ?? "" }));

  const restart = () => {
    setQuestions([]);
    setAnswers({});
    setResult(null);
    setPhase("gen");
  };

  const genHint = useMemo(() => {
    if (mode.kind === "drill") return "她会针对你错过的点出新题（换角度问，不是原题复读），答对的自动销账。";
    if (mode.kind === "final") return "综合这个计划全部资料的 10 题大卷，判分严一点。";
    return "她会按这节课挂的资料出题（默认 3~5 题，选择+简答），错过的点多出。";
  }, [mode.kind]);

  return (
    <div className="quiz-panel">
      <div className="quiz-mode-tag">{MODE_LABEL[mode.kind]} · {mode.title}</div>

      {phase === "gen" && (
        <div className="quiz-gen">
          <p className="tune-hint">{genHint}</p>
          {mode.kind === "course" && (
            <input
              className="set-input"
              placeholder="附加要求（可选）：只出选择题 / 出10道 / 出难点的…"
              value={req}
              onChange={(e) => setReq(e.target.value)}
            />
          )}
          <div className="cc-acts" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => void gen()} disabled={busy}>
              {busy
                ? mode.kind === "final"
                  ? "她在出大卷……"
                  : "她在翻资料出题……"
                : mode.kind === "drill"
                  ? "🔁 再考错题"
                  : mode.kind === "final"
                    ? "📝 开始期末考"
                    : "📝 开始出题"}
            </button>
            <button className="btn ghost sm" onClick={onClose}>
              收起
            </button>
          </div>
        </div>
      )}

      {phase === "answer" && (
        <div className="quiz-body">
          {questions.map((q) => (
            <div key={q.idx} className="quiz-q">
              <div className="qq-head">
                第{q.idx}题 · {q.type === "choice" ? "选择" : "简答"}
                {q.targetMistake && <span className="qq-tag">错题重考</span>}
              </div>
              <p className="qq-text">{q.q}</p>
              {q.type === "choice" ? (
                (q.options ?? []).map((opt, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`quiz-opt${answers[q.idx] === opt ? " sel" : ""}`}
                    onClick={() => setAnswers((a) => ({ ...a, [q.idx]: opt }))}
                  >
                    <span className="ol">{LETTERS[i] ?? "?"}.</span>
                    <span>{opt}</span>
                  </button>
                ))
              ) : (
                <textarea
                  className="quiz-short"
                  placeholder="用自己的话答，别背原文…"
                  value={answers[q.idx] ?? ""}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.idx]: e.target.value }))}
                />
              )}
            </div>
          ))}
          <div className="cc-acts">
            <button className="btn sm" onClick={() => void submit()}>
              交卷，让她判分
            </button>
            <button className="btn ghost sm" onClick={restart}>
              重新出题
            </button>
          </div>
        </div>
      )}

      {phase === "grading" && <p className="pending-text">……她在改卷。简答题要一题一题看，稍等。</p>}

      {phase === "result" && result && (
        <div className="quiz-result">
          <div className="quiz-score">
            <b>{result.score}</b>
            <span className="tune-hint">分</span>
          </div>
          {result.comment && <p className="plan-result">「{result.comment}」</p>}
          {(result.verdicts ?? []).map((v) => {
            const q = questions.find((x) => x.idx === v.idx);
            return (
              <div key={v.idx} className="quiz-verdict">
                <div className="qv-head">
                  第{v.idx}题 <VerdictMark correct={v.correct} />
                </div>
                {q && <div className="qv-q">{q.q}</div>}
                {v.review && <div className="qv-review">{v.review}</div>}
              </div>
            );
          })}
          <p className="tune-hint">答错/半对的题已收进错题本，可以过几天再考。</p>
          <div className="cc-acts" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={restart}>
              再来一套
            </button>
            <button className="btn ghost sm" onClick={onClose}>
              完事了
            </button>
          </div>
        </div>
      )}

      {error && <p className="sys-err" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}
