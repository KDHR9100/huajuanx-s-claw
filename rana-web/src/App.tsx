import { useEffect } from "react";
import { gateway } from "./lib/gateway";
import { useAppStore } from "./store/useAppStore";
import { applySettings } from "./lib/theme";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import ChatStream from "./components/ChatStream";
import Composer from "./components/Composer";
import UsagePanel from "./components/UsagePanel";
import SettingsModal from "./components/SettingsModal";

export default function App() {
  const connError = useAppStore((s) => s.connError);
  const panelOpen = useAppStore((s) => s.panelOpen);

  useEffect(() => {
    applySettings(useAppStore.getState().settings);
    void gateway.connect();
  }, []);

  return (
    <>
      <div className="bg-layer" aria-hidden />
      <div className={`app${panelOpen ? "" : " panel-closed"}`}>
        <Sidebar />
        <main className="main">
          <Topbar />
          {connError && <div className="err-banner">⚠ {connError}</div>}
          <ChatStream />
          <Composer />
        </main>
        {panelOpen && <UsagePanel />}
      </div>
      <SettingsModal />
    </>
  );
}
