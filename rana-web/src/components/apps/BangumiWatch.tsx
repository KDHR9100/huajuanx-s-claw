// 🎮 追番专区（工作包 D）：今日放送（api.bgm.tv 经服务端代理，浏览器直连不到）+ 我的追番清单。
// 追番数据本地维护（.bangumi/collection.json，不依赖 Bangumi access token）——加番走搜索，进度手动步进。
import { useCallback, useEffect, useState } from "react";
import { fetchJsonRetry } from "../../lib/fetchRetry";

interface CalItem {
  id: number;
  name: string;
  nameCn: string;
  cover: string;
  eps: number;
  airDate: string;
}
interface CalendarData {
  weekday: string;
  count: number;
  items: CalItem[];
}
interface SearchItem {
  id: number;
  name: string;
  nameCn: string;
  cover: string;
  airDate: string;
}
interface CollectionEntry {
  subjectId: number;
  name: string;
  nameCn?: string;
  cover?: string;
  eps?: number;
  progress: number;
  addedAt: number;
}
interface CollectionData {
  items: CollectionEntry[];
}

/** 封面经服务端转发（Clash 出网），挂了显示占位色块 */
const coverUrl = (u: string) => (u ? `/__rana/bangumi/cover?u=${encodeURIComponent(u)}` : "");

