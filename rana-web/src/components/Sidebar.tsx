import { useEffect, useMemo, useRef, useState } from "react";
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

interface CtxMenuState {
  key: string;
  title: string;
  x: number;
  y: number;
}

export default function Sidebar() {
  const sessions = useAppStore((s) => s.sessions);
  const pinned = useAppStore((s) => s.pinned);
  const togglePin = useAppStore((s) => s.togglePin);
  const currentKey = useAppStore((s) => s.currentKey);
  const setCurrentKey = useAppStore((s) => s.setCurrentKey);
  const runs = useAppStore((s) => s.runs);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<CtxMenuState | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

  // 置顶的会话固定排在最前（按置顶先后），其余保持服务端顺序
  const ordered = useMemo(() => {
    const rank = (k: string) => {
      const i = pinned.indexOf(k);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...sessions].sort((a, b) => rank(a.key) - rank(b.key));
  }, [sessions, pinned]);

  // 右键菜单：点击任意处 / 窗口失焦 / Esc 关闭
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (renamingKey) renameRef.current?.select();
  }, [renamingKey]);

  const pick = (key: string) => {
    if (key === currentKey) return;
    setCurrentKey(key);
    void gateway.loadHistory(key);
  };

  const newSession = () => {
    if (creating) return;
    setCreating(true);
    void gateway
      .createSession()
      .catch((e) => console.warn("新建会话失败:", e))
      .finally(() => setCreating(false));
  };

  const openMenu = (e: React.MouseEvent, key: string, title: string) => {
    if (key.startsWith("pending-create:")) return; // 创建中的会话暂不可操作
    e.preventDefault();
    setMenu({ key, title, x: e.clientX, y: e.clientY });
  };

  const startRename = () => {
    if (!menu) return;
    setRenamingKey(menu.key);
    setRenameValue(menu.title);
    setMenu(null);
  };

  const commitRename = async () => {
    const key = renamingKey;
    setRenamingKey(null);
    if (!key) return;
    const next = renameValue.trim();
    const current = useAppStore.getState().sessions.find((x) => x.key === key)?.title ?? "";
    if (!next || next === current) return;
    try {
      await gateway.renameSession(key, next);
    } catch (e) {
      window.alert(`重命名失败：${(e as Error).message}`);
    }
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
      <button className="btn" onClick={newSession} disabled={creating || sessions.some((s) => s.key === currentKey && s.hasActiveRun)}>
        {creating ? "创建中…" : "＋ 新会话"}
      </button>
      <div className="session-list">
        {ordered.map((s) => (
          <div
            key={s.key}
            className={`session-item${s.key === currentKey ? " active" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => pick(s.key)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && pick(s.key)}
            onContextMenu={(e) => openMenu(e, s.key, s.title ?? s.key)}
          >
            <div className="s-main">
              {pinned.includes(s.key) && (
                <span className="s-pin" title="已置顶">
                  📌
                </span>
              )}
              {renamingKey === s.key ? (
                <input
                  ref={renameRef}
                  className="s-rename"
                  value={renameValue}
                  maxLength={100}
                  placeholder="会话名称"
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") void commitRename();
                    if (e.key === "Escape") setRenamingKey(null);
                  }}
                />
              ) : (
                <span className="s-title">
                  {s.hasActiveRun || runs[s.key] ? "⏳ " : ""}
                  {s.title}
                </span>
              )}
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
      {menu && (
        <div
          className="ctx-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 150),
            top: Math.min(menu.y, window.innerHeight - 100),
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button className="ctx-item" onClick={startRename}>
            ✏️ 重命名
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              togglePin(menu.key);
              setMenu(null);
            }}
          >
            📌 {pinned.includes(menu.key) ? "取消置顶" : "置顶"}
          </button>
        </div>
      )}
    </aside>
  );
}
