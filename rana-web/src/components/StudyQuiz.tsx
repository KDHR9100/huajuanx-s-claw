// 学习计划的答题面板：出题（quiz-gen 唤醒 Rana 按 study-quiz skill 出题）→ 逐题作答 →
// 交卷判分（quiz-grade，成绩由中间件写回课程表）→ 展示分数与她的点评。
import { useState } from "react";

export interface QuizQuestion {
  idx: number;
  type: "choice" | "short";
  q: string;
  options?: string[];
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

const LETTERS = ["A", "B", "C", "D", "E", "F"];

function VerdictMark({ correct }: { correct: boolean | string }) {
  if (correct === true) return <span className="ok">✓ 对</span>;
  if (correct === "partial") return <span className="half">◐ 半对</span>;
  return <span className="bad">✗ 不对</span>;
}

export default function StudyQuiz({
  courseId,
  onClose,
  onGraded,
}: {
  courseId: string;
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
      const r = await fetch("/__rana/study/quiz-gen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courseId, requirements: req }),
      });
      const j = (await r.json()) as { ok?: boolean; questions?: QuizQuestion[]; error?: string };
      if (!r.ok || !j.ok || !j.questions?.length) throw new Error(j.error ?? `HTTP ${r.status}`);
      setQuestions(j.questions);
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
      const r = await fetch("/__rana/study/quiz-grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          courseId,
          questions,
          answers: questions.map((q) => ({ idx: q.idx, answer: answers[q.idx] ?? "" })),
        }),
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

  const restart = () => {
    setQuestions([]);
    setAnswers({});
    setResult(null);
    setPhase("gen");
  };

  return (
    <div className="quiz-panel">
      {phase === "gen" && (
        <div className="quiz-gen">
          <p className="tune-hint">她会按这节课挂的资料出题（默认 3~5 题，选择+简答）。</p>
          <input
            className="set-input"
            placeholder="附加要求（可选）：只出选择题 / 出10道 / 出难点的…"
            value={req}
            onChange={(e) => setReq(e.target.value)}
          />
          <div className="cc-acts" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => void gen()} disabled={busy}>
              {busy ? "她在翻资料出题……" : "📝 开始出题"}
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
          <div className="cc-acts" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={restart}>
              再考一套
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
