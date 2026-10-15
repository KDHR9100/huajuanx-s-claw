import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";

/**
 * 🔍 过程页——轨迹回放（「她每步想了什么、调了什么、结果如何」的事后时间线）。
 * 数据源是 openclaw sessions export-trajectory 的导出包（服务端 /__rana/trajectory 瘦身后按 run 分组）。
 * 深度内容（长正文/思考/工具参数/结果）默认折叠；筛选支持 只看对话 / 含工具 / 全部。
 * 隐私：轨迹含完整对话，端点仅本机；页面只在本机 dev/preview 下有意义。
 */

interface TraceBlock {
  k: string;
  text?: string;
  chars?: number;
  head?: string;
  name?: string;
  args?: string;
  mime?: string;
}
interface TraceUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  cost?: number;
}
interface TraceEvent {
  seq: number;
  ts: string;
  source: string;
  type: string;
  runId?: string;
  model?: string;
  d?: Record<string, unknown>;
}
interface TraceRun {
  id: string;
  idx: number;
  history: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  model?: string;
  stopReason?: string;
  usage?: TraceUsage;
  events: TraceEvent[];
}
interface TraceData {
  ok: boolean;
  name: string;
  sessionKey?: string;
  generatedAt?: string;
  runs: TraceRun[];
  eventCount: number;
}
interface ExportRow {
  name: string;
  sessionKey?: string;
  generatedAt?: string;
  eventCount?: number;
  sizeBytes?: number;
}

type Filter = "all" | "chat" | "tools";

