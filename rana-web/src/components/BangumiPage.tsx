// 「📺 追番」独立页：今日放送 + 我的追番（在追标进度）+ 看过的番·展馆（按放送年份分组的海报墙）。
// 数据：api.bgm.tv 经服务端代理（浏览器直连不到）；追番/看过清单本地维护（.bangumi/collection.json，
// 不依赖 Bangumi access token）——搜到条目加进来，在追/看过两个状态。
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJsonRetry } from "../lib/fetchRetry";

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
  airDate?: string;
  status: "watching" | "done";
  progress: number;
  addedAt: number;
}

/** 封面经服务端转发（Clash 出网），挂了显示占位色块 */
const coverUrl = (u: string) => (u ? `/__rana/bangumi/cover?u=${encodeURIComponent(u)}` : "");

export default function BangumiPage() {
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
      const d = await fetchJsonRetry<{ items?: CollectionEntry[] }>("/__rana/bangumi/collection");
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

  /** 加番：status 决定进「在追」还是「看过」（airDate 从搜索结果带，展馆按它取年份） */
  const addToList = async (s: SearchItem, status: "watching" | "done") => {
    if (busyId) return;
    setBusyId(s.id);
    try {
      const r = await fetch("/__rana/bangumi/collection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subjectId: s.id,
          name: s.name,
          nameCn: s.nameCn,
          cover: s.cover,
          airDate: s.airDate,
          status,
        }),
      });
      const j = (await r.json()) as { ok?: boolean; items?: CollectionEntry[]; error?: string };
      if (!r.ok || !j.ok || !j.items) throw new Error(j.error ?? `HTTP ${r.status}`);
      setCol(j.items);
      setResults(null);
      setQ("");
    } catch (e) {
      setCalError(`没加进清单：${(e as Error).message}`);
    } finally {
      setBusyId(0);
    }
  };

  const update = async (entry: CollectionEntry, patch: { progress?: number; status?: "watching" | "done" }) => {
    if (busyId) return;
    setBusyId(entry.subjectId);
    try {
      const r = await fetch("/__rana/bangumi/collection/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectId: entry.subjectId, ...patch }),
      });
      const j = (await r.json()) as { ok?: boolean; items?: CollectionEntry[]; error?: string };
      if (!r.ok || !j.ok || !j.items) throw new Error(j.error ?? `HTTP ${r.status}`);
      setCol(j.items);
    } catch (e) {
      setCalError(`没记上：${(e as Error).message}`);
    } finally {
      setBusyId(0);
    }
  };

  const remove = async (entry: CollectionEntry) => {
    if (!window.confirm(`把「${(entry.nameCn || entry.name).slice(0, 24)}」移出清单？`)) return;
    try {
      const r = await fetch(`/__rana/bangumi/collection?subjectId=${entry.subjectId}`, { method: "DELETE" });
      const j = (await r.json()) as { ok?: boolean; items?: CollectionEntry[]; error?: string };
      if (!r.ok || !j.ok || !j.items) throw new Error(j.error ?? `HTTP ${r.status}`);
      setCol(j.items);
    } catch (e) {
      setCalError(`移除失败：${(e as Error).message}`);
    }
  };

  const watching = useMemo(() => col.filter((x) => x.status === "watching"), [col]);
  /** 看过的：按放送年份分组（新→旧），年份缺的进「其他」；组内按加入时间倒序 */
  const watchedGroups = useMemo(() => {
    const done = col.filter((x) => x.status === "done");
    const byYear = new Map<string, CollectionEntry[]>();
    for (const it of done) {
      const y = it.airDate && /^\d{4}/.test(it.airDate) ? it.airDate.slice(0, 4) : "其他";
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y)!.push(it);
    }
    const order = (y: string) => (y === "其他" ? "0000" : y);
    return [...byYear.entries()].sort((a, b) => order(b[0]).localeCompare(order(a[0])));
  }, [col]);

  const entryOf = (id: number) => col.find((x) => x.subjectId === id);

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 1100 }}>
        <div className="page-intro">
          <h2>追番</h2>
          <p>
            在追的标进度 · 看过的进展馆 · 数据来自 Bangumi（api.bgm.tv）
            {calError && (
              <span className="sys-err" style={{ cursor: "pointer" }} onClick={() => void loadCal()} title="点一下重试">
                （{calError} · 点击重试）
              </span>
            )}
          </p>
        </div>

        {/* 搜索加番：在追 / 看过 两个入口 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="bgm-search">
            <input
              className="set-input"
              placeholder="搜部番加上——日文原名/中文名都行，比如：MyGO / 摇曳露营 / 孤独摇滚"
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
                results.map((s) => {
                  const mine = entryOf(s.id);
                  return (
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
                      {mine ? (
                        <span className="chip">{mine.status === "done" ? "已在展馆" : "已在追"}</span>
                      ) : (
                        <>
                          <button className="btn ghost sm" onClick={() => void addToList(s, "watching")} disabled={busyId === s.id} title="加进在追清单，标进度">
                            ＋ 在追
                          </button>
                          <button className="btn ghost sm" onClick={() => void addToList(s, "done")} disabled={busyId === s.id} title="加进看过的展馆">
                            ＋ 看过
                          </button>
                        </>
                      )}
                    </div>
                  );
                })
              ) : (
                <p className="pending-text" style={{ margin: 0 }}>
                  没搜到。换个名字试试（日文原名也行）。
                </p>
              )}
            </div>
          )}
        </div>

        {/* 在追：标进度 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>
            <span className="ic">📌</span> 在追<small>{watching.length} 部</small>
          </h3>
          {watching.length ? (
            watching.map((entry) => {
              const finished = entry.eps ? entry.progress >= entry.eps : false;
              return (
                <div key={entry.subjectId} className="bgm-result-row">
                  {entry.cover ? (
                    <img className="bgm-thumb" src={coverUrl(entry.cover)} alt="" loading="lazy" />
                  ) : (
                    <span className="bgm-thumb none" />
                  )}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {entry.nameCn || entry.name}
                    {entry.eps ? <span className="tune-hint"> · 全 {entry.eps} 话</span> : null}
                  </span>
                  <span className="bgm-progress">
                    <button className="btn ghost sm" onClick={() => void update(entry, { progress: entry.progress - 1 })} disabled={busyId === entry.subjectId} title="看漏了，退一话">
                      −
                    </button>
                    <span className="chip">{entry.progress} 话</span>
                    <button className="btn ghost sm" onClick={() => void update(entry, { progress: entry.progress + 1 })} disabled={busyId === entry.subjectId} title="看完一话">
                      ＋
                    </button>
                  </span>
                  <button className="btn ghost sm" onClick={() => void update(entry, { status: "done" })} disabled={busyId === entry.subjectId} title={finished ? "追完了，挪进展馆" : "不追了直接归入看过的"}>
                    ✔ 看完
                  </button>
                  <button className="btn ghost sm" onClick={() => void remove(entry)} title="移出清单">
                    🗑
                  </button>
                </div>
              );
            })
          ) : (
            <p className="pending-text" style={{ margin: 0 }}>
              还没有在追的番——上面搜一部「＋ 在追」。
            </p>
          )}
        </div>

        {/* 看过的番 · 展馆：按年份分组的海报墙 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>
            <span className="ic">🖼️</span> 看过的番 · 展馆<small>{col.filter((x) => x.status === "done").length} 部</small>
          </h3>
          {watchedGroups.length ? (
            watchedGroups.map(([year, items]) => (
              <div key={year} className="bgm-hall-year">
                <div className="bgm-year-label">{year}</div>
                <div className="bgm-grid hall">
                  {items.map((it) => (
                    <div key={it.subjectId} className={`bgm-card hall${it.status === "done" ? "" : ""}`} title={`${it.nameCn || it.name}${it.eps ? ` · 全${it.eps}话` : ""}`}>
                      {it.cover ? (
                        <img src={coverUrl(it.cover)} alt="" loading="lazy" />
                      ) : (
                        <div className="bgm-nocover" />
                      )}
                      <span className="bgm-name">{it.nameCn || it.name}</span>
                      <span className="bgm-sub">
                        {it.eps ? `全${it.eps}话` : ""}
                        {" "}
                        <button className="bgm-hall-del" onClick={() => void remove(it)} title="移出展馆">
                          ✕
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="pending-text" style={{ margin: 0 }}>
              展馆还空着——上面搜一部点「＋ 看过」，或把在追的番点「✔ 看完」挪进来。
            </p>
          )}
        </div>

        {/* 今日放送 */}
        <div className="card">
          <h3>
            <span className="ic">📺</span> 今日放送{cal ? ` · ${cal.weekday} · ${cal.count} 部` : ""}
          </h3>
          {cal && cal.items.length ? (
            <div className="bgm-grid">
              {cal.items.map((s) => {
                const mine = entryOf(s.id);
                const tag = mine?.status === "done" ? "已看过" : mine ? `看到 ${mine.progress} 话` : "";
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
                      {tag ? ` · ${tag}` : ""}
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
      </div>
    </div>
  );
}
