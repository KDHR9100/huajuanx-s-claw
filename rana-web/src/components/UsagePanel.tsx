import { useAppStore } from "../store/useAppStore";

function fmtTokens(n?: number) {
  if (n === undefined || n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function UsagePanel() {
  const sessions = useAppStore((s) => s.sessions);
  const currentKey = useAppStore((s) => s.currentKey);
  const models = useAppStore((s) => s.models);
  const togglePanel = useAppStore((s) => s.togglePanel);

  const row = sessions.find((s) => s.key === currentKey);
  const model = models.find((m) => m.id === row?.model);
  const ctxWindow = model?.contextWindow ?? row?.contextTokens;
  // gateway 的 contextTokens 是窗口大小而非用量；占用用累计 tokens 估算
  const ctxUsed = row?.totalTokens;
  const ctxPct = ctxUsed && ctxWindow ? Math.min(100, (ctxUsed / ctxWindow) * 100) : undefined;

  return (
    <aside className="usage-panel">
      <div className="up-head">
        <h3>Token 用量</h3>
        <button className="up-collapse" title="收起" onClick={togglePanel}>
          ✕
        </button>
      </div>

      <div className="up-card">
        <div className="k">本会话累计</div>
        <div className="v">
          {fmtTokens(row?.totalTokens)} <small>tokens</small>
        </div>
        <div className="up-row">
          <span className="label">输入</span>
          <span>{fmtTokens(row?.inputTokens)}</span>
        </div>
        <div className="up-row">
          <span className="label">输出</span>
          <span>{fmtTokens(row?.outputTokens)}</span>
        </div>
      </div>

      <div className="up-card">
        <div className="k">上下文占用</div>
        <div className="v">
          {fmtTokens(ctxUsed)}
          {ctxWindow ? <small> / {(ctxWindow / 1000).toFixed(0)}k</small> : null}
        </div>
        <div className="ctx-bar">
          <div style={{ width: `${ctxPct ?? 0}%` }} />
        </div>
        <div className="up-row">
          <span className="label">{ctxPct !== undefined ? `${ctxPct.toFixed(1)}%` : "—"}</span>
          <span className="label">{row?.model?.split("/").pop() ?? "默认模型"}</span>
        </div>
      </div>

      <div className="up-card">
        <div className="k">预计费用</div>
        <div className="v">
          {row?.estimatedCostUsd !== undefined ? `$${row.estimatedCostUsd.toFixed(4)}` : "—"}
        </div>
      </div>
    </aside>
  );
}
