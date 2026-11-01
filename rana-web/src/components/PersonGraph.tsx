// 人物图谱视图：fetch /__rana/person-graph → mermaid 静态图（节点可点击弹卡）+ 编辑模式。
// 悬停提示用 SVG <title> 注入；点击节点走事件委托（closest("g.node")）查数据弹卡；
// 编辑=改 graph.md 原文，保存走 POST /save（回环+.bak，2MB 上限），存完自动重画。
// 渲染/保存失败都降级成提示行，不炸整页。数据契约见 server/lib/person-graph-parse.ts。
import { useCallback, useEffect, useState } from "react";
import type { PersonGraphData } from "../../server/lib/person-graph-parse";
import { buildMermaidDef } from "../lib/person-graph";

/** 往渲染出的 SVG 里补 <title> 悬停提示（g.node id 形如 flowchart-<顶点id>-<n>）。 */
function injectTitles(svg: string, data: PersonGraphData, centerLabel: string): string {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const tip = new Map<string, string>();
    tip.set("XY", `${centerLabel}——图谱中心`);
    data.people.forEach((p, k) => tip.set(`n${k}`, [p.name, p.blurb, p.relation].filter(Boolean).join("｜")));
    data.events.forEach((e, k) => tip.set(`ev${k}`, [e.name, e.status, e.people ? `关联：${e.people}` : ""].filter(Boolean).join("｜")));
    doc.querySelectorAll("g.node").forEach((g) => {
      const id = (g.id || "").replace(/^flowchart-/, "").replace(/-\d+$/, "");
      const text = tip.get(id);
      if (!text) return;
      const t = doc.createElementNS("http://www.w3.org/2000/svg", "title");
      t.textContent = text;
      g.appendChild(t);
    });
    return new XMLSerializer().serializeToString(doc);
  } catch {
    return svg;
  }
}

/** 从点击目标的 g.node id 还原顶点 id（n2 / ev1 / XY）。 */
function vertexIdOf(gid: string): string {
  return (gid || "").replace(/^flowchart-/, "").replace(/-\d+$/, "");
}

