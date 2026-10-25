// 记忆浏览页：读/改 Rana 的记忆与人设文件（三组：工作体 / RP 体 / 私密层）。
// 数据来自 /__rana/memory（白名单制：前端只传 key，key→路径映射在服务端，不接受传路径）。
// 私密组 danger=true：进入和保存各有一次确认；内容仅本地 UI 展示。
// 机器维护文件（MEMORY.md/共享纪要/巡检状态等）服务端标记 editable=false，保存会被 400 拒绝。
// 2026-10-25 迁移批1 加「☁️ 云端同步」卡：家里(win32)=拉取按钮+上次拉取；云端(linux)=家里最后拉取时间。
import { useCallback, useEffect, useState } from "react";
import { HOST_IS_WINDOWS } from "../lib/platform";

interface MemFile {
  key: string;
  name: string;
  editable: boolean;
  deletable: boolean;
  danger: boolean;
  size: number;
  mtime: number;
}
interface MemGroup {
  id: string;
  label: string;
  danger: boolean;
  files: MemFile[];
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const fmtAgo = (ts: number) => {
  const min = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (min < 60) return `${min} 分钟前`;
  if (min < 60 * 24) return `${Math.round(min / 60)} 小时前`;
  return `${Math.floor(min / 60 / 24)} 天前`;
};

interface SyncState {
  platform?: string;
  pulling?: boolean;
  error?: string | null;
  log?: string[];
  local?: { lastPullAt?: number; file?: string; bytes?: number } | null;
  cloud?: { lastPullAt?: number; totalBytes?: number } | null;
}

/** ☁️ 云端同步卡：家里(win32)=「现在拉取」按钮+上次拉取；云端(linux)=只显示家里最后拉取时间（拉取动作在家里发起，不放假按钮） */
function CloudSyncCard() {
  const [st, setSt] = useState<SyncState | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/__rana/cloud-sync");
      setSt((await r.json()) as SyncState);
    } catch {
      setSt(null);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(t);
  }, [load]);

  const pull = async () => {
    try {
      await fetch("/__rana/cloud-sync/pull", { method: "POST" });
      setTimeout(() => void load(), 1000);
    } catch {
      /* 下轮轮询会看到状态 */
    }
  };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: "10px 14px 6px", fontSize: 14 }}>
        <span className="ic">☁️</span>云端同步 <small style={{ color: "var(--text-dim)", fontWeight: 400 }}>记忆正本在家里 · 云端是运行副本</small>
      </h3>
      <div style={{ padding: "0 14px 12px" }}>
        {HOST_IS_WINDOWS ? (
          <>
            <div className="kv">
              <span className="k">上次拉回</span>
              <span className="v">{st?.local?.lastPullAt ? `${fmtAgo(st.local.lastPullAt)}（${st.local.bytes ? fmtMB(st.local.bytes) : "—"}）` : "从没拉过"}</span>
            </div>
            <button
              className="mem-save"
              style={{ marginTop: 8, opacity: st?.pulling ? 0.6 : 1 }}
              disabled={st?.pulling}
              onClick={() => void pull()}
            >
              {st?.pulling ? "拉取中…" : "☁️ 拉回云端记忆"}
            </button>
            {st?.pulling && st?.log?.length ? <div className="plan-hint">{st.log[st.log.length - 1]}</div> : null}
            {st?.error && <div className="set-error">⚠ {st.error}</div>}
            <div className="plan-hint">快照存 rana-web\.migration-sync\，留最近 14 份；也可双击 tools\sync-now.cmd。</div>
          </>
        ) : (
          <>
            <div className="kv">
              <span className="k">家里最后拉取</span>
              <span className="v">{st?.cloud?.lastPullAt ? `${fmtAgo(st.cloud.lastPullAt)}（${st.cloud.totalBytes ? fmtMB(st.cloud.totalBytes) : "—"}）` : "家里还没来拉过"}</span>
            </div>
            <div className="plan-hint">拉取在家里电脑发起（开机自动一趟 / 双击 tools\sync-now.cmd / 本地页面按钮）。</div>
          </>
        )}
      </div>
    </div>
  );
}

