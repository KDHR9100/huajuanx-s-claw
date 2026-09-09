import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";
import { modelSuffix } from "../lib/types";

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

  const isActive = (modelId: string) => !!current && modelSuffix(current) === modelSuffix(modelId);

  // 按 provider 分组（aliyun-maas / lmstudio-local / 新增的档案…），组内保持原顺序
  const groups: Array<{ provider: string; items: typeof models }> = [];
  for (const m of models) {
    const provider = m.provider ?? m.id.split("/")[0] ?? "";
    const last = groups[groups.length - 1];
    if (last && last.provider === provider) last.items.push(m);
    else groups.push({ provider, items: [m] });
  }

  return (
    <div className="model-picker" ref={ref}>
      <button className="mp-trigger" onClick={() => setOpen((v) => !v)} title={current ?? "默认模型"}>
        ⚡ {shortName(current)}
        <span className="mp-caret">▼</span>
      </button>
      {open && (
        <div className="mp-menu">
          <div className="mp-label">全部模型（{models.length}）· 按接口分组</div>
          {groups.map((g) => (
            <div key={g.provider}>
              <div className="mp-group">{g.provider}</div>
              {g.items.map((m) => (
                <button key={m.id} className={`mp-item${isActive(m.id) ? " active" : ""}`} disabled={busy} onClick={() => void apply(m.id)}>
                  <span className="m-name">{m.name}</span>
                  <span className="m-sub">
                    {m.id}
                    {m.contextWindow ? ` · ${(m.contextWindow / 1000).toFixed(0)}k ctx` : ""}
                  </span>
                </button>
              ))}
            </div>
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
  const showReasoning = useAppStore((s) => s.showReasoning);
  const setShowReasoning = useAppStore((s) => s.setShowReasoning);

  const title = sessions.find((s) => s.key === currentKey)?.title ?? "Rana";
  const dot = conn === "connected" ? "ok" : conn === "connecting" ? "wait" : "err";

  return (
    <header className="topbar">
      <span className={`conn-dot ${dot}`} title={conn} />
      <span className="title">{title}</span>
      <button
        className={`btn ghost reason-toggle${showReasoning ? "" : " off"}`}
        onClick={() => setShowReasoning(!showReasoning)}
        title={showReasoning ? "显示思考过程中：点击关闭" : "思考过程已隐藏：点击开启"}
      >
        💭 思考{showReasoning ? "" : "（关）"}
      </button>
      <ModelPicker />
      {!panelOpen && (
        <button className="btn ghost" onClick={togglePanel}>
          用量
        </button>
      )}
    </header>
  );
}