export default function BangumiWatch() {
  const [cal, setCal] = useState<CalendarData | null>(null);
  const [calError, setCalError] = useState("");
  const [col, setCol] = useState<CollectionEntry[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState(0);

  const loadCal = useCallback(async () => {
    try {
      const d = await fetchJsonRetry<CalendarData>("/__rana/bangumi/calendar");
      setCal(d);
      setCalError("");
    } catch (e) {
      setCalError((e as Error).message);
    }
  }, []);

  const loadCol = useCallback(async () => {
    try {
      const d = await fetchJsonRetry<CollectionData>("/__rana/bangumi/collection");
      setCol(Array.isArray(d.items) ? d.items : []);
    } catch {
      // 清单读不到先空着，操作时会再报
    }
  }, []);

  useEffect(() => {
    void loadCal();
    void loadCol();
  }, [loadCal, loadCol]);

  const search = async () => {
    if (searching || !q.trim()) return;
    setSearching(true);
    setResults(null);
    try {
      const r = await fetch(`/__rana/bangumi/search?q=${encodeURIComponent(q.trim())}`);
      const j = (await r.json()) as SearchItem[] | { error?: string };
      if (!Array.isArray(j)) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      setResults(j);
    } catch (e) {
      setResults([]);
      setCalError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const addToList = async (s: SearchItem) => {
    if (busyId) return;
    setBusyId(s.id);
    try {
      const r = await fetch("/__rana/bangumi/collection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectId: s.id, name: s.name, nameCn: s.nameCn, cover: s.cover }),
      });
      const j = (await r.json()) as { ok?: boolean; items?: CollectionEntry[]; error?: string };
      if (!r.ok || !j.ok || !j.items) throw new Error(j.error ?? `HTTP ${r.status}`);
      setCol(j.items);
      setResults(null);
      setQ("");
    } catch (e) {
      setCalError(`没加进追番：${(e as Error).message}`);
    } finally {
      setBusyId(0);
    }
  };

  const stepProgress = async (entry: CollectionEntry, delta: number) => {
    if (busyId) return;
    const next = Math.max(0, entry.progress + delta);
    setBusyId(entry.subjectId);
    try {
      const r = await fetch("/__rana/bangumi/collection/progress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectId: entry.subjectId, progress: next }),
      });
      const j = (await r.json()) as { ok?: boolean; items?: CollectionEntry[]; error?: string };
      if (!r.ok || !j.ok || !j.items) throw new Error(j.error ?? `HTTP ${r.status}`);
      setCol(j.items);
    } catch (e) {
      setCalError(`进度没记上：${(e as Error).message}`);
    } finally {
      setBusyId(0);
    }
  };

  const remove = async (entry: CollectionEntry) => {
    if (!window.confirm(`把「${(entry.nameCn || entry.name).slice(0, 24)}」移出追番？`)) return;
    try {
      const r = await fetch(`/__rana/bangumi/collection?subjectId=${entry.subjectId}`, { method: "DELETE" });
      const j = (await r.json()) as { ok?: boolean; items?: CollectionEntry[]; error?: string };
      if (!r.ok || !j.ok || !j.items) throw new Error(j.error ?? `HTTP ${r.status}`);
      setCol(j.items);
    } catch (e) {
      setCalError(`移除失败：${(e as Error).message}`);
    }
  };

  const inList = (id: number) => col.some((x) => x.subjectId === id);

  return (
    <div className="card">
      {calError && (
        <p className="sys-err" style={{ cursor: "pointer" }} onClick={() => void loadCal()} title="点一下重试">
          （{calError} · 点击重试）
        </p>
      )}

      {/* 我的追番：清单 + 搜索加番 */}
      <div className="bgm-mine">
        <div className="bgm-search">
          <input
            className="set-input"
            placeholder="搜部番加进追番，比如：MyGO / 摇曳露营"
            value={q}
            maxLength={60}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
          <button className="btn sm" onClick={() => void search()} disabled={searching || !q.trim()}>
            {searching ? "搜…" : "🔍 搜索"}
          </button>
        </div>
        {results && (
          <div className="bgm-results">
            {results.length ? (
              results.map((s) => (
                <div key={s.id} className="bgm-result-row">
                  {s.cover ? (
                    <img className="bgm-thumb" src={coverUrl(s.cover)} alt="" loading="lazy" />
                  ) : (
                    <span className="bgm-thumb none" />
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {s.nameCn || s.name}
                    {s.nameCn && s.name !== s.nameCn && <span className="tune-hint"> · {s.name}</span>}
                    {s.airDate && <span className="tune-hint"> · {s.airDate.slice(0, 4)}</span>}
                  </span>
                  {inList(s.id) ? (
                    <span className="chip">已在追番</span>
                  ) : (
                    <button className="btn ghost sm" onClick={() => void addToList(s)} disabled={busyId === s.id}>
                      ＋ 追
                    </button>
                  )}
                </div>
              ))
            ) : (
              <p className="pending-text" style={{ margin: 0 }}>
                没搜到。换个名字试试（日文原名也行）。
              </p>
            )}
          </div>
        )}
        {col.length ? (
          col.map((entry) => {
            const done = entry.eps ? entry.progress >= entry.eps : false;
            return (
              <div key={entry.subjectId} className="bgm-result-row">
                {entry.cover ? (
                  <img className="bgm-thumb" src={coverUrl(entry.cover)} alt="" loading="lazy" />
                ) : (
                  <span className="bgm-thumb none" />
                )}
                <span style={{ flex: 1, minWidth: 0 }}>
                  {done ? "✅ " : ""}
                  {entry.nameCn || entry.name}
                  {entry.eps ? <span className="tune-hint"> · 全 {entry.eps} 话</span> : null}
                </span>
                <span className="bgm-progress">
                  <button className="btn ghost sm" onClick={() => void stepProgress(entry, -1)} disabled={busyId === entry.subjectId} title="看漏了，退一话">
                    −
                  </button>
                  <span className="chip">{entry.progress} 话</span>
                  <button className="btn ghost sm" onClick={() => void stepProgress(entry, 1)} disabled={busyId === entry.subjectId} title="看完一话">
                    ＋
                  </button>
                </span>
                <button className="btn ghost sm" onClick={() => void remove(entry)} title="移出追番">
                  🗑
                </button>
              </div>
            );
          })
        ) : (
          <p className="pending-text" style={{ margin: 0 }}>
            还没有追的番——上面搜一部加上。
          </p>
        )}
      </div>

      {/* 今日放送 */}
      <h3 className="sec-sub" style={{ marginTop: 18 }}>
        📺 今日放送{cal ? ` · ${cal.weekday} · ${cal.count} 部` : ""}
      </h3>
      {cal && cal.items.length ? (
        <div className="bgm-grid">
          {cal.items.map((s) => {
            const mine = col.find((x) => x.subjectId === s.id);
            return (
              <div key={s.id} className={`bgm-card${mine ? " mine" : ""}`} title={s.name}>
                {s.cover ? (
                  <img src={coverUrl(s.cover)} alt="" loading="lazy" />
                ) : (
                  <div className="bgm-nocover" />
                )}
                <span className="bgm-name">{s.nameCn || s.name}</span>
                <span className="bgm-sub">
                  {s.eps ? `全${s.eps}话` : ""}
                  {mine ? ` · 看到 ${mine.progress} 话` : ""}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="pending-text" style={{ margin: 0 }}>
          {cal ? "今天没有放送数据。" : "放送表拉取中…（要走 Clash 代理，稍等）"}
        </p>
      )}
    </div>
  );
}
