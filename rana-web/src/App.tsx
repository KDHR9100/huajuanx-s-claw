import { useEffect } from "react";
import { gateway } from "./lib/gateway";
import { useAppStore } from "./store/useAppStore";
import { applySettings } from "./lib/theme";
import Room from "./components/Room";
import TopNav from "./components/TopNav";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import ChatStream from "./components/ChatStream";
import Composer from "./components/Composer";
import SysPage from "./components/SysPage";
import CronPage from "./components/CronPage";
import NewsPage from "./components/NewsPage";
import SettingsModal from "./components/SettingsModal";
import LmStudioModal from "./components/LmStudioModal";
import CloudConfigModal from "./components/CloudConfigModal";

export default function App() {
  const connError = useAppStore((s) => s.connError);
  const view = useAppStore((s) => s.view);

  useEffect(() => {
    applySettings(useAppStore.getState().settings);
    void gateway.connect();
  }, []);

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
            <div className="app">
              <Sidebar />
              <main className="main">
                <Topbar />
                {connError && <div className="err-banner">⚠ {connError}</div>}
                <ChatStream />
                <Composer />
              </main>
            </div>
          )}
          {view === "sys" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              <SysPage />
            </main>
          )}
          {view === "cron" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              <CronPage />
            </main>
          )}
          {view === "news" && (
            <main className="main">
              {connError && <div className="err-banner">⚠ {connError}</div>}
              <NewsPage />
            </main>
          )}
        </div>
      </div>
      <SettingsModal />
      <LmStudioModal />
      <CloudConfigModal />
    </>
  );
}
