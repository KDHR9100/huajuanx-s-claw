// 审批页：闸门的控制台（数据走 /__rana/approvals 中间件，直读 state 库 + 官方 CLI resolve）。
// 三块：挂起的审批卡（批准一次/拒绝，15 分钟寿命倒计时）、审批历史（含超时/作废）、长期许可清单。
// 挂起卡 10 秒轮询刷新；历史与许可手动刷新（带 ?withGrants=1，CLI 子进程较慢不进轮询）。
import { useCallback, useEffect, useState } from "react";
import { gateway } from "../lib/gateway";
import { useAppStore } from "../store/useAppStore";

interface ApprovalRow {
  id: string;
  kind: string;
  commandText: string;
  warningText?: string;
  sessionKey: string;
  agentId: string;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs: number | null;
  decision: string | null;
  terminalReason: string | null;
  resolverId: string | null;
  status: string;
}

interface Snapshot {
  pending: ApprovalRow[];
  history: ApprovalRow[];
  allowlist: Array<{ pattern: string; lastUsedAtMs?: number }>;
  grants?: string;
}

/** 会话 key 友好化：agent:main:main:heartbeat → 心跳（main） */
function sessionLabel(key: string) {
  if (!key) return "—";
  if (key.endsWith(":heartbeat")) return "心跳";
  if (key.includes(":cron:")) return `定时任务 ${key.split(":cron:")[1]?.slice(0, 8)}…`;
  if (key === "agent:main:main") return "主会话";
  if (key.includes(":dashboard")) return "面板会话";
  return key;
}

const TERMINAL_LABELS: Record<string, string> = {
  "run-aborted": "任务被中止",
  "approval-scope-closed": "会话关闭·自动拒",
  timeout: "超时作废",
  expired: "过期作废",
};

function terminalLabel(r: ApprovalRow) {
  if (r.decision === "allow" || r.decision === "allow-once") return "已批准";
  if (r.decision === "deny") return "已拒绝";
  return TERMINAL_LABELS[r.terminalReason ?? ""] ?? r.terminalReason ?? r.status;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtAgo(ts?: number) {
  if (!ts) return "没用过";
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 60) return `${Math.max(1, min)} 分钟前`;
  if (min < 60 * 24) return `${Math.round(min / 60)} 小时前`;
  return `${Math.round(min / 60 / 24)} 天前`;
}

/** 挂起卡剩余寿命（分钟级够用，轮询 10s 刷新） */
function fmtLeft(expiresAtMs: number) {
  const min = Math.round((expiresAtMs - Date.now()) / 60000);
  return min > 0 ? `剩 ${min} 分钟` : "即将作废";
}

