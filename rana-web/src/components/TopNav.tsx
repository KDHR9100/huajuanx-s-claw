// 顶部导航：品牌（铃铛+Rana+异色瞳双色点）、页面页签、连接状态、设置、昼夜切换
import { useAppStore } from "../store/useAppStore";
import type { AppView } from "../lib/types";
import { Bell } from "./RanaArt";

const TABS: Array<{ id: AppView; label: string }> = [
  { id: "chat", label: "💬 会话" },
  { id: "sys", label: "🖥️ 电脑状态" },
  { id: "cron", label: "⏰ 定时任务" },
];

export default function TopNav() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const conn = useAppStore((s) => s.conn);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const dot = conn === "connected" ? "ok" : conn === "connecting" ? "wait" : "err";

  return (
    <header className="topnav">
      <div className="brand" title="Rana · 要乐奈">
        <span className="brand-bell">
          <Bell size={24} />
        </span>
        Rana
        <span className="twin" title="异色瞳：左蓝右黄">
          <i />
          <i />
        </span>
      </div>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab${view === t.id ? " on" : ""}`} onClick={() => setView(t.id)}>
            {t.label}
          </button>
        ))}
        <button className="tab plus" disabled title="以后再加点什么…">
          ✚
        </button>
      </nav>
      <div className="nav-right">
        <span className={`conn-dot ${dot}`} title={`gateway ${conn}`} />
        <button className="nav-btn" title="外观设置" onClick={() => setSettingsOpen(true)}>
          🎨
        </button>
        <button
          className="nav-btn"
          title={settings.mode === "dark" ? "切到白天" : "切到夜间"}
          onClick={() => updateSettings({ mode: settings.mode === "dark" ? "light" : "dark" })}
        >
          {settings.mode === "dark" ? "☀️" : "🌙"}
        </button>
      </div>
    </header>
  );
}