const fmtDur = (ms?: number) => {
  if (!ms || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
};
const fmtTok = (n?: number) => {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};
const fmtTime = (ts?: string) => {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const fmtSize = (b?: number) => {
  if (!b) return "";
  return b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : b >= 1024 ? `${Math.round(b / 1024)}KB` : `${b}B`;
};

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** 长文本：短的直接铺开，长的折叠（受控展开状态由外层管理，这里只管渲染） */
const LongText = ({ text, chars = 600 }: { text: string; chars?: number }) =>
  text.length > chars ? (
    <details>
      <summary>展开全部（{text.length} 字）</summary>
      <div className="trace-pre">{text}</div>
    </details>
  ) : (
    <>{text}</>
  );

const UsageChips = ({ usage }: { usage?: TraceUsage }) => {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.input) parts.push(`入 ${fmtTok(usage.input)}`);
  if (usage.output) parts.push(`出 ${fmtTok(usage.output)}`);
  if (!parts.length) return <span className="trace-dim">token 未回报</span>;
  return <span className="trace-dim">{parts.join(" · ")}</span>;
};

/** 单条事件渲染 */
const EventRow = ({ ev }: { ev: TraceEvent }) => {
  const d = ev.d ?? {};
  switch (ev.type) {
    case "user.message":
      return (
        <div className="trace-ev user">
          <LongText text={s(d.text) || "(空)"} />
        </div>
      );
    case "assistant.message": {
      const blocks = Array.isArray(d.blocks) ? (d.blocks as TraceBlock[]) : [];
      if (!blocks.length) return null;
      return (
        <div className="trace-ev assistant">
          {blocks.map((b, i) => {
            if (b.k === "text" && b.text) return <LongText key={i} text={b.text} chars={1200} />;
            if (b.k === "think")
              return (
                <details key={i} className="trace-think">
                  <summary>💭 思考 {b.chars ?? "?"} 字</summary>
                  <div className="trace-pre">{b.head}</div>
                </details>
              );
            if (b.k === "tool")
              return (
                <div key={i} className="trace-tool">
                  🔧 {b.name}
                  {b.args && (
                    <details>
                      <summary>参数</summary>
                      <div className="trace-pre">{b.args}</div>
                    </details>
                  )}
                </div>
              );
            if (b.k === "img") return <div key={i} className="trace-dim">🖼 图片（{b.mime || "image"}）</div>;
            return null;
          })}
        </div>
      );
    }
    case "tool.call":
      return (
        <div className="trace-tool">
          🔧 调用 <b>{s(d.name) || "?"}</b>
          {s(d.args) && s(d.args) !== '""' && (
            <details>
              <summary>参数</summary>
              <div className="trace-pre">{s(d.args)}</div>
            </details>
          )}
        </div>
      );
    case "tool.result":
      return (
        <div className={`trace-tool${d.isError === true ? " err" : ""}`}>
          {d.isError === true ? "⚠️" : "🔩"} <b>{s(d.name) || "工具"}</b> 结果{s(d.meta) ? `（${s(d.meta)}）` : ""}
          {s(d.result) && (
            <details>
              <summary>查看结果</summary>
              <div className="trace-pre">{s(d.result)}</div>
            </details>
          )}
        </div>
      );
    case "prompt.submitted":
      return (
        <div className="trace-sysrow">
          📨 提交 prompt{n(d.msgs) !== undefined ? `（携带历史 ${n(d.msgs)} 条）` : ""}
          {s(d.prompt) && (
            <details>
              <summary>本次输入</summary>
              <div className="trace-pre">{s(d.prompt)}</div>
            </details>
          )}
        </div>
      );
    case "context.compiled": {
      const tools = n(d.tools);
      return (
        <div className="trace-sysrow">
          🧩 装配上下文：系统提示 {n(d.sysChars) ?? 0} 字 · 历史 {n(d.msgs) ?? 0} 条
          {tools !== undefined ? ` · 工具 ${tools} 个` : ""}
        </div>
      );
    }
    case "model.completed":
      return (
        <div className="trace-sysrow">
          🏁 模型完成 · stop=<b>{s(d.stopReason) || "?"}</b> · <UsageChips usage={d.usage as TraceUsage} />
        </div>
      );
    case "session.started":
      return (
        <div className="trace-sysrow">
          ▶ 开始运行（触发：{s(d.trigger) || "?"}）{n(d.toolCount) !== undefined ? ` · 可用工具 ${n(d.toolCount)} 个` : ""}
        </div>
      );
    case "session.ended":
      return (
        <div className="trace-sysrow">
          ■ 结束 · 状态 <b>{s(d.status) || "?"}</b>
          {s(d.stopReason) ? ` · stop=${s(d.stopReason)}` : ""}
        </div>
      );
    case "session.compaction":
      return (
        <div className="trace-sysrow">
          📉 上下文压缩{n(d.tokensBefore) ? `（压缩前约 ${fmtTok(n(d.tokensBefore))} tok）` : ""}
          {s(d.summaryHead) && (
            <details>
              <summary>压缩摘要</summary>
              <div className="trace-pre">{s(d.summaryHead)}</div>
            </details>
          )}
        </div>
      );
    case "trace.artifacts":
      return (
        <div className="trace-sysrow">
          📦 收尾 · 最终状态 <b>{s(d.finalStatus) || "?"}</b>
          {n(d.toolCount) !== undefined ? ` · 本轮工具 ${n(d.toolCount)} 次` : ""}
        </div>
      );
    case "session.reset":
      return <div className="trace-sysrow">♻️ 会话重置{s(d.reason) ? `（${s(d.reason)}）` : ""}</div>;
    case "session.model_change":
      return <div className="trace-sysrow">🔀 模型切换 → {s(d.provider)}/{s(d.modelId)}</div>;
    case "session.thinking_level_change":
      return <div className="trace-sysrow">🧠 思考档位 → {s(d.level)}</div>;
    default:
      return <div className="trace-sysrow">{ev.type}{s(d.note) ? `：${s(d.note)}` : ""}</div>;
  }
};

const keepEvent = (ev: TraceEvent, filter: Filter): boolean => {
  if (filter === "chat") return ev.type === "user.message" || ev.type === "assistant.message";
  if (filter === "tools") return ev.type === "tool.call" || ev.type === "tool.result";
  return true;
};

export default function TracePage() {
  const sessions = useAppStore((s) => s.sessions);
  const tracePreselect = useAppStore((s) => s.tracePreselect);

  const [exports, setExports] = useState<ExportRow[]>([]);
  const [sel, setSel] = useState("");
  const [data, setData] = useState<TraceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [selKey, setSelKey] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  /** 展开的 run id 集合；默认展开最后一个（最近的）run */
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (tracePreselect) setSelKey(tracePreselect);
  }, [tracePreselect]);

  const loadEvents = useCallback(async (name: string) => {
    if (!name) {
      setData(null);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const res = await fetch(`/__rana/trajectory/events?name=${encodeURIComponent(name)}`);
      const j = (await res.json()) as TraceData & { error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setData(j);
      setOpenRuns(new Set(j.runs.filter((r) => !r.history).slice(-1).map((r) => r.id)));
    } catch (e) {
      setData(null);
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadExports = useCallback(
    async (autoSelect = false) => {
      try {
        const res = await fetch("/__rana/trajectory/list");
        const j = (await res.json()) as { ok?: boolean; exports?: ExportRow[]; error?: string };
        if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        const rows = j.exports ?? [];
        setExports(rows);
        if (autoSelect && rows.length && !sel) {
          setSel(rows[0].name);
          void loadEvents(rows[0].name);
        }
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [sel, loadEvents],
  );

  useEffect(() => {
    void loadExports(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doExport = async () => {
    if (!selKey || exporting) return;
    setExporting(true);
    setExportErr("");
    try {
      const res = await fetch("/__rana/trajectory/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey: selKey }),
      });
      const j = (await res.json()) as { ok?: boolean; name?: string; error?: string };
      if (!res.ok || !j.ok || !j.name) throw new Error(j.error ?? `HTTP ${res.status}`);
      await loadExports();
      setSel(j.name);
      void loadEvents(j.name);
    } catch (e) {
      setExportErr((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const runs = useMemo(() => data?.runs ?? [], [data]);
  const totalRuns = runs.filter((r) => !r.history).length;

  return (
    <div ref={bodyRef}>
      <div className="trace-toolbar">
        <select value={selKey} onChange={(e) => setSelKey(e.target.value)} title="选要导出轨迹的会话">
          <option value="">选择会话…</option>
          {sessions.map((x) => (
            <option key={x.key} value={x.key}>
              {(x.title ?? x.key) + (x.agentId ? `（${x.agentId}）` : "")}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void doExport()} disabled={!selKey || exporting}>
          {exporting ? "导出中…（最长 3 分钟）" : "📥 导出该会话轨迹"}
        </button>
        <span className="trace-vline" />
        <select
          value={sel}
          onChange={(e) => {
            setSel(e.target.value);
            void loadEvents(e.target.value);
          }}
          title="已导出的轨迹包"
        >
          <option value="">已导出的轨迹（{exports.length}）…</option>
          {exports.map((x) => (
            <option key={x.name} value={x.name}>
              {fmtTime(x.generatedAt)} · {x.name}
              {x.sizeBytes ? `（${fmtSize(x.sizeBytes)}）` : ""}
            </option>
          ))}
        </select>
        {data && (
          <span className="trace-dim">
            {data.sessionKey ?? "?"} · {totalRuns} 轮 · {data.eventCount} 事件 · 导出于 {fmtTime(data.generatedAt)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} title="时间线显示哪些事件">
          <option value="all">全部事件</option>
          <option value="chat">只看对话</option>
          <option value="tools">只看工具</option>
        </select>
        {runs.length > 1 && (
          <button
            className="btn ghost sm"
            onClick={() => setOpenRuns(openRuns.size >= runs.length ? new Set() : new Set(runs.map((r) => r.id)))}
          >
            {openRuns.size >= runs.length ? "全部收起" : "全部展开"}
          </button>
        )}
      </div>

      {exportErr && <div className="err-banner">导出失败：{exportErr}</div>}
      {err && <div className="err-banner">读取失败：{err}</div>}
      {loading && <div className="trace-empty">读取轨迹中…</div>}

      {!loading && !runs.length && (
        <div className="trace-empty">
          还没有轨迹可看。左边选一个会话点「导出该会话轨迹」，或在会话列表右键选「🔍 轨迹回放」。
          <br />
          <span className="trace-dim">轨迹 = 她每一步想了什么、调了什么工具、结果如何、花了多少 token。导出只读不改任何会话。</span>
        </div>
      )}

      <div className="trace-list">
        {runs.map((r) => {
          const events = r.events.filter((ev) => keepEvent(ev, filter));
          if (!events.length) return null;
          return (
            <details
              key={r.id || "history"}
              className="trace-run"
              open={openRuns.has(r.id)}
              onToggle={(e) => {
                const next = new Set(openRuns);
                if ((e.target as HTMLDetailsElement).open) next.add(r.id);
                else next.delete(r.id);
                setOpenRuns(next);
              }}
            >
              <summary>
                {r.history ? (
                  <>
                    <span className="trace-run-idx">📜 早期对话</span>
                    <span className="trace-dim">无运行轨迹（导出只带回放得到的落库消息）· {r.events.length} 条</span>
                  </>
                ) : (
                  <>
                    <span className="trace-run-idx">#{r.idx}</span>
                    <span>{fmtTime(r.startedAt)}</span>
                    <span className="trace-dim">{fmtDur(r.durationMs)}</span>
                    {r.model && <span className="trace-dim">{r.model.split("/").pop()}</span>}
                    {r.stopReason && (
                      <span className={`trace-badge stop-${s(r.stopReason) || "x"}`}>stop: {r.stopReason}</span>
                    )}
                    <UsageChips usage={r.usage} />
                  </>
                )}
              </summary>
              <div className="trace-body">
                {events.map((ev) => (
                  <EventRow key={`${r.id}-${ev.seq}-${ev.type}`} ev={ev} />
                ))}
              </div>
            </details>
          );
        })}
        {!loading && data && runs.length > 0 && !runs.some((r) => r.events.some((ev) => keepEvent(ev, filter))) && (
          <div className="trace-empty">当前筛选下没有事件，换个筛选试试。</div>
        )}
      </div>
    </div>
  );
}
