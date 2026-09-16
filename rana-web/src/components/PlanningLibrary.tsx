// 内容库：真材实料的家，给人生规划当弹药库。两条进货渠道 + 一条消化出口：
// 1) 让Rana去搜集：她用 web_search 联网搜（life-planning skill 搜集场景）→ 候选勾选 → 入库
// 2) 主人投喂：贴 URL（服务端直抓网页转文本，bocha 只有搜索摘要没整页）或直接粘文字 → 她提炼成草稿 → 确认入库
// 3) 消化成讲义：她结合人生目标与现状把条目写成讲义（保留亮点细节）→ 确认后存进课表的
//    学习资料库，并默认排一节「读讲义」的课（明天起第一个空白天）——前沿视野落到每天。
// 数据：rana-web/.life/library.json，走 /__rana/life/library*；拆解人生目标时她会引用这里的条目。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LifeGoal } from "./PlanningOverview";
import Markdown from "./Markdown";
import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";
import { modelSuffix } from "../lib/types";

interface LibraryEntry {
  id: string;
  title: string;
  summary: string;
  takeaway?: string;
  source?: string;
  tags?: string[];
  addedBy: "rana" | "owner";
  goalId?: string;
  createdAt: number;
  digestedAt?: number;
  digestMaterialId?: string;
  digestCourseId?: string;
}
interface LibraryFile {
  version: number;
  entries: LibraryEntry[];
  updatedAt: number;
}
type Draft = Omit<LibraryEntry, "id" | "addedBy" | "goalId" | "createdAt">;
/** 搜集候选（比 Draft 多一个"库里已有"标记：网址记忆，重复出处默认不勾） */
type Candidate = Draft & { alreadyIn?: boolean };

const fmtDate = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
/** 规划页自己的模型偏好（""=跟随专用会话当前模型），搜集/投喂/讲义/拆解共用 */
const LIFE_MODEL_KEY = "life.model.v1";
const LIFE_SESSION_KEY = "agent:main:life-planner";
const modelPref = () => {
  const v = localStorage.getItem(LIFE_MODEL_KEY);
  return v ? v : undefined;
};

