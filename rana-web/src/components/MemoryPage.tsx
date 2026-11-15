// 记忆浏览页：读/改 Rana 的记忆与人设文件（工作体 / RP 体 / 私密层 / 📖 复盘日记，组列表由服务端下发、动态渲染）。
// 数据来自 /__rana/memory（白名单制：前端只传 key，key→路径映射在服务端，不接受传路径）。
// 私密组 danger=true：进入和保存各有一次确认；内容仅本地 UI 展示。
// 机器维护文件（MEMORY.md/共享纪要/巡检状态等）服务端标记 editable=false，保存会被 400 拒绝。
// 2026-10-25 迁移批1 加「☁️ 云端同步」卡：家里(win32)=拉取按钮+上次拉取；云端(linux)=家里最后拉取时间。
import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtAgo, fmtHm } from "../lib/fmt";
import { HOST_IS_WINDOWS } from "../lib/platform";
import { groupTimelineByDay } from "../../server/lib/memory-timeline";
import type { TimelineItem, TimelineSource } from "../../server/lib/memory-timeline";
import PersonGraph from "./PersonGraph";

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

// ===== 🕰 时间线卡（2026-11-15）：复盘日记/人物图谱事件/记忆文件改动按天汇一条流 =====
// 展开走 /__rana/memory/read 白名单通道；日记组/私密组比照页内解锁确认（每组每次进页只确认一次）。

type ExpandState = { state: "loading" } | { state: "ok"; content: string } | { state: "err"; msg: string };

const TL_BADGE: Record<TimelineSource, string> = { diary: "日记", graph: "图谱", memory: "记忆" };

function TimelineCard({ items, unlocked, unlock }: { items: TimelineItem[]; unlocked: Set<string>; unlock: (groupId: string) => boolean }) {
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<Set<TimelineSource>>(new Set(["diary", "graph", "memory"]));
  const [expanded, setExpanded] = useState<Record<string, ExpandState>>({});

  const toggleSource = (s: TimelineSource) =>
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => sources.has(it.source) && (!q || it.title.toLowerCase().includes(q) || (it.excerpt ?? "").toLowerCase().includes(q)));
  }, [items, query, sources]);

  const dayGroups = useMemo(() => groupTimelineByDay(filtered, new Date()), [filtered]);

  /** 展开/收起：私密组（private/diary）先走与文件视图相同的解锁确认；读不到显示「无法读取」 */
  const toggle = async (it: TimelineItem) => {
    if (!it.key) return;
    const k = it.key;
    if (expanded[k] && expanded[k].state !== "loading") {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[k];
        return next;
      });
      return;
    }
    const groupId = k.split(":")[0];
    if ((groupId === "private" || groupId === "diary") && !unlocked.has(groupId)) {
      if (!unlock(groupId)) return;
    }
    setExpanded((prev) => ({ ...prev, [k]: { state: "loading" } }));
    try {
      const r = await fetch(`/__rana/memory/read?key=${encodeURIComponent(k)}`);
      const d = (await r.json()) as { error?: string; content?: string; empty?: boolean };
      if (d.error) throw new Error(d.error);
      setExpanded((prev) => ({ ...prev, [k]: { state: "ok", content: d.empty ? "" : d.content ?? "" } }));
    } catch (e) {
      setExpanded((prev) => ({ ...prev, [k]: { state: "err", msg: (e as Error).message } }));
    }
  };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="tl-head">
        <h3 style={{ margin: 0 }}>🕰 时间线</h3>
        <span className="tl-legend">📖 复盘日记 · 🕸 人物图谱事件 · 📝 记忆文件改动</span>
      </div>
      <div className="tl-tools">
        <input
          className="tl-search"
          value={query}
          placeholder="搜记忆…（标题与摘要，本地过滤）"
          onChange={(e) => setQuery(e.target.value)}
        />
        {(["diary", "graph", "memory"] as TimelineSource[]).map((s) => (
          <button key={s} className={`tl-chip${sources.has(s) ? " on" : ""}`} onClick={() => toggleSource(s)}>
            {s === "diary" ? "📖 日记" : s === "graph" ? "🕸 图谱" : "📝 记忆"}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <div className="tl-empty">还没有可聚合的记忆事件。</div>
      ) : dayGroups.length === 0 ? (
        <div className="tl-empty">没有匹配的时间线条目（放宽搜索、或把来源 chip 打开试试）。</div>
      ) : (
        dayGroups.map((g) => (
          <div key={g.day}>
            <div className="tl-day">
              <span>
                {g.label} {g.day.slice(5, 7)}-{g.day.slice(8, 10)}
              </span>
              <span className="tl-day-count">{g.items.length} 条</span>
            </div>
            {g.items.map((it, i) => {
              const k = it.key ?? "";
              const ex = k ? expanded[k] : undefined;
              return (
              <div key={`${it.ts}-${it.source}-${i}`}>
                <div className="tl-row">
                  <span className="tl-time">{fmtHm(it.ts)}</span>
                  <span className={`tl-badge ${it.source}`}>{TL_BADGE[it.source]}</span>
                  <span className="tl-text">
                    {it.title}
                    {it.excerpt ? <span className="tl-excerpt"> · {it.excerpt}</span> : null}
                  </span>
                  {k && (
                    <button className="tl-open" onClick={() => void toggle(it)}>
                      {ex ? (ex.state === "ok" ? "▾ 收起" : "…" ) : "▸ 展开"}
                    </button>
                  )}
                </div>
                {ex && (
                  <>
                    {ex.state === "loading" && <div className="tl-body">读取中…</div>}
                    {ex.state === "err" && <div className="tl-err">无法读取：{ex.msg}</div>}
                    {ex.state === "ok" && <pre className="tl-body">{ex.content || "（空文件）"}</pre>}
                  </>
                )}
              </div>
              );
            })}
          </div>
        ))
      )}
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
  // 文件/图谱双视图：图谱数据走专用通道（服务端只放行 graph.md 一个文件）
  const [view, setView] = useState<"files" | "graph">("files");
  // 🕰 时间线：服务端聚合的日记/图谱/记忆事件流（GET /__rana/memory 的 additive 字段）
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);

  const loadTree = useCallback(async () => {
    try {
      const r = await fetch("/__rana/memory");
      const d = (await r.json()) as { groups?: MemGroup[]; timeline?: TimelineItem[] };
      setGroups(d.groups ?? []);
      setTimeline(Array.isArray(d.timeline) ? d.timeline : []);
      setLoadErr("");
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }, []);

  /** 时间线展开私密组条目用的解锁确认（文案与文件视图一致；每组每次进页只确认一次） */
  const unlock = useCallback(
    (groupId: string) => {
      if (unlocked.has(groupId)) return true;
      if (!window.confirm("这是私密层文件（仅本地模型可见，云端永远读不到）。\n确定在本机界面上打开吗？")) return false;
      setUnlocked((prev) => new Set(prev).add(groupId));
      return true;
    },
    [unlocked],
  );

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
        <TimelineCard items={timeline} unlocked={unlocked} unlock={unlock} />
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button className="mem-save" style={{ opacity: view === "files" ? 1 : 0.5 }} onClick={() => setView("files")}>📂 文件</button>
          <button className="mem-save" style={{ opacity: view === "graph" ? 1 : 0.5 }} onClick={() => setView("graph")}>🕸 人物图谱</button>
        </div>
        {view === "graph" ? (
          <PersonGraph />
        ) : (
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
        )}
      </div>
    </div>
  );
}