export default function PersonGraph() {
  const [data, setData] = useState<PersonGraphData | null>(null);
  const [err, setErr] = useState("");
  const [svg, setSvg] = useState("");
  const [renderErr, setRenderErr] = useState("");
  const [showSrc, setShowSrc] = useState(false);
  const [src, setSrc] = useState("");
  const [srcBusy, setSrcBusy] = useState(false);
  // 点击卡片：{kind:"person"|"event"|"center", index}；编辑模式：draft=textarea 内容
  const [sel, setSel] = useState<{ kind: "person" | "event" | "center"; index: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/__rana/person-graph");
      const d = (await r.json()) as PersonGraphData;
      setData(d);
      setErr(d.error ?? "");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!data) return;
    let dead = false;
    (async () => {
      try {
        const mer = (await import("mermaid")).default;
        mer.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
        const out = await mer.render(`pg-${Date.now()}`, buildMermaidDef(data));
        if (dead) return;
        setSvg(injectTitles(out.svg, data, "轩瑜"));
      } catch (e) {
        if (!dead) setRenderErr((e as Error).message);
      }
    })();
    return () => {
      dead = true;
    };
  }, [data]);

  // 点节点弹卡：SVG 内容是 dangerouslySetInnerHTML 注入的，靠容器上的事件委托拿到点击
  const onGraphClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const nodeEl = (e.target as Element).closest?.("g.node");
    if (!nodeEl) return;
    const vid = vertexIdOf(nodeEl.id || "");
    if (vid === "XY") {
      setSel({ kind: "center", index: 0 });
      return;
    }
    const m = vid.match(/^[ne]v?(\d+)$/);
    if (!m) return;
    const index = Number(m[1]);
    setSel(vid.startsWith("ev") ? { kind: "event", index } : { kind: "person", index });
  };

  const openSource = async () => {
    if (srcBusy) return;
    if (showSrc) {
      setShowSrc(false);
      return;
    }
    setSrcBusy(true);
    try {
      const r = await fetch("/__rana/person-graph/source");
      const d = (await r.json()) as { content?: string; error?: string };
      setSrc(d.content ?? "");
      setShowSrc(true);
      if (d.error) setErr(d.error);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSrcBusy(false);
    }
  };

  const startEdit = async () => {
    if (editing) {
      setEditing(false);
      return;
    }
    try {
      let body = src;
      if (!body) {
        const r = await fetch("/__rana/person-graph/source");
        const d = (await r.json()) as { content?: string };
        body = d.content ?? "";
        setSrc(body);
      }
      setDraft(body);
      setEditing(true);
      setShowSrc(false);
      setMsg("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const saveEdit = async () => {
    if (saveBusy) return;
    if (!window.confirm("确认保存对图谱本子的修改？\n原内容会自动备份为 .bak，保存后图立即重画。")) return;
    setSaveBusy(true);
    setErr("");
    setMsg("");
    try {
      const r = await fetch("/__rana/person-graph/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? "保存失败");
      setSrc(draft);
      setEditing(false);
      setMsg("已保存（原内容已备份为 .bak）");
      void load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaveBusy(false);
    }
  };

  // 选中节点的卡片数据（纯展示，编辑统一走「✏️ 编辑」改原文）
  const selInfo = (() => {
    if (!sel || !data) return null;
    if (sel.kind === "center") return { title: "轩瑜", rows: ["身份｜图谱中心"] as string[] };
    if (sel.kind === "person") {
      const p = data.people[sel.index];
      if (!p) return null;
      return { title: p.name, rows: [`圈层｜${p.group}`, p.blurb && `一句话｜${p.blurb}`, p.relation && `与轩瑜｜${p.relation}`, p.source && `来源｜${p.source}`].filter(Boolean) as string[] };
    }
    const ev = data.events[sel.index];
    if (!ev) return null;
    return { title: ev.name, rows: [ev.status && `状态｜${ev.status}`, ev.people && `关联人｜${ev.people}`, ev.source && `来源｜${ev.source}`].filter(Boolean) as string[] };
  })();

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span className="mem-file-name">🕸 人物·事件图谱</span>
        <span className="mem-tag danger">敏感 · 永不外发</span>
        {data?.lastChecked && <span className="mem-tag">最后核对：{data.lastChecked}</span>}
        <span style={{ flex: 1 }} />
        <button className="mem-save" onClick={() => void startEdit()}>{editing ? "退出编辑" : "✏️ 编辑"}</button>
        <button className="mem-save" onClick={() => void openSource()}>{showSrc ? "收起原文" : "查看原文"}</button>
      </div>
      <div className="mem-danger-banner">图谱数据（人名/关系/事件）永不进群聊、永不外发；此图仅本机展示。点节点弹卡片，改表格走「✏️ 编辑」。</div>
      {err && <div className="set-error">⚠ {err}</div>}
      {msg && <div className="set-ok">✓ {msg}</div>}
      {editing ? (
        <>
          <textarea
            className="mem-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            style={{ minHeight: 420 }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="mem-save" disabled={saveBusy} onClick={() => void saveEdit()}>
              {saveBusy ? "保存中…" : "保存"}
            </button>
            <button className="mem-delete" disabled={saveBusy} onClick={() => setEditing(false)}>取消</button>
          </div>
        </>
      ) : (
        <>
          {showSrc && <pre className="mem-editor readonly" style={{ maxHeight: 300, overflow: "auto" }}>{src || "（加载中…）"}</pre>}
          {svg ? (
            <div className="pg-clickable" style={{ position: "relative", overflowX: "auto" }} onClick={onGraphClick}>
              <div dangerouslySetInnerHTML={{ __html: svg }} />
              {selInfo && (
                <div className="card" style={{ position: "absolute", top: 8, right: 8, maxWidth: 320, padding: "10px 12px", zIndex: 5, boxShadow: "0 4px 16px rgba(0,0,0,.25)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="mem-file-name">{selInfo.title}</span>
                    <span style={{ flex: 1 }} />
                    <button className="mem-delete" style={{ padding: "0 8px" }} onClick={() => setSel(null)}>✕</button>
                  </div>
                  {selInfo.rows.map((r, i) => (
                    <div key={i} className="plan-hint" style={{ marginTop: 4 }}>{r}</div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            !renderErr && <div className="pending-text">{data ? "图渲染中…" : "图谱加载中…"}</div>
          )}
          {renderErr && <div className="set-error">⚠ 图渲染失败：{renderErr}</div>}
        </>
      )}
    </div>
  );
}
