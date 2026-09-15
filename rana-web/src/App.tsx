import { useEffect, type ReactNode } from "react";
import { gateway } from "./lib/gateway";
import { useAppStore } from "./store/useAppStore";
import { applySettings } from "./lib/theme";
import { startStudyNotifier } from "./lib/studyNotify";
import Room from "./components/Room";
import TopNav from "./components/TopNav";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import ChatStream from "./components/ChatStream";
import Composer from "./components/Composer";
import UsagePanel from "./components/UsagePanel";
import SysPage from "./components/SysPage";
import CronPage from "./components/CronPage";
import NewsPage from "./components/NewsPage";
import StudyPage from "./components/StudyPage";
import StudyGoalsPage from "./components/StudyGoalsPage";
import AppsPage from "./components/AppsPage";
import GroupsPage from "./components/GroupsPage";
import DshPage from "./components/DshPage";
import ErrorBoundary from "./components/ErrorBoundary";
import SettingsModal from "./components/SettingsModal";
import LmStudioModal from "./components/LmStudioModal";
import CloudConfigModal from "./components/CloudConfigModal";
import SystemCleanupModal from "./components/SystemCleanupModal";

// 页面级兜底：单页渲染崩了只挂那一页，导航与其余页面照常
const page = (label: string, node: ReactNode) => <ErrorBoundary label={label}>{node}</ErrorBoundary>;

export default function App() {
  const connError = useAppStore((s) => s.connError);
  const view = useAppStore((s) => s.view);
  const panelOpen = useAppStore((s) => s.panelOpen);

  useEffect(() => {
    applySettings(useAppStore.getState().settings);
    void gateway.connect();
  }, []);

  // 学习计划到点弹窗提醒：开哪个页面都有效（权限/开关在课程表页控制）
  useEffect(() => startStudyNotifier(), []);

  return (
    <>
      {/* 自定义背景图层（用户上传背景图时显示；同时房间场景让位） */}
      <div className="bg-layer" aria-hidden />
      {/* 她的房间背景层（设置自定义背景图时让位） */}
      <Room />
      <div className="shell">
        <TopNav />
        <div className="pages">
          {view === "chat" && (
            <div className={`app${panelOpen ? "" : " panel-closed"}`}>
              <Sidebar />
              <main className="main">
                <Topbar />
                {connError && <div className="err-banner">⚠ {connError}</div>}
                {page("会话", <><ChatStream /><Composer /></>)}
              </main>
              {panelOpen && <UsagePanel />}
            </div>
          )}
          {view === "sys" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              {page("Rana 的状态", <SysPage />)}
            </main>
          )}
          {view === "cron" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              {page("定时任务", <CronPage />)}
            </main>
          )}
          {view === "news" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              {page("早报", <NewsPage />)}
            </main>
          )}
          {view === "study" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              {page("学习计划", <StudyPage />)}
            </main>
          )}
          {view === "goals" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              {page("待办", <StudyGoalsPage />)}
            </main>
          )}
          {view === "apps" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              {page("程序", <AppsPage />)}
            </main>
          )}
          {view === "groups" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              {page("群画像", <GroupsPage />)}
            </main>
          )}
          {view === "dsh" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              {page("派活", <DshPage />)}
            </main>
          )}
        </div>
      </div>
      <SettingsModal />
      <LmStudioModal />
      <CloudConfigModal />
      <SystemCleanupModal />
    </>
  );
}
