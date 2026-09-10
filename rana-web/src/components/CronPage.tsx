// 定时任务页：她的作息表（真数据，走 gateway WS RPC）。
// 列表（含停用）+ 启停开关（cron.update）+ 立即跑一次（cron.run，runId 入队式）；
// cron 事件到达自动刷新；新建/编辑/删除继续用命令行（本期不做）。
import { useCallback, useEffect, useState } from "react";
import { gateway } from "../lib/gateway";

interface CronJob {
  id: string;
  name?: string;
  displayName?: string;
  agentId?: string;
  enabled: boolean;
  schedule?: { kind?: string; expr?: string; everyMs?: number };
  sessionTarget?: string;
  payload?: { kind?: string };
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
  };
}

const JOB_ICONS: Array<[RegExp, string]> = [
  [/git-activity/i, "🐾"],
  [/memory-bridge/i, "🌉"],
  [/private-memory/i, "🔐"],
  [/heartbeat/i, "💗"],
  [/dreaming/i, "💭"],
  [/skill-collection/i, "🧰"],
  [/morning-report/i, "📰"],
  [/backup/i, "📦"],
];

function jobIcon(name: string) {
  for (const [re, icon] of JOB_ICONS) if (re.test(name)) return icon;
  return "⏰";
}

function fmtNext(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = Date.now();
  if (ts > now) {
    const min = Math.round((ts - now) / 60000);
    if (min < 60) return `${min} 分钟后`;
    if (min < 60 * 24) return `${Math.round(min / 60)} 小时后`;
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtLast(ts?: number) {
  if (!ts) return "还没跑过";
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  if (min < 60 * 24) return `${Math.round(min / 60)} 小时前`;
  return `${Math.round(min / 60 / 24)} 天前`;
}

function scheduleText(j: CronJob) {
  const s = j.schedule ?? {};
  if (s.kind === "cron" && s.expr) return `cron ${s.expr}`;
  if (s.kind === "every" && s.everyMs) {
    const min = s.everyMs / 60000;
    return min >= 60 ? `每 ${Math.round(min / 60)} 小时` : `每 ${Math.round(min)} 分钟`;
  }
  return s.kind ?? "—";
}

export default function CronPage() {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>(""); // 操作中的任务 id
  const [runNotice, setRunNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await gateway.request<{ jobs?: CronJob[] }>("cron.list", { includeDisabled: true });
      setJobs(res.jobs ?? []);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const off = gateway.onCronEvent(() => void load());
    return off;
  }, [load]);

  const toggle = async (job: CronJob) => {
    if (busy) return;
    setBusy(job.id);
    try {
      await gateway.request("cron.update", { jobId: job.id, patch: { enabled: !job.enabled } });
      await load();
    } catch (e) {
      setError(`切换失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const runNow = async (job: CronJob) => {
    if (busy) return;
    setBusy(job.id);
    setRunNotice("");
    try {
      const res = await gateway.request<{ runId?: string }>("cron.run", { jobId: job.id });
      setRunNotice(`已排队运行「${job.displayName ?? job.name}」${res.runId ? `（run ${res.runId.slice(0, 8)}…）` : ""}，跑完列表会自己刷新。`);
    } catch (e) {
      setError(`运行失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 840 }}>
        <div className="page-intro">
          <h2>定时任务</h2>
          <p>……都在按点干活。{error && <span className="sys-err">（{error}）</span>}</p>
        </div>
        <div className="task-list">
          {jobs === null && !error && <div className="card pending"><p className="pending-text">……在数。</p></div>}
          {jobs?.map((j) => {
            const name = j.displayName ?? j.name ?? j.id.slice(0, 8);
            const last = j.state?.lastRunStatus;
            // 系统收敛任务（技能回顾/心跳）：gateway 禁止客户端启停，UI 只读展示
            const systemOwned = j.payload?.kind === "skillCollectionReview" || j.payload?.kind === "heartbeat";
            const kindLabel =
              j.payload?.kind === "command"
                ? "命令"
                : j.payload?.kind === "systemEvent"
                  ? "系统事件"
                  : j.payload?.kind === "skillCollectionReview"
                    ? "技能回顾"
                    : j.payload?.kind === "heartbeat"
                      ? "心跳"
                      : (j.payload?.kind ?? "");
            const statusChip = !j.enabled
              ? <span className="chip">⏸ 停用</span>
              : last === "ok"
                ? <span className="chip green">✓ 正常</span>
                : last === "skipped"
                  ? <span className="chip warn">⏭ 跳过</span>
                  : last
                    ? <span className="chip warn">✗ {last}</span>
                    : <span className="chip">· 空闲</span>;
            return (
              <div className="task" key={j.id}>
                <div className="t-ic">{jobIcon(j.name ?? "")}</div>
                <div className="t-main">
                  <div className="t-name">
                    {name}
                    {statusChip}
                    {systemOwned && <span className="chip" title="系统收敛任务，由 OpenClaw 配置管理，页面不可启停">⚙ 系统</span>}
                    {j.agentId && j.agentId !== "main" && <span className="chip">{j.agentId}</span>}
                  </div>
                  <div className="t-desc">
                    {scheduleText(j)} · {kindLabel} ·{" "}
                    {j.sessionTarget === "main" ? "主会话" : j.sessionTarget === "isolated" ? "隔离运行" : j.sessionTarget} · 下次 {fmtNext(j.state?.nextRunAtMs)}
                  </div>
                </div>
                <div className="t-side">
                  <div className="t-status">
                    上次<br />
                    <span className={last === "ok" ? "ok" : last === "skipped" ? "skip" : ""}>{fmtLast(j.state?.lastRunAtMs)}</span>
                  </div>
                  <button
                    className="t-run"
                    disabled={busy !== "" || !j.enabled || systemOwned}
                    onClick={() => void runNow(j)}
                    title={systemOwned ? "系统任务不可手动运行" : "立即排队运行一次"}
                  >
                    ▶ 跑一次
                  </button>
                  <button
                    className={`sw${j.enabled ? " on" : ""}`}
                    disabled={busy !== "" || systemOwned}
                    onClick={() => void toggle(j)}
                    title={systemOwned ? "系统任务由配置管理（skills.workshop.autonomous.mode）" : j.enabled ? "点击停用" : "点击启用"}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {runNotice && <div className="task-foot">{runNotice}</div>}
        <div className="task-foot">新建 / 改时间 / 删除：先用命令行（openclaw cron …）· 页面操作会即时生效</div>
      </div>
    </div>
  );
}
