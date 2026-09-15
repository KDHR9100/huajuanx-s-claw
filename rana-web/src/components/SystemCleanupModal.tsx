// 系统会话清理面板：一键清理心跳/梦境等定时任务留下的、网关限制删不掉的 cron 会话。
// 手术在 cron-session-cleanup.mjs 里做（停网关→备份→清 placement 残留→重启→删父会话），
// 这里只负责发起（可先预览）与轮询进度（GET /__rana/sessions-cleanup，1.5s 一班）。
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";

const BASE = "/__rana/sessions-cleanup";

interface CleanupLogLine {
  t: string;
  msg: string;
}

interface CleanupResult {
  parents?: { agentId: string; key: string }[];
  placementRows?: number;
  gatewayWasRunning?: boolean;
  placementDeleted?: number;
  parentsDeleted?: number;
  parentsFailed?: { key: string; error: string }[];
  backups?: string[];
  gatewayRestarted?: boolean;
}

interface CleanupStatus {
  exists: boolean;
  running: boolean;
  dryRun?: boolean;
  step?: string;
  log?: CleanupLogLine[];
  result?: CleanupResult | null;
  error?: string | null;
}

async function getStatus(): Promise<CleanupStatus | null> {
  const res = await fetch(BASE, { cache: "no-store" });
  if (!res.ok) return null;
  const j = (await res.json()) as CleanupStatus;
  return j.exists ? j : null;
}

async function startRun(dryRun: boolean): Promise<void> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dryRun }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `启动失败（HTTP ${res.status}）`);
  }
}

const STEP_LABELS: Record<string, string> = {
  init: "准备",
  scan: "盘点",
  "dry-run": "预览",
  noop: "检查",
  "stop-gateway": "停止网关",
  backup: "备份数据库",
  surgery: "清除残留（数据库手术）",
  "restart-gateway": "重启网关",
  delete: "删除会话",
  done: "完成",
};

