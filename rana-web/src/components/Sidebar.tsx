import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";

function fmtTime(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function fmtTokens(n?: number) {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 服务端禁止删除的会话：global 与 agent 主会话（isMain），删除会被 gateway 拒绝 */
const isProtectedSession = (key: string, isMain?: boolean) => isMain === true || key === "global";

export default function Sidebar() {
  const sessions = useAppStore((s) => s.sessions);
  const currentKey = useAppStore((s) => s.currentKey);
  const setCurrentKey = useAppStore((s) => s.setCurrentKey);
  const runs = useAppStore((s) => s.runs);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const pick = (key: string) => {
    if (key === currentKey) return;
    setCurrentKey(key);
    void gateway.loadHistory(key);
  };

  const newSession = () => {
    void gateway.createSession().catch((e) => console.warn("新建会话失败:", e));
  };

  const deleteSession = (key: string, title: string, active: boolean) => {
    if (!window.confirm(`确定删除会话「${title}」吗？删除后不可恢复。`)) return;
    void gateway.deleteSession(key).catch((e) => {
      console.warn("删除会话失败:", e);
      // 失败时刷新列表，纠正乐观状态
      void gateway.refreshSessions();
      window.alert(`删除会话失败：${(e as Error).message}`);
    });
    void active;
  };

  return (
    <aside className="sidebar">
      <div className="brand">Rana ✿</div>
      <button className="btn" onClick={newSession} disabled={sessions.some((s) => s.key === currentKey && s.hasActiveRun)}>
        ＋ 新会话
      </button>
      <div className="session-list">
        {sessions.map((s) => (
          <div
            key={s.key}
            className={`session-item${s.key === currentKey ? " active" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => pick(s.key)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pick(s.key)}
          >
            <div className="s-main">
              <span className="s-title">
                {s.hasActiveRun || runs[s.key] ? "⏳ " : ""}
                {s.title}
              </span>
              {!isProtectedSession(s.key, s.isMain) && (
                <button
                  className="s-delete"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSession(s.key, s.title ?? s.key, Boolean(runs[s.key]));
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            <span className="s-meta">
              {s.updatedAt ? <span>{fmtTime(s.updatedAt)}</span> : null}
              {s.totalTokens ? <span>{fmtTokens(s.totalTokens)} tok</span> : null}
              {s.model ? <span>{s.model.split("/").pop()}</span> : null}
            </span>
          </div>
        ))}
        {sessions.length === 0 && <div className="s-meta" style={{ padding: "8px 10px" }}>暂无会话</div>}
      </div>
      <button className="btn ghost" onClick={() => setSettingsOpen(true)}>
        ⚙ 外观设置
      </button>
    </aside>
  );
}
