// Token 用量卡片组：原右侧栏面板改造为卡片流，挂在「电脑状态」页里（随该页查看时刷新）。
import { useAppStore } from "../store/useAppStore";

function fmtTokens(n?: number) {
  if (n === undefined || n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function UsageCards() {
  const sessions = useAppStore((s) => s.sessions);
  const currentKey = useAppStore((s) => s.currentKey);
  const models = useAppStore((s) => s.models);

  const row = sessions.find((s) => s.key === currentKey);
  const model = models.find((m) => m.id === row?.model);
  const ctxWindow = model?.contextWindow ?? row?.contextTokens;
  // gateway 的 contextTokens 是窗口大小而非用量；占用用累计 tokens 估算
  const ctxUsed = row?.totalTokens;
  const ctxPct = ctxUsed && ctxWindow ? Math.min(100, (ctxUsed / ctxWindow) * 100) : undefined;

  return (
    <div className="card">
      <h3>
        <span className="ic">🧮</span>Token 用量 <small>{row?.title ?? "未选会话"}</small>
      </h3>
      <div className="gauge-row">
        <span>本会话累计</span>
        <b>
          {fmtTokens(row?.totalTokens)} <small className="unit">tokens</small>
        </b>
      </div>
      <div className="kv">
        <span className="k">输入 / 输出</span>
        <span className="v">
          {fmtTokens(row?.inputTokens)} / {fmtTokens(row?.outputTokens)}
        </span>
      </div>
      <div className="kv">
        <span className="k">预计费用</span>
        <span className="v">{row?.estimatedCostUsd !== undefined ? `$${row.estimatedCostUsd.toFixed(4)}` : "—"}</span>
      </div>
      <div style={{ height: 8 }} />
      <div className="gauge-row">
        <span>上下文占用</span>
        <b>
          {fmtTokens(ctxUsed)}
          {ctxWindow ? <small className="unit"> / {(ctxWindow / 1000).toFixed(0)}k</small> : null}
        </b>
      </div>
      <div className="bar">
        <i style={{ width: `${ctxPct ?? 0}%` }} />
      </div>
      <div className="kv">
        <span className="k">{ctxPct !== undefined ? `${ctxPct.toFixed(1)}%` : "—"}</span>
        <span className="v">{row?.model?.split("/").pop() ?? "默认模型"}</span>
      </div>
    </div>
  );
}