export default function ApprovalsPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (full = false) => {
    try {
      const res = await fetch(`/__rana/approvals${full ? "?withGrants=1" : ""}`);
      const data = (await res.json()) as Snapshot & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSnap(data);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(true); // 进页带许可清单
    const timer = setInterval(() => void load(), 10_000); // 倒计时/新卡
    const offConn = gateway.onConnected(() => void load(true)); // 网关重启后审批状态会变
    return () => {
      clearInterval(timer);
      offConn();
    };
  }, [load]);

  const resolve = async (id: string, decision: "allow-once" | "deny") => {
    if (busy) return;
    setBusy(id + decision);
    setNotice("");
    try {
      const res = await fetch("/__rana/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNotice(decision === "deny" ? "已拒绝。" : "已批准（仅这一次）。");
      await load();
    } catch (e) {
      setError(`处理失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const pending = snap?.pending ?? [];

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 840 }}>
        <div className="page-intro">
          <h2>审批</h2>
          <p>
            她想跑的命令会先到这里等您点头，15 分钟没人批就自动作废。
            {error && (
              <span
                className="sys-err"
                style={{ cursor: "pointer" }}
                onClick={() => void load(true)}
                title="点一下重试"
              >
                （{error} · 点击重试）
              </span>
            )}
          </p>
        </div>

        <div className="task-list">
          <div className="task-group">
            <div className="tg-label">
              ⏳ 等您批<span className="tg-count">{pending.length}</span>
            </div>
            {snap === null && !error && (
              <div className="card pending">
                <p className="pending-text">……在看。</p>
              </div>
            )}
            {snap !== null && pending.length === 0 && <div className="task-foot">现在没有等着批的，都安分。</div>}
            {pending.map((a) => (
              <div className="task" key={a.id}>
                <div className="t-ic">🔐</div>
                <div className="t-main">
                  <div className="t-name">
                    <code style={{ fontSize: 12, wordBreak: "break-all" }}>{a.commandText || a.kind}</code>
                  </div>
                  <div className="t-desc">
                    {sessionLabel(a.sessionKey)} · {a.agentId} · {fmtTime(a.createdAtMs)} 起 · {fmtLeft(a.expiresAtMs)}
                  </div>
                  {a.warningText && <div className="t-desc">⚠ {a.warningText}</div>}
                </div>
                <div className="t-side" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <button
                    className="t-run"
                    disabled={busy !== ""}
                    onClick={() => void resolve(a.id, "allow-once")}
                    title="只放行这一次"
                  >
                    ✓ 批准
                  </button>
                  <button
                    className="t-run"
                    style={{ borderColor: "var(--danger, #e5484d)" }}
                    disabled={busy !== ""}
                    onClick={() => void resolve(a.id, "deny")}
                    title="拒绝本次执行"
                  >
                    ✕ 拒绝
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="task-group">
            <div className="tg-label">
              📜 历史（最近 {snap?.history.length ?? 0} 条）<span className="tg-count">{snap?.history.length ?? 0}</span>
            </div>
            {(snap?.history ?? []).map((a) => (
              <div className="task" key={a.id}>
                <div className="t-ic">{a.decision === "deny" ? "🚫" : "✅"}</div>
                <div className="t-main">
                  <div className="t-name">
                    <code style={{ fontSize: 12, wordBreak: "break-all" }} title={a.commandText}>
                      {(a.commandText || a.kind).slice(0, 90)}
                      {(a.commandText || "").length > 90 ? "…" : ""}
                    </code>
                  </div>
                  <div className="t-desc">
                    {fmtTime(a.resolvedAtMs ?? a.createdAtMs)} · {sessionLabel(a.sessionKey)} ·{" "}
                    {a.resolverId === "approval-scope-closed" ? "系统" : a.resolverId ?? "—"}
                  </div>
                </div>
                <div className="t-side">
                  <div className="t-status">{terminalLabel(a)}</div>
                </div>
              </div>
            ))}
            {snap !== null && (snap.history?.length ?? 0) === 0 && <div className="task-foot">还没有历史记录。</div>}
          </div>

          <div className="task-group">
            <div className="tg-label">
              🔑 长期许可（allowlist / grants）<span className="tg-count">{snap?.allowlist?.length ?? 0}</span>
            </div>
            {(snap?.allowlist ?? []).map((w, i) => (
              <div className="task" key={i}>
                <div className="t-ic">🔑</div>
                <div className="t-main">
                  <div className="t-name">
                    <code style={{ fontSize: 12 }}>{w.pattern}</code>
                  </div>
                  <div className="t-desc">路径级放行 · 上次使用 {fmtAgo(w.lastUsedAtMs)}</div>
                </div>
              </div>
            ))}
            {snap !== null && (snap.allowlist?.length ?? 0) === 0 && <div className="task-foot">allowlist 为空。</div>}
            <div className="task-foot" style={{ whiteSpace: "pre-wrap" }}>
              {snap?.grants || "standing grants：打开本页时读取。"}
            </div>
          </div>
        </div>

        {notice && <div className="task-foot">{notice}</div>}
        <div className="task-foot">
          挂起的卡 10 秒自动刷新 · 批准只对这一次有效（长期许可要在命令行加 allowlist） ·{" "}
          <button
            className="btn ghost"
            style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={() => useAppStore.getState().setCleanupOpen(true)}
            title="清理心跳/梦境等定时任务留下的删不掉会话（会短暂重启网关）"
          >
            🧹 清理系统会话
          </button>
        </div>
      </div>
    </div>
  );
}