export default function PlanningLibrary() {
  const [lib, setLib] = useState<LibraryFile | null>(null);
  const [goalNames, setGoalNames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 搜集
  const [topic, setTopic] = useState("");
  const [collecting, setCollecting] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  // 模型选择（搜集/投喂/讲义共用，作用于「🗺 人生规划」专用会话）
  const models = useAppStore((s) => s.models);
  const sessions = useAppStore((s) => s.sessions);
  const lifeSession = sessions.find((s) => s.key === LIFE_SESSION_KEY);
  const [pickModel, setPickModel] = useState(() => {
    try {
      return localStorage.getItem(LIFE_MODEL_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const modelGroups = useMemo(() => {
    const g = new Map<string, typeof models>();
    for (const m of models) {
      const k = m.provider ?? "其他";
      g.set(k, [...(g.get(k) ?? []), m]);
    }
    return [...g.entries()];
  }, [models]);
  const changeModel = (id: string) => {
    setPickModel(id);
    try {
      localStorage.setItem(LIFE_MODEL_KEY, id);
    } catch { /* 存不进就算了 */ }
    // 会话已在：立即热切（侧栏同步显示）；还没建会话：下次她干活时生效
    if (id && lifeSession) void gateway.setModel(LIFE_SESSION_KEY, id).catch(() => {});
  };

  // 投喂
  const [feedText, setFeedText] = useState("");
  const [feeding, setFeeding] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  // 讲义（消化出口：条目 → 讲义 → 学习资料 + 一节课）
  const [digestingId, setDigestingId] = useState<string | null>(null);
  const [digestDraft, setDigestDraft] = useState<{ entryId: string; fromTitle: string; title: string; digest: string } | null>(null);
  const [digestSaving, setDigestSaving] = useState(false);
  const setPlanningTab = useAppStore((s) => s.setPlanningTab);

  const load = useCallback(async () => {
    try {
      const [rLib, rLife] = await Promise.all([fetch("/__rana/life/library"), fetch("/__rana/life")]);
      if (!rLib.ok) throw new Error(`HTTP ${rLib.status}`);
      setLib((await rLib.json()) as LibraryFile);
      if (rLife.ok) {
        const jLife = (await rLife.json()) as { goals?: LifeGoal[] };
        const map: Record<string, string> = {};
        for (const g of jLife.goals ?? []) map[g.id] = g.title;
        setGoalNames(map);
      }
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const collect = async () => {
    if (collecting) return;
    setCollecting(true);
    setError("");
    setNotice("");
    setCandidates([]);
    try {
      const r = await fetch("/__rana/life/library/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic, model: modelPref() }),
      });
      const j = (await r.json()) as { ok?: boolean; candidates?: Candidate[]; error?: string };
      if (!r.ok || !j.ok || !j.candidates) throw new Error(j.error ?? `HTTP ${r.status}`);
      setCandidates(j.candidates);
      // 网址记忆：库里已有的出处默认不勾，其余默认全勾
      setPicked(new Set(j.candidates.map((c, i) => (c.alreadyIn ? -1 : i)).filter((i) => i >= 0)));
    } catch (e) {
      setError(`搜集失败：${(e as Error).message}`);
    } finally {
      setCollecting(false);
    }
  };

  const togglePick = (i: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  const savePicked = async () => {
    if (saving || !picked.size) return;
    setSaving(true);
    setError("");
    try {
      const entries = candidates.filter((_, i) => picked.has(i));
      const r = await fetch("/__rana/life/library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries, addedBy: "rana" }),
      });
      const j = (await r.json()) as { ok?: boolean; library?: LibraryFile; error?: string };
      if (!r.ok || !j.ok || !j.library) throw new Error(j.error ?? `HTTP ${r.status}`);
      setLib(j.library);
      setCandidates([]);
      setPicked(new Set());
      setNotice(`收了 ${entries.length} 条进内容库`);
    } catch (e) {
      setError(`入库失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const feed = async () => {
    if (feeding) return;
    setFeeding(true);
    setError("");
    setNotice("");
    setDraft(null);
    try {
      const isUrl = /^https?:\/\//i.test(feedText.trim());
      const r = await fetch("/__rana/life/library/feed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(isUrl ? { url: feedText.trim(), model: modelPref() } : { text: feedText, model: modelPref() }),
      });
      const j = (await r.json()) as { ok?: boolean; draft?: Draft; error?: string };
      if (!r.ok || !j.ok || !j.draft) throw new Error(j.error ?? `HTTP ${r.status}`);
      setDraft(j.draft);
    } catch (e) {
      setError(`提炼失败：${(e as Error).message}`);
    } finally {
      setFeeding(false);
    }
  };

  const saveDraft = async () => {
    if (saving || !draft) return;
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/__rana/life/library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry: draft, addedBy: "owner" }),
      });
      const j = (await r.json()) as { ok?: boolean; library?: LibraryFile; error?: string };
      if (!r.ok || !j.ok || !j.library) throw new Error(j.error ?? `HTTP ${r.status}`);
      setLib(j.library);
      setDraft(null);
      setFeedText("");
      setNotice("收进内容库了");
    } catch (e) {
      setError(`入库失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const del = async (entry: LibraryEntry) => {
    if (!window.confirm(`删掉《${entry.title.slice(0, 24)}》？`)) return;
    try {
      const r = await fetch(`/__rana/life/library?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setLib((l) => (l ? { ...l, entries: l.entries.filter((e) => e.id !== entry.id) } : l));
    } catch (e) {
      setError(`删除失败：${(e as Error).message}`);
    }
  };

  const digest = async (entry: LibraryEntry) => {
    if (digestingId) return;
    setDigestingId(entry.id);
    setError("");
    setNotice("");
    setDigestDraft(null);
    try {
      const r = await fetch("/__rana/life/library/digest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId: entry.id, model: modelPref() }),
      });
      const j = (await r.json()) as { ok?: boolean; title?: string; digest?: string; error?: string };
      if (!r.ok || !j.ok || !j.title || !j.digest) throw new Error(j.error ?? `HTTP ${r.status}`);
      setDigestDraft({ entryId: entry.id, fromTitle: entry.title, title: j.title, digest: j.digest });
    } catch (e) {
      setError(`讲义没写成：${(e as Error).message}`);
    } finally {
      setDigestingId(null);
    }
  };

  const saveDigest = async (schedule: boolean) => {
    if (digestSaving || !digestDraft) return;
    setDigestSaving(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/__rana/life/library/digest/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...digestDraft, schedule }),
      });
      const j = (await r.json()) as {
        ok?: boolean;
        materialName?: string;
        courseId?: string | null;
        library?: LibraryFile;
        error?: string;
      };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (j.library) setLib(j.library);
      setDigestDraft(null);
      setNotice(
        `讲义《${digestDraft.title.slice(0, 18)}》已存进学习资料库` +
          (j.courseId ? "，并排了一节「读讲义」的课" : "") +
          "。",
      );
    } catch (e) {
      setError(`存档失败：${(e as Error).message}`);
    } finally {
      setDigestSaving(false);
    }
  };

  const entries = lib?.entries ?? [];

  return (
    <>
      {notice && (
        <div className="set-ok" style={{ marginBottom: 14 }}>
          {notice}{" "}
          <button className="btn ghost sm" onClick={() => setPlanningTab("schedule")}>
            去课表 →
          </button>
        </div>
      )}

      {/* 讲义预览：她写完了，看过再入库排课 */}
      {digestDraft && (
        <div className="card fate-reply" style={{ marginBottom: 16 }}>
          <h3>
            <span className="ic">📖</span> 她的讲义<small>来自《{digestDraft.fromTitle}》——看过再收</small>
          </h3>
          <h4 style={{ margin: "4px 0 8px", fontSize: 15 }}>{digestDraft.title}</h4>
          <Markdown text={digestDraft.digest} />
          <div className="cc-acts">
            <button className="btn sm" onClick={() => void saveDigest(true)} disabled={digestSaving}>
              {digestSaving ? "存档中…" : "📚 存资料 + 排一节「读讲义」"}
            </button>
            <button className="btn ghost sm" onClick={() => void saveDigest(false)} disabled={digestSaving}>
              只存资料，不排课
            </button>
            <button className="btn ghost sm" onClick={() => setDigestDraft(null)} disabled={digestSaving}>
              放弃
            </button>
          </div>
        </div>
      )}

      {/* 干活的脑子：搜集/投喂提炼/写讲义共用这个模型 */}
      <div className="plan-stats" style={{ marginBottom: 14 }}>
        <span className="chip">🧠 用哪个脑子</span>
        <select
          className="set-input study-model"
          value={pickModel}
          onChange={(e) => changeModel(e.target.value)}
          title="搜集/投喂提炼/写讲义用哪个模型（作用于「🗺 人生规划」专用会话，选完立即生效）"
        >
          <option value="">
            跟随会话{lifeSession?.model ? `（${modelSuffix(lifeSession.model)}）` : "（她的默认）"}
          </option>
          {modelGroups.map(([provider, items]) => (
            <optgroup key={provider} label={provider}>
              {items.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || modelSuffix(m.id)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* 让Rana去搜集 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>
          <span className="ic">🔍</span> 让Rana去搜集<small>她联网找真材实料，你勾选才入库</small>
        </h3>
        <div className="pg-new">
          <input
            className="set-input"
            placeholder="主题，比如：程序员的职业规划方法论 / 转行 AI 的真实复盘"
            value={topic}
            maxLength={80}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && topic.trim().length >= 2 && void collect()}
          />
        </div>
        <div className="cc-acts">
          <button className="btn sm" onClick={() => void collect()} disabled={collecting || topic.trim().length < 2}>
            {collecting ? "她正在联网搜真材实料…（最长5分钟，别走开）" : "🔍 让Rana去搜集"}
          </button>
        </div>

        {candidates.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {candidates.map((c, i) => (
              <label key={i} className={`lib-cand${picked.has(i) ? " on" : ""}`}>
                <div className="lib-cand-head">
                  <input type="checkbox" checked={picked.has(i)} onChange={() => togglePick(i)} />
                  <span className="lib-title">{c.title}</span>
                  {c.alreadyIn && (
                    <span className="chip warn" title="这个网址库里已经记过了，别重复收">
                      已在库里
                    </span>
                  )}
                </div>
                <p className="lib-sum">{c.summary}</p>
                {c.takeaway && <p className="lib-take">对你的规划：{c.takeaway}</p>}
                <div className="lib-src">
                  {c.source && (c.source.startsWith("http") ? (
                    <a href={c.source} target="_blank" rel="noreferrer">
                      {c.source}
                    </a>
                  ) : (
                    c.source
                  ))}
                  {c.tags?.length ? ` · ${c.tags.join(" / ")}` : ""}
                </div>
              </label>
            ))}
            <div className="cc-acts">
              <button className="btn sm" onClick={() => void savePicked()} disabled={saving || !picked.size}>
                {saving ? "入库中…" : `📥 入库选中（${picked.size} 条）`}
              </button>
              <button
                className="btn ghost sm"
                onClick={() => {
                  setCandidates([]);
                  setPicked(new Set());
                }}
              >
                放弃这批
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 投喂 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>
          <span className="ic">🥄</span> 投喂<small>你找的好东西：贴 URL 或直接粘文字，她提炼成条目</small>
        </h3>
        <textarea
          className="set-input goal-textarea"
          placeholder="贴一篇好文章的 URL（她抓正文总结），或直接把原文粘进来…"
          value={feedText}
          onChange={(e) => setFeedText(e.target.value)}
        />
        <div className="cc-acts">
          <button className="btn sm" onClick={() => void feed()} disabled={feeding || feedText.trim().length < 8}>
            {feeding ? "她在读材料提炼干货……（可能一两分钟）" : "🥄 投喂给她提炼"}
          </button>
        </div>

        {draft && (
          <div className="lib-cand on" style={{ marginTop: 12 }}>
            <div className="lib-cand-head">
              <span className="lib-title">{draft.title}</span>
            </div>
            <p className="lib-sum">{draft.summary}</p>
            {draft.takeaway && <p className="lib-take">对你的规划：{draft.takeaway}</p>}
            <div className="lib-src">
              {draft.source ?? ""}
              {draft.tags?.length ? ` · ${draft.tags.join(" / ")}` : ""}
            </div>
            <div className="cc-acts">
              <button className="btn sm" onClick={() => void saveDraft()} disabled={saving}>
                {saving ? "入库中…" : "📥 收进内容库"}
              </button>
              <button className="btn ghost sm" onClick={() => setDraft(null)}>
                放弃
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 条目流 */}
      {entries.length === 0 && (
        <div className="card pending">
          <p className="pending-text">
            内容库还是空的。让她搜集，或者你投喂第一篇。她拆解人生目标时会引用这里的材料。
            {error && <span className="sys-err">（{error}）</span>}
          </p>
        </div>
      )}
      {entries.map((e) => (
        <article key={e.id} className="card lib-entry">
          <div className="lib-cand-head">
            <span className={`chip${e.addedBy === "rana" ? "" : " green"}`}>
              {e.addedBy === "rana" ? "🔍 她搜的" : "🥄 你喂的"}
            </span>
            <span className="lib-title" style={{ flex: 1 }}>
              {e.title}
            </span>
            <button className="btn ghost sm" onClick={() => void del(e)} title="删除这条">
              🗑
            </button>
          </div>
          <p className="lib-sum">{e.summary}</p>
          {e.takeaway && <p className="lib-take">对你的规划：{e.takeaway}</p>}
          <div className="lib-src">
            {fmtDate(e.createdAt)}
            {e.goalId && goalNames[e.goalId] ? ` · 关联目标「${goalNames[e.goalId]}」` : ""}
            {e.source ? " · " : ""}
            {e.source && (e.source.startsWith("http") ? (
              <a href={e.source} target="_blank" rel="noreferrer">
                {e.source}
              </a>
            ) : (
              e.source
            ))}
            {e.tags?.length ? ` · ${e.tags.join(" / ")}` : ""}
          </div>
          <div className="cc-acts">
            {e.digestedAt ? (
              <span className="chip green" title={`已消化成讲义（${fmtDate(e.digestedAt)}），资料在课表的学习资料库里`}>
                📖 已成讲义{e.digestCourseId ? " · 已排课" : ""}
              </span>
            ) : (
              <button
                className="btn ghost sm"
                onClick={() => void digest(e)}
                disabled={digestingId !== null}
                title="她结合你的人生目标和现状，把这份材料写成讲义（保留亮点细节），存进学习资料并排课"
              >
                {digestingId === e.id ? "她在读材料、结合你的情况写讲义…（最长5分钟）" : "📖 让她写成讲义"}
              </button>
            )}
          </div>
        </article>
      ))}
    </>
  );
}
