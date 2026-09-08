import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";
import { ALIAS_FALLBACK, modelSuffix } from "../lib/types";

function shortName(id?: string) {
  if (!id) return "默认模型";
  return modelSuffix(id);
}

function ModelPicker() {
  const models = useAppStore((s) => s.models);
  const sessions = useAppStore((s) => s.sessions);
  const currentKey = useAppStore((s) => s.currentKey);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = sessions.find((s) => s.key === currentKey)?.model;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const apply = async (modelId: string) => {
    if (!currentKey || busy) return;
    setBusy(true);
    try {
      await gateway.setModel(currentKey, modelId);
      setOpen(false);
    } catch (e) {
      alert(`切换模型失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 别名 chips：仅显示当前 models 列表里能对上的（按后缀匹配）
  const aliasChips = Object.entries(ALIAS_FALLBACK)
    .filter(([, id]) => models.some((m) => modelSuffix(m.id) === modelSuffix(id)))
    .map(([alias, id]) => ({ alias, id }));

  const isActive = (modelId: string) => !!current && modelSuffix(current) === modelSuffix(modelId);

  return (
    <div className="model-picker" ref={ref}>
      <button className="mp-trigger" onClick={() => setOpen((v) => !v)} title={current ?? "默认模型"}>
        ⚡ {shortName(current)}
        <span className="mp-caret">▼</span>
      </button>
      {open && (
        <div className="mp-menu">
          <div className="mp-label">快捷别名</div>
          <div className="alias-chips">
            {aliasChips.map(({ alias, id }) => (
              <button key={alias} className={`chip${current === id ? " active" : ""}`} disabled={busy} onClick={() => void apply(id)}>
                {alias}
              </button>
            ))}
            {aliasChips.length === 0 && <span className="mp-label">（无可用别名）</span>}
          </div>
          <div className="mp-label">全部模型（{models.length}）</div>
          {models.map((m) => (
            <button key={m.id} className={`mp-item${isActive(m.id) ? " active" : ""}`} disabled={busy} onClick={() => void apply(m.id)}>
              <span className="m-name">
                {aliasChips.find((c) => c.id === m.id)?.alias ? `${aliasChips.find((c) => c.id === m.id)!.alias} · ` : ""}
                {m.name}
              </span>
              <span className="m-sub">
                {m.id}
                {m.contextWindow ? ` · ${(m.contextWindow / 1000).toFixed(0)}k ctx` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Topbar() {
  const conn = useAppStore((s) => s.conn);
  const sessions = useAppStore((s) => s.sessions);
  const currentKey = useAppStore((s) => s.currentKey);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const panelOpen = useAppStore((s) => s.panelOpen);

  const title = sessions.find((s) => s.key === currentKey)?.title ?? "Rana";
  const dot = conn === "connected" ? "ok" : conn === "connecting" ? "wait" : "err";

  return (
    <header className="topbar">
      <span className={`conn-dot ${dot}`} title={conn} />
      <span className="title">{title}</span>
      <ModelPicker />
      {!panelOpen && (
        <button className="btn ghost" onClick={togglePanel}>
          用量
        </button>
      )}
    </header>
  );
}
