// 会话页右侧用量面板（token 累计 / 上下文占用 / 费用）+ 上下文体检 + 本地模型超参数 + 快捷命令 + 技能/MCP 清单，可收起。
import { useState } from "react";
import { useAppStore } from "../store/useAppStore";
import ModelTuningCard from "./ModelTuningCard";
import AgentKitCard from "./AgentKitCard";

function fmtTokens(n?: number) {
  if (n === undefined || n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** /__rana/context 的返回形状 */
interface ContextReport {
  checkedAt: string;
  main: { key: string; inputTokens?: number; contextWindow?: number };
  baseline: {
    sysTok: number;
    projectTok: number;
    skillsTok: number;
    skillsCount: number;
    schemasTok: number;
    files: Array<{ name: string; chars: number; tok: number }>;
  };
  extra: Array<{ name: string; chars: number; tok: number }>;
}

type CheckState =
  | { s: "idle" }
  | { s: "loading" }
  | { s: "ok"; data: ContextReport }
  | { s: "err"; error: string };

/** 上下文体检卡：一键拉「她每句话都带着什么」的官方账单（临时会话跑 /context，不进聊天流） */
function ContextCheckCard() {
  const [state, setState] = useState<CheckState>({ s: "idle" });

  const run = async () => {
    setState({ s: "loading" });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 75_000);
      const res = await fetch("/__rana/context", { signal: ctrl.signal });
      clearTimeout(timer);
      const j = (await res.json()) as ContextReport & { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setState({ s: "ok", data: j });
    } catch (e) {
      setState({ s: "err", error: (e as Error).name === "AbortError" ? "体检超时（网关忙？稍后再试）" : (e as Error).message });
    }
  };

  const segs: Array<{ label: string; tok: number; color: string; hint: string }> = [];
  let segTotal = 0;
  let footerNote = "点一下跑一次：开临时会话问网关要账单，看完即删，不烧 token。";
  if (state.s === "ok") {
    const d = state.data;
    const tools = d.baseline.schemasTok;
    const skills = d.baseline.skillsTok;
    const docs = d.baseline.sysTok + d.extra.reduce((n, f) => n + f.tok, 0);
    const total = d.main.inputTokens ?? tools + skills + docs;
    const history = Math.max(0, total - tools - skills - docs);
    segTotal = total;
    segs.push(
      { label: "🔧 工具说明书", tok: tools, color: "#5b8def", hint: "全部工具的 JSON 使用说明，占上下文最大头" },
      { label: "🎯 技能清单", tok: skills, color: "#e8a33d", hint: `${d.baseline.skillsCount} 个技能的名字+简介` },
      { label: "📄 底稿文件", tok: docs, color: "var(--accent)", hint: "SOUL/AGENTS/USER/MEMORY/日记，每轮现拼" },
      { label: "💬 当天会话", tok: history, color: "#b07ad9", hint: "今早 6 点重置以来的聊天历史" },
    );
    footerNote = `主会话单轮输入 ${fmtTokens(total)}${d.main.contextWindow ? ` / 窗口 ${fmtTokens(d.main.contextWindow)}` : ""}；中文底稿按 chars/4 粗算，仅供参考。`;
  }

  return (
    <div className="up-card">
      <div className="k">上下文体检</div>
      {state.s === "idle" && (
        <>
          <p className="ctx-hint">她每句话都带着一份「底座」：工具说明书、技能清单、底稿文件。点开看构成。</p>
          <button className="btn sm ctx-check-btn" onClick={() => void run()}>
            🔍 体检
          </button>
        </>
      )}
      {state.s === "loading" && <p className="ctx-hint">体检中……（要开个临时会话向网关要账单，几秒钟）</p>}
      {state.s === "err" && (
        <>
          <p className="ctx-err">⚠ {state.error}</p>
          <button className="btn sm ctx-check-btn" onClick={() => void run()}>
            重试
          </button>
        </>
      )}
      {segs.length > 0 && (
        <>
          <div className="ctx-seg-bar">
            {segs.map((s) =>
              segTotal > 0 ? <div key={s.label} className="ctx-seg" style={{ width: `${(s.tok / segTotal) * 100}%`, background: s.color }} title={`${s.label} ${fmtTokens(s.tok)}`} /> : null,
            )}
          </div>
          <div className="ctx-legend">
            {segs.map((s) => (
              <div key={s.label} title={s.hint}>
                <span className="dot" style={{ background: s.color }} />
                {s.label} <b>{fmtTokens(s.tok)}</b>
              </div>
            ))}
          </div>
          <p className="ctx-note">{footerNote}</p>
          <button className="btn sm ghost ctx-check-btn" onClick={() => void run()}>
            ⟳ 再测一次
          </button>
        </>
      )}
    </div>
  );
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
        <h3>用量</h3>
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
          <span className="label">输入 / 输出</span>
          <span>
            {fmtTokens(row?.inputTokens)} / {fmtTokens(row?.outputTokens)}
          </span>
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

      <ContextCheckCard />
      <ModelTuningCard />
      <AgentKitCard />
    </aside>
  );
}
