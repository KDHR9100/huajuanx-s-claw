// 「开始今天的课」勾选面板（2026-11-06 第二波⑥号，照 StudyQuiz 先例从 StudyPage 拆出）。
// 勾选上下文偏好 + 发课请求都归本组件自持；StudyPage 只保留 lessonOpen 开关与入口按钮。
import { useState } from "react";
import type { StudyCourse } from "./StudyPage";

const LESSON_CTX_KEY = "study.lessonCtx.v1";
type LessonHistory = "none" | "tail5" | "all";
interface LessonCtx {
  history: LessonHistory;
  schedule: boolean;
  materials: boolean;
  mistakes: boolean;
  reports: boolean;
  contract: boolean;
}

const DEFAULT_LESSON_CTX: LessonCtx = {
  history: "tail5", // 只带最近 5 轮对话（治上下文爆炸的默认值）
  schedule: true,
  materials: false,
  mistakes: false,
  reports: false,
  contract: false,
};
const loadLessonCtx = (): LessonCtx => {
  try {
    const raw = JSON.parse(localStorage.getItem(LESSON_CTX_KEY) ?? "{}") as Partial<LessonCtx>;
    return { ...DEFAULT_LESSON_CTX, ...raw };
  } catch {
    return { ...DEFAULT_LESSON_CTX };
  }
};

export default function LessonPanel({ open, plannedToday, pickModel }: {
  open: boolean;
  plannedToday: StudyCourse[];
  pickModel: string;
}) {
  const [lessonCtx, setLessonCtx] = useState<LessonCtx>(loadLessonCtx);
  const [lessonBusy, setLessonBusy] = useState(false);
  const [lessonReply, setLessonReply] = useState("");
  const setCtx = (patch: Partial<LessonCtx>) =>
    setLessonCtx((c) => {
      const next = { ...c, ...patch };
      try {
        localStorage.setItem(LESSON_CTX_KEY, JSON.stringify(next));
      } catch {
        /* 存不进就算了 */
      }
      return next;
    });

  const startLesson = async () => {
    if (lessonBusy) return;
    setLessonBusy(true);
    setLessonReply("");
    try {
      const r = await fetch("/__rana/study/lesson-start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ context: lessonCtx, ...(pickModel ? { model: pickModel } : {}) }),
      });
      const j = (await r.json()) as { ok?: boolean; reply?: string; error?: string };
      setLessonReply(j.ok ? j.reply ?? "（她没说话）" : j.error ?? "她没回话。");
    } catch (e) {
      setLessonReply(`发起失败：${(e as Error).message}`);
    } finally {
      setLessonBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="lesson-ctx">
      <div className="lesson-ctx-head">
        带给她的上下文（勾什么发什么，不勾不发，发给云端模型的内容就这么多）
      </div>
      <div className="lesson-ctx-row">
        <span className="k">历史对话</span>
        {([
          ["tail5", "只带最近5轮"],
          ["none", "不带（干净会话）"],
          ["all", "全部"],
        ] as Array<[LessonHistory, string]>).map(([v, label]) => (
          <label key={v} className="chip-btn">
            <input
              type="radio"
              name="lesson-history"
              checked={lessonCtx.history === v}
              onChange={() => setCtx({ history: v })}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="lesson-ctx-row">
        {([
          ["schedule", "课程表"],
          ["materials", "资料路径"],
          ["mistakes", "错题本"],
          ["reports", "周报"],
          ["contract", "学习契约"],
        ] as Array<[keyof LessonCtx, string]>).map(([k, label]) => (
          <label key={String(k)} className="chip-btn" title={k === "materials" ? "勾上才给资料文件路径（她想读时自己去读）；不勾只给文件名" : undefined}>
            <input
              type="checkbox"
              checked={Boolean(lessonCtx[k])}
              onChange={(e) => setCtx({ [k]: e.target.checked } as Partial<LessonCtx>)}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="lesson-ctx-row">
        <button className="btn green sm" onClick={() => void startLesson()} disabled={lessonBusy || !plannedToday.length}>
          {lessonBusy ? "她在准备……" : plannedToday.length ? "开始" : "今天没课"}
        </button>
        {lessonReply && <p className="plan-result lesson-reply">{lessonReply}</p>}
      </div>
    </div>
  );
}