export default function MemoryPage() {
  const [groups, setGroups] = useState<MemGroup[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [sel, setSel] = useState<{ key: string; name: string; editable: boolean; deletable: boolean; danger: boolean } | null>(null);
  const [content, setContent] = useState("");
  const [empty, setEmpty] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  // 私密组解锁记录：每组每次进页只确认一次
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());

  const loadTree = useCallback(async () => {
    try {
      const r = await fetch("/__rana/memory");
      const d = (await r.json()) as { groups?: MemGroup[] };
      setGroups(d.groups ?? []);
      setLoadErr("");
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const open = async (g: MemGroup, f: MemFile) => {
    if (g.danger && !unlocked.has(g.id)) {
      if (!window.confirm("这是私密层文件（仅本地模型可见，云端永远读不到）。\n确定在本机界面上打开吗？")) return;
      setUnlocked((prev) => new Set(prev).add(g.id));
    }
    if (dirty && !window.confirm("有未保存的修改，确定放弃并打开别的文件吗？")) return;
    setErr("");
    setMsg("");
    try {
      const r = await fetch(`/__rana/memory/read?key=${encodeURIComponent(f.key)}`);
      const d = (await r.json()) as { error?: string; content?: string; empty?: boolean };
      if (d.error) throw new Error(d.error);
      setSel({ key: f.key, name: f.name, editable: f.editable, deletable: f.deletable, danger: g.danger || f.danger });
      setEmpty(!!d.empty);
      setContent(d.empty ? "" : d.content ?? "");
      setDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const remove = async () => {
    if (!sel || busy) return;
    if (!window.confirm(`确定删除「${sel.name}」吗？\n文件会移入回收区（.memory-trash），不是彻底删除；删除后她的记忆索引下轮自动失效。`)) return;
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const r = await fetch("/__rana/memory/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: sel.key }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? "删除失败");
      setSel(null);
      setContent("");
      setDirty(false);
      setMsg("");
      void loadTree();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!sel || busy) return;
    if (sel.danger && !window.confirm("确认保存私密层文件的修改？")) return;
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const r = await fetch("/__rana/memory/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: sel.key, content }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? "保存失败");
      setMsg("已保存（原内容已备份为 .bak）");
      setDirty(false);
      void loadTree();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wallboard">
      <div className="board-inner mem-page">
        <div className="page-intro">
          <h2>🧠 记忆</h2>
          <p>她的记忆与人设文件。可编辑的文件保存时自动留 .bak；「系统维护」文件只读（手改会被覆盖）。</p>
        </div>
        {loadErr && <div className="set-error">⚠ 读取文件树失败：{loadErr}</div>}
        <CloudSyncCard />
        <div className="mem-wrap">
          <div className="card mem-tree">
            {groups.map((g) => (
              <div key={g.id} className={`mem-group${g.danger ? " danger" : ""}`}>
                <div className="mem-group-label">
                  {g.danger ? "🔒 " : "📂 "}
                  {g.label}
                </div>
                {g.files.length === 0 && <div className="mem-file-empty">（空）</div>}
                {g.files.map((f) => (
                  <button
                    key={f.key}
                    className={`mem-file${sel?.key === f.key ? " on" : ""}${f.danger ? " danger" : ""}`}
                    onClick={() => void open(g, f)}
                    title={`${f.key} · ${fmtSize(f.size)}`}
                  >
                    <span className="mem-file-name">{f.name}</span>
                    {!f.editable && <span className="mem-tag">系统维护</span>}
                    {f.danger && <span className="mem-tag danger">私密</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="card mem-view">
            {!sel ? (
              <div className="pending-text">从左侧选一个文件查看。左侧列表为空或加载失败时会显示对应提示。</div>
            ) : (
              <>
                <div className="mem-view-head">
                  <span className={`mem-file-name${sel.danger ? " danger" : ""}`}>{sel.name}</span>
                  {!sel.editable && <span className="mem-tag">系统维护 · 只读</span>}
                  {sel.danger && <span className="mem-tag danger">私密 · 仅本地模型</span>}
                  {dirty && <span className="mem-tag warn">未保存</span>}
                  <span className="mem-view-spacer" />
                  {sel.editable && (
                    <button className="mem-save" disabled={busy || !dirty} onClick={() => void save()}>
                      {busy ? "保存中…" : "保存"}
                    </button>
                  )}
                  {sel.deletable && (
                    <button className="mem-delete" disabled={busy} onClick={() => void remove()} title="移入回收区（.memory-trash），不彻底删除">
                      删除
                    </button>
                  )}
                </div>
                {sel.danger && <div className="mem-danger-banner">私密层：这些内容只注入本地模型会话，云端模型永远读不到。</div>}
                {empty && <div className="set-warn">这个文件目前是空的（可能是系统还没写过）。</div>}
                {sel.editable ? (
                  <textarea
                    className="mem-editor"
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value);
                      setDirty(true);
                    }}
                    spellCheck={false}
                  />
                ) : (
                  <pre className="mem-editor readonly">{content || "（空文件）"}</pre>
                )}
                {err && <div className="set-error">⚠ {err}</div>}
                {msg && <div className="set-ok">✓ {msg}</div>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
