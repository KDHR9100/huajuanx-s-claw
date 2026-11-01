// 人物图谱视图：fetch /__rana/person-graph → mermaid 静态星型图 + 原生悬停一句话 + 敏感横幅 + 查看原文。
// mermaid 悬停提示用 SVG <title> 注入（不依赖 mermaid 交互 API）；
// 渲染失败降级成错误行，不炸整页。数据契约见 server/lib/person-graph-parse.ts。
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

export default function PersonGraph() {
  const [data, setData] = useState<PersonGraphData | null>(null);
  const [err, setErr] = useState("");
  const [svg, setSvg] = useState("");
  const [renderErr, setRenderErr] = useState("");
  const [showSrc, setShowSrc] = useState(false);
  const [src, setSrc] = useState("");
  const [srcBusy, setSrcBusy] = useState(false);

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

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span className="mem-file-name">🕸 人物·事件图谱</span>
        <span className="mem-tag danger">敏感 · 永不外发</span>
        {data?.lastChecked && <span className="mem-tag">最后核对：{data.lastChecked}</span>}
        <span style={{ flex: 1 }} />
        <button className="mem-save" onClick={() => void openSource()}>
          {showSrc ? "收起原文" : "查看原文"}
        </button>
      </div>
      <div className="mem-danger-banner">图谱数据（人名/关系/事件）永不进群聊、永不外发；此图仅本机展示。</div>
      {err && <div className="set-error">⚠ {err}</div>}
      {renderErr && <div className="set-error">⚠ 图渲染失败：{renderErr}</div>}
      {showSrc && <pre className="mem-editor readonly" style={{ maxHeight: 300, overflow: "auto" }}>{src || "（加载中…）"}</pre>}
      {svg ? (
        <div style={{ overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        !renderErr && <div className="pending-text">{data ? "图渲染中…" : "图谱加载中…"}</div>
        )
      }
    </div>
  );
}
