// 「📊 用量」页——跨会话 token 用量总览（dsh-context 的自家版）。
// 数据：GET /__rana/usage（30s 轮询，重建中 2s 快轮询）；点会话卡直达该会话。
// 聚合规则都在服务端（usage-aggregate.ts + 单测守门），本文件只管取数与画图。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import {
  fmtTokens,
  lastNDaysKeys,
  rangeTotal,
  heatmapGrid,
  modelMix,
  agentColor,
  type UsagePayload,
} from "../lib/usage-view";

export default function UsagePage() {
  const [data, setData] = useState<UsagePayload | null>(null);
  const [err, setErr] = useState("");
  const [rebuilding, setRebuilding] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/__rana/usage");
      const j = (await res.json()) as UsagePayload;
      if (!res.ok || !j.ok) throw new Error((j as { error?: string }).error ?? "HTTP " + res.status);
      setData(j);
      setRebuilding(!!j.rebuilding);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // 重建中 2s 快轮询直到完成；平时 30s 刷新（页面挂载才轮询，切页即卸载停止）
  useEffect(() => {
    const ms = rebuilding ? 2000 : 30000;
    const t = setInterval(() => void load(), ms);
    return () => clearInterval(t);
  }, [load, rebuilding]);

  // 重建完成后立刻拉一次终态（不等 30s）
  const wasRebuilding = useRef(false);
  useEffect(() => {
    if (wasRebuilding.current && !rebuilding) void load();
    wasRebuilding.current = rebuilding;
  }, [rebuilding, load]);

  /** 重建账本：POST /rebuild，页面随之切到建账中状态（进度靠快轮询回来） */
  const rebuild = useCallback(async () => {
    try {
      const res = await fetch("/__rana/usage/rebuild", { method: "POST" });
      if (res.status === 202) setRebuilding(true);
    } catch {
      setErr("重建请求发不出去");
    }
  }, []);

  // —— 派生数据（agentFilter 一票过滤所有图卡）——
  const dayKeys30 = useMemo(() => lastNDaysKeys(30), []);
  const set30 = useMemo(() => new Set(dayKeys30), [dayKeys30]);
  const set7 = useMemo(() => new Set(lastNDaysKeys(7)), []);
  const todayKey = dayKeys30[dayKeys30.length - 1];
  const af = agentFilter === "all" ? null : agentFilter;

  const kpi = useMemo(
    () => ({
      today: rangeTotal(data?.days ?? [], new Set([todayKey]), af),
      d7: rangeTotal(data?.days ?? [], set7, af),
      d30: rangeTotal(data?.days ?? [], set30, af),
      all: rangeTotal(data?.days ?? [], null, af),
    }),
    [data, af, set7, set30, todayKey],
  );

  // 每日柱状图数据（30 天，当天为空则 0）
  const bars = useMemo(
    () =>
      dayKeys30.map((key) => {
        const d = (data?.days ?? []).find((x) => x.date === key);
        let total = 0;
        for (const [aid, au] of Object.entries(d?.agents ?? {})) {
          if (af && aid !== af) continue;
          total += au.total || 0;
        }
        return { key, total };
      }),
    [data, af, dayKeys30],
  );

  // 热力图（8 周全景，不随 agent 过滤——全景才有「日历感」）
  const heat = useMemo(() => heatmapGrid(data?.days ?? []), [data]);

  // 模型构成（近30天，随 agent 过滤）
  const mix = useMemo(() => modelMix(data?.days ?? [], set30, af), [data, set30, af]);

  // 会话榜（随 agent 过滤，前 24 名展示）
  const sessions = useMemo(
    () => (data?.sessions ?? []).filter((s) => !af || s.agentId === af).slice(0, 24),
    [data, af],
  );
  /** 点会话卡直达：确认会话还活着才跳（已清理/归档的只提示不跳） */
  const jumpToSession = (key: string) => {
    const st = useAppStore.getState();
    if (!st.sessions.some((x) => x.key === key)) {
      setErr("该会话已不在会话列表（可能已清理或归档），跳转失败");
      return;
    }
    st.setCurrentKey(key);
    st.setView("chat");
  };


  return (
    <div className="usage-page">
      <p className="page-intro">
        跨会话的 token 用量账本——会话删了历史也在。账本更新于 {data?.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : "—"}；
        页面开着时增量补账 30 秒一拍。
        <button className="btn sm ghost" onClick={() => void load()}>刷新</button>
        <button className="btn sm ghost" onClick={() => void rebuild()}>重建账本</button>
      </p>
      {err && <div className="err-banner">{err}</div>}
      {rebuilding && (
        <div className="card usage-rebuilding">
          ⏳ 建账中——
          {progressText(data?.progress)}
        </div>
      )}
      <div className="usage-chips">
        <button className={"chip" + (agentFilter === "all" ? " green" : "")} onClick={() => setAgentFilter("all")}>
          全部
        </button>
        {(data?.agents ?? []).map((a, i) => (
          <button key={a.id} className={"chip" + (agentFilter === a.id ? " green" : "")} onClick={() => setAgentFilter(a.id)}>
            <span className="usage-dot" style={{ background: agentColor(i) }} />
            {a.name}
          </button>
        ))}
      </div>
      <div className="st-grid usage-kpis">
        <div className="st-cell">
          <div className="k">今日</div>
          <div className="v">{fmtTokens(kpi.today.total)} <small>tokens</small></div>
          <small>入 {fmtTokens(kpi.today.input)} · 出 {fmtTokens(kpi.today.output)} · {kpi.today.runs} 轮</small>
        </div>
        <div className="st-cell">
          <div className="k">近 7 天</div>
          <div className="v">{fmtTokens(kpi.d7.total)} <small>tokens</small></div>
          <small>入 {fmtTokens(kpi.d7.input)} · 出 {fmtTokens(kpi.d7.output)} · {kpi.d7.runs} 轮</small>
        </div>
        <div className="st-cell">
          <div className="k">近 30 天</div>
          <div className="v">{fmtTokens(kpi.d30.total)} <small>tokens</small></div>
          <small>入 {fmtTokens(kpi.d30.input)} · 出 {fmtTokens(kpi.d30.output)} · {kpi.d30.runs} 轮</small>
        </div>
        <div className="st-cell">
          <div className="k">全部历史</div>
          <div className="v">{fmtTokens(kpi.all.total)} <small>tokens</small></div>
          <small>入 {fmtTokens(kpi.all.input)} · 出 {fmtTokens(kpi.all.output)} · {kpi.all.runs} 轮</small>
        </div>
      </div>
      <div className="card">
        <h3><span className="ic">📈</span>近 30 天每日用量（total token）</h3>
        <div className="usage-bars">
          {bars.map((b, i) => {
            const max = Math.max(1, ...bars.map((x) => x.total));
            return (
              <div key={b.key} className="usage-bar-col" title={`${b.key} · ${fmtTokens(b.total)} tokens`}>
                <div
                  className="usage-bar"
                  style={{ height: `${Math.max(2, (b.total / max) * 100)}%` }}
                />
                <span className="usage-bar-date">{i % 5 === 0 ? b.key.slice(5) : ""}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="card">
        <h3><span className="ic">🗓</span>近 8 周活动热力图（全景，不随筛选）</h3>
        <div className="usage-heat">
          <div className="usage-heat-labels">
            <span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>
          </div>
          {heat.map((week, wi) => (
            <div className="usage-heat-col" key={week[0]?.date ?? wi}>
              {week.map((c) => {
                const max = Math.max(1, ...heat.flat().map((x) => x.value));
                const pct = c.value <= 0 ? 0 : Math.max(14, Math.round(88 * Math.sqrt(c.value / max)));
                return (
                  <div
                    key={c.date}
                    className={"usage-heat-cell" + (c.date === todayKey ? " today" : "") + (c.inFuture ? " future" : "")}
                    style={{ background: c.value <= 0 ? undefined : `color-mix(in srgb, var(--accent) ${pct}%, var(--bg-panel))` }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <h3><span className="ic">🧩</span>模型构成（近 30 天）</h3>
        {mix.length === 0 ? (
          <p className="pending-text">这 30 天还没有模型调用记录。</p>
        ) : (
          <>
            <div className="ctx-seg-bar">
              {mix.map((m, i) => {
                const mixTotal = Math.max(1, mix.reduce((s, x) => s + x.total, 0));
                return (
                  <div key={m.model} className="ctx-seg" style={{ width: `${(m.total / mixTotal) * 100}%`, background: agentColor(i) }} title={`${m.model} ${fmtTokens(m.total)} tokens`} />
                );
              })}
            </div>
            <div className="ctx-legend">
              {mix.map((m, i) => (
                <span key={m.model}>
                  <span className="dot" style={{ background: agentColor(i) }} />
                  {m.model} <b>{fmtTokens(m.total)}</b>
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="card">
        <h3><span className="ic">💬</span>会话用量排行（点卡直达会话）</h3>
        {sessions.length === 0 ? (
          <p className="pending-text">还没有会话用量记录。</p>
        ) : (
          <div className="usage-sess">
            {sessions.map((s) => {
              const idx = (data?.agents ?? []).findIndex((a) => a.id === s.agentId);
              const rel = relTime(s.lastTs);
              return (
                <button key={s.key} className="usage-sess-row" onClick={() => jumpToSession(s.key)}>
                  <span className="usage-dot" style={{ background: agentColor(idx >= 0 ? idx : 99) }} />
                  <span className="usage-sess-name">{s.label || s.key}</span>
                  <span className="usage-sess-meta">
                    {fmtTokens(s.total)} tokens · {s.runs} 轮 · {rel}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 进度文案（建账横幅用） */
function progressText(p?: UsagePayload["progress"]): string {
  if (!p) return "准备中…";
  if (p.phase === "scanning") return `扫描 ${p.agentId || "…"}（${p.rowsDone}/${p.rowsTotal} 行）`;
  if (p.phase === "error") return `出错了：${p.error ?? "未知错误"}`;
  if (p.phase === "done") return "完成";
  return "数库中…";
}

/** 相对时间（会话卡最近活跃） */
function relTime(tsMs: number): string {
  if (!tsMs) return "—";
  const m = Math.round((Date.now() - tsMs) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
