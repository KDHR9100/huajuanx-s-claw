// 「🗺 规划」页：日历 + 学习计划 + 待办 + 人生目标总览 + 内容库 五合一。
// 页内五个子页签（总览/日历/课表/待办/内容库）条件渲染——切走即卸载、切回重拉数据，
// 课表和待办是旧页整个搬进来（embedded 模式，逻辑零改动）；日历是全局日程（工作包 B）。
// 子页签状态在 useAppStore（持久化），总览里的「去看日历/课表/待办」链接能直接切过去。
import { useAppStore } from "../store/useAppStore";
import type { PlanningTab } from "../lib/types";
import PlanningOverview from "./PlanningOverview";
import PlanningLibrary from "./PlanningLibrary";
import CalendarPage from "./CalendarPage";
import StudyPage from "./StudyPage";
import StudyGoalsPage from "./StudyGoalsPage";

const TABS: Array<{ id: PlanningTab; label: string }> = [
  { id: "overview", label: "🎯 总览" },
  { id: "calendar", label: "📅 日历" },
  { id: "schedule", label: "📖 课表" },
  { id: "goals", label: "📝 待办" },
  { id: "library", label: "📚 内容库" },
];

export default function PlanningPage() {
  const tab = useAppStore((s) => s.planningTab);
  const setTab = useAppStore((s) => s.setPlanningTab);

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 1100 }}>
        <div className="page-intro">
          <h2>规划</h2>
          <p>人生目标 → 每月里程碑 → 待办 → 每天的课 · 一条链落实到底</p>
        </div>

        <nav className="apps-nav plan-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`chip big${tab === t.id ? " green" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === "overview" && <PlanningOverview />}
        {tab === "calendar" && <CalendarPage />}
        {tab === "schedule" && <StudyPage embedded />}
        {tab === "goals" && <StudyGoalsPage embedded />}
        {tab === "library" && <PlanningLibrary />}
      </div>
    </div>
  );
}