export default function SystemCleanupModal() {
  const open = useAppStore((s) => s.cleanupOpen);
  const setOpen = useAppStore((s) => s.setCleanupOpen);
  const [status, setStatus] = useState<CleanupStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const logTailRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getStatus());
    } catch {
      // 中间件不可达（vite 没起）：保持现状
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // 轮询：任务运行中每 1.5s 拉一次进度
  useEffect(() => {
    if (!open || !status?.running) return;
    const id = setInterval(() => void refresh(), 1500);
    return () => clearInterval(id);
  }, [open, status?.running, refresh]);

  useEffect(() => {
    logTailRef.current?.scrollTo({ top: logTailRef.current.scrollHeight });
  }, [status?.log?.length]);

  if (!open) return null;

  const running = status?.running === true;
  const result = status?.result ?? null;
  const dryRan = status?.dryRun === true && !running && result?.parents !== undefined;
  const finished = !running && (result !== null || status?.error);

  const doStart = async (dryRun: boolean) => {
    if (starting || running) return;
    setStarting(true);
    setError("");
    try {
      await startRun(dryRun);
      // 立刻刷一次，把 running 状态接上
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const close = () => {
    setOpen(false);
    // 真跑完成后刷新会话列表；WS 若还没重连上会静默失败，提示用户刷新页面
    if (finished && !dryRan) void gateway.refreshSessions().catch(() => {});
  };

  const stepLabel = running ? (STEP_LABELS[status?.step ?? ""] ?? status?.step ?? "进行中") : null;
  const planParents = result?.parents ?? [];
  const logLines = (status?.log ?? []).slice(-14);

  return (
    <div className="modal-overlay" onClick={() => !running && close()}>
      <div className="modal cleanup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>🧹 清理系统会话</h3>
          {!running && (
            <button className="up-collapse" title="关闭" onClick={close}>
              ✕
            </button>
          )}
        </div>

        {/* 阶段一：说明 + 发起（预览 / 正式） */}
        {!running && !finished && (
          <>
            <div className="set-hint">
              心跳、梦境等定时任务每次执行都会开新会话，其中一部分受网关限制删不掉（KNOWN-ISSUES 有记录）。
              这里把已验证的清理流程一键化：
              <b>停止网关 → 备份 SQLite → 清除残留登记 → 重启网关 → 删除定时任务的父会话</b>。
            </div>
            <div className="cleanup-warn">
              ⚠ 正式清理会<b>停止并重启网关（约 30-60 秒）</b>，期间收发消息、微信/QQ 通道都会暂停；
              正在进行的回复会被打断。建议先「预览」看看会删什么。
            </div>
            <div className="modal-foot">
              <button className="btn ghost" disabled={starting} onClick={() => void doStart(true)}>
                {starting ? "…" : "🔍 先预览（不改动）"}
              </button>
              <button className="btn danger" disabled={starting} onClick={() => void doStart(false)}>
                {starting ? "…" : "开始清理"}
              </button>
            </div>
          </>
        )}

        {/* 阶段二：运行中（进度 + 日志） */}
        {running && (
          <>
            <div className="set-hint">
              ⏳ {stepLabel}……全程约 30-60 秒。期间连接断开、消息暂停都属正常，不用刷新页面。
            </div>
            <div className="cleanup-log" ref={logTailRef}>
              {logLines.map((l, i) => (
                <div key={i}>
                  [{l.t}] {l.msg}
                </div>
              ))}
            </div>
          </>
        )}

        {/* 阶段三：结果 */}
        {finished && (
          <>
            {status?.error ? (
              <div className="set-error">
                ⚠ 清理中断：{status.error}
                <div className="set-hint" style={{ marginTop: 4 }}>
                数据库已先行备份（见下方备份清单），可安全重试；若网关未自动恢复，请手动运行 rana-web/start-gateway.cmd。
                </div>
              </div>
            ) : dryRan ? (
              <>
                <div className="set-hint">预览结果（未做任何改动）：</div>
                <div className="cleanup-stat">
                  <span>待删的定时任务父会话</span>
                  <b>{planParents.length} 个</b>
                </div>
                {planParents.slice(0, 8).map((p) => (
                  <div className="cleanup-key" key={p.key} title={p.key}>
                    {p.agentId} · …{p.key.slice(-24)}
                  </div>
                ))}
                <div className="cleanup-stat">
                  <span>placement 残留登记行</span>
                  <b>{result?.placementRows ?? 0} 行</b>
                </div>
                <div className="set-hint">确认无误后点「开始清理」正式执行。</div>
              </>
            ) : (
              <>
                <div className="set-hint">清理完成：</div>
                <div className="cleanup-stat">
                  <span>清除的残留登记</span>
                  <b>{result?.placementDeleted ?? 0} 行</b>
                </div>
                <div className="cleanup-stat">
                  <span>删除的父会话</span>
                  <b>
                    {result?.parentsDeleted ?? 0} / {planParents.length} 个
                  </b>
                </div>
                {(result?.parentsFailed?.length ?? 0) > 0 && (
                  <div className="cleanup-fail">
                    {result?.parentsFailed?.map((f) => (
                      <div key={f.key} title={f.key}>
                        ✗ …{f.key.slice(-24)}：{f.error}
                      </div>
                    ))}
                  </div>
                )}
                <div className="set-hint">
                  run 级残留会话属上游限制仍删不掉，列表里默认隐藏（侧栏「👁 系统会话」开关可查看）。
                  网关已重启{result?.gatewayRestarted ? "✓" : "（未确认就绪，请手动检查）"}；若连接未自动恢复，刷新一下页面。
                </div>
              </>
            )}
            {(result?.backups?.length ?? 0) > 0 && (
              <details className="cleanup-backups">
                <summary>备份数据库（{result?.backups?.length} 个文件）</summary>
                {result?.backups?.map((b) => (
                  <div key={b}>{b}</div>
                ))}
              </details>
            )}
            <div className="modal-foot">
              {dryRan ? (
                <button className="btn danger" disabled={starting} onClick={() => void doStart(false)}>
                  {starting ? "…" : "开始清理"}
                </button>
              ) : undefined}
              <button className="btn ghost" onClick={close}>
                完成
              </button>
            </div>
          </>
        )}

        {error && (
          <div className="set-error" style={{ marginTop: 8 }}>
            ⚠ {error}
          </div>
        )}
      </div>
    </div>
  );
}
