// QQ 陪伴页：看/管 QQ 陪伴链路——SnowLuma（消息搬运工）+ qq-sidecar（桥）。
// SnowLuma 卡：端口探测在线状态 + 一键启动（重启电脑后它不会自启，断连时在这修复）。
// 边车卡：是否在跑、登录的 QQ、WS 连接、群友感参数、最近收到的消息与回复、日志尾巴，以及启动/停止/重启。
// 数据来自 /__rana/qq-sidecar（读 sidecar 自己写的心跳与活动日志 + TCP 探测 SnowLuma），本页不写 SnowLuma 任何配置。
import { useCallback, useEffect, useState } from "react";
import { fmtDayTimeOr as fmtTime } from "../lib/fmt";

interface SidecarStatus {
  pid: number;
  startedAt: number;
  updatedAt: number;
  account: { uin?: number | string; nickname?: string } | null;
  ws: string;
  groups: string[];
  private: string[];
  agent: string;
  persona: Record<string, unknown>;
  stats: { received: number; replied: number; lurked: number; failed: number };
  lastMessageAt: number;
  lastReplyAt: number;
  lastError: string;
}

interface ActivityRow {
  ts: number;
  type: "in" | "reply" | "lurk" | string;
  groupId?: string | null;
  userId?: string;
  name?: string;
  text?: string;
  preview?: string;
  reason?: string;
  chunks?: number;
  ms?: number;
  addressed?: boolean;
}

interface RhythmLastNight {
  game: string;
  minutes: number;
  windowLabel: string;
}

/** /__rana/qq-sidecar 的 rhythm 字段（哨兵账本聚合，读不到时整个为 null） */
interface OwnerRhythm {
  day: string;
  idleSkipMinutes: number;
  focusTop5: Array<{ name: string; minutes: number }>;
  yesterday: { day: string; top: Array<{ name: string; minutes: number }> } | null;
  lastNight: RhythmLastNight | null;
  nagsLastNight: number;
  nagTimes: string[];
  weekHistory: Array<{ day: string; totalFocusMinutes: number | null }>;
  updatedAt: string | null;
}

interface SidecarResp {
  running: boolean;
  stale: boolean;
  status: SidecarStatus | null;
  config: {
    exists: boolean;
    agent: string;
    groups: string[];
    private: string[];
    privateCount: number;
    persona: Record<string, unknown>;
    maxChars: number;
  };
  logs: string[];
  activity: ActivityRow[];
  now: number;
  entryExists: boolean;
  snowluma?: { running: boolean; wsPort: number; homeDir: string };
  rhythm?: OwnerRhythm | null;
}

const fmtUptime = (startedAt?: number) => {
  if (!startedAt) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分 ${sec % 60} 秒`;
};

const rowStyle = { display: "flex", gap: 8, padding: "4px 0", fontSize: 13 } as const;
const labelStyle = { opacity: 0.65, minWidth: 96 } as const;
const inputStyle = { width: "100%", padding: "4px 6px", fontSize: 13, boxSizing: "border-box" } as const;
const formLabel = { display: "block", fontSize: 13 } as const;

// ===== 🌙 今日作息卡（2026-11-15）：哨兵账本只读快照，键鼠空闲超线不计专注 =====

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** "2026-11-15" -> "11-15 周六"（解析不动就原样返回，不编日期） */
const dayChipLabel = (day: string) => {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : `${d.getMonth() + 1}-${d.getDate()} ${WEEKDAY_NAMES[d.getDay()]}`;
};
/** 分钟 -> "3小时12分" / "1小时" / "46分" */
const fmtMinutes = (min: number) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`;
  return `${m}分`;
};

function RhythmCard({ rhythm }: { rhythm: OwnerRhythm | null | undefined }) {
  if (!rhythm) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>🌙 今日作息 <small>主人状态哨兵的账本快照</small></h3>
        <div className="rhythm-empty">账本还在积累，今晚再看。哨兵账本（owner-usage.json）还没写出来，读不到就不编数。</div>
      </div>
    );
  }
  const hasFocus = rhythm.focusTop5.length > 0;
  const hasWeek = rhythm.weekHistory.some((d) => d.totalFocusMinutes != null && d.totalFocusMinutes > 0);
  const hasNight = Boolean(rhythm.lastNight) || rhythm.nagsLastNight > 0;
  const topMax = Math.max(1, ...rhythm.focusTop5.map((x) => x.minutes));
  const weekVals = rhythm.weekHistory.map((d) => d.totalFocusMinutes).filter((v): v is number => v != null && v > 0);
  const weekMax = Math.max(1, ...weekVals);
  const heatLevel = (v: number | null) => (v == null || v <= 0 ? 0 : v / weekMax <= 0.34 ? 1 : v / weekMax <= 0.67 ? 2 : 3);

  if (!hasFocus && !hasWeek && !hasNight) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>🌙 今日作息 <span className="rhythm-chip">{dayChipLabel(rhythm.day)}</span> <small>每分钟快照 · 键鼠空闲≥{rhythm.idleSkipMinutes}分不计专注</small></h3>
        <div className="rhythm-empty">账本还在积累，今晚再看。</div>
        <div className="rhythm-foot">🔒 数据只在自家电脑上 · owner-usage.json</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3>
        🌙 今日作息 <span className="rhythm-chip">{dayChipLabel(rhythm.day)}</span>{" "}
        <small>每分钟快照 · 键鼠空闲≥{rhythm.idleSkipMinutes}分不计专注</small>
      </h3>

      {hasFocus && (
        <>
          <div className="rhythm-sec">今日专注 TOP 5</div>
          <div className="rhythm-bars">
            {rhythm.focusTop5.map((x) => (
              <div key={x.name} className="rhythm-row" title={`${x.name}：${fmtMinutes(x.minutes)}`}>
                <span className="rhythm-name">{x.name}</span>
                <span className="rhythm-track">
                  <span className="rhythm-fill" style={{ width: `${Math.max(3, Math.round((x.minutes / topMax) * 100))}%` }} />
                </span>
                <span className="rhythm-min">{fmtMinutes(x.minutes)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {hasNight && (
        <>
          <div className="rhythm-sec">昨晚</div>
          <div className="rhythm-night">
            {rhythm.lastNight && (
              <div className="rhythm-night-main">
                <span>
                  🌙 昨晚 {rhythm.lastNight.windowLabel} {rhythm.lastNight.game}
                </span>
                <span className="rhythm-night-min">
                  {rhythm.lastNight.minutes >= 60 ? `${(rhythm.lastNight.minutes / 60).toFixed(1)}h` : `${rhythm.lastNight.minutes}分`}
                </span>
              </div>
            )}
            {rhythm.nagsLastNight > 0 && (
              <div className="rhythm-night-sub">
                深夜窗口有催睡 {rhythm.nagsLastNight} 次（{rhythm.nagTimes.join("、")}）
              </div>
            )}
          </div>
        </>
      )}

      <div className="rhythm-sec">近 7 天 · 每日专注总时长</div>
      <div className="rhythm-week">
        {rhythm.weekHistory.map((d, i) => {
          const isToday = i === rhythm.weekHistory.length - 1;
          const level = heatLevel(d.totalFocusMinutes);
          const label = d.day.slice(8, 10); // "2026-11-15" -> "15"（格子小，完整日期放悬浮提示）
          return (
            <div key={d.day} className="rhythm-day">
              <span
                className={`rhythm-cell l${level}${isToday ? " today" : ""}`}
                title={`${d.day}：${d.totalFocusMinutes == null ? "未积累" : fmtMinutes(d.totalFocusMinutes)}`}
              />
              <span className="rhythm-day-num">{label}</span>
            </div>
          );
        })}
        <div className="rhythm-legend">
          <i style={{ background: "color-mix(in srgb, var(--accent) 35%, var(--bg-panel))" }} />
          <i style={{ background: "color-mix(in srgb, var(--accent) 65%, var(--bg-panel))" }} />
          <i style={{ background: "var(--accent)" }} />
          <span>少→多</span>
        </div>
      </div>

      <div className="rhythm-foot">🔒 数据只在自家电脑上 · owner-usage.json</div>
    </div>
  );
}

export default function QqSidecarPage() {
  const [data, setData] = useState<SidecarResp | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [groupsText, setGroupsText] = useState("");
  const [privateText, setPrivateText] = useState("");
  const [form, setForm] = useState({
    mergeSec: 3.5,
    intervalSec: 8,
    lurkPct: 30,
    emojiPct: 35,
    maxChars: 500,
    atTrigger: true,
    keywords: "",
  });
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [snowMsg, setSnowMsg] = useState("");
  const running = Boolean(data?.running);
  const snowlumaRunning = Boolean(data?.snowluma?.running);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/__rana/qq-sidecar");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as SidecarResp);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  // 没有未保存修改时，表单跟着服务端配置走（每 5 秒的轮询不会打断正在编辑的内容）
  useEffect(() => {
    if (!data || dirty) return;
    const p = (data.config.persona ?? {}) as Record<string, unknown>;
    setGroupsText(data.config.groups.join(", "));
    setPrivateText((data.config.private ?? []).join(", "));
    setForm({
      mergeSec: Number(p.mergeWindowMs ?? 3500) / 1000,
      intervalSec: Number(p.minReplyIntervalMs ?? 8000) / 1000,
      lurkPct: Math.round(Number(p.lurkRate ?? 0.3) * 100),
      emojiPct: Math.round(Number(p.emojiRate ?? 0.35) * 100),
      maxChars: Number(data.config.maxChars ?? 500),
      atTrigger: p.atTrigger !== false,
      keywords: Array.isArray(p.keywordTrigger) ? (p.keywordTrigger as string[]).join("、") : "",
    });
  }, [data, dirty]);

  const control = async (action: "start" | "stop" | "restart") => {
    if (busy) return;
    setBusy(action);
    setMsg("");
    try {
      const r = await fetch("/__rana/qq-sidecar/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const out = (await r.json()) as { ok?: boolean; error?: string; already?: boolean; pid?: number };
      if (out.ok === false) setMsg(`失败：${out.error ?? "未知原因"}`);
      else if (out.already) setMsg(action === "start" ? "本来就在跑" : "本来就没在跑");
      else setMsg(action === "start" ? `已启动（PID ${out.pid ?? "?"}）` : action === "stop" ? "已停止" : "已重启");
      await new Promise((res) => setTimeout(res, 800));
      await load();
    } catch (e) {
      setMsg(`失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  /** 启动 SnowLuma（消息搬运工）：发一次控制命令，端口通了状态卡自己变绿（页面每 5 秒轮询）。 */
  const startSnowLuma = async () => {
    if (busy) return;
    setBusy("snowluma");
    setSnowMsg("");
    try {
      const r = await fetch("/__rana/qq-sidecar/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start-snowluma" }),
      });
      const out = (await r.json()) as { ok?: boolean; error?: string };
      if (out.ok === false) {
        setSnowMsg(`失败：${out.error ?? "未知原因"}`);
        return;
      }
      setSnowMsg("启动命令已发出，几秒后状态会自己变绿；半分钟还不通就去 SnowLuma 安装目录的 logs/ 看它的日志。");
    } catch (e) {
      setSnowMsg(`失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const splitList = (s: string) => s.split(/[\s,，;；、]+/).map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    if (busy) return;
    setBusy("save");
    setSaveMsg("");
    try {
      const body = {
        allow: { groups: splitList(groupsText), private: splitList(privateText) },
        persona: {
          mergeWindowMs: Math.round(form.mergeSec * 1000),
          minReplyIntervalMs: Math.round(form.intervalSec * 1000),
          lurkRate: form.lurkPct / 100,
          emojiRate: form.emojiPct / 100,
          atTrigger: form.atTrigger,
          keywordTrigger: splitList(form.keywords),
        },
        reply: { maxChars: Math.round(form.maxChars) },
      };
      const r = await fetch("/__rana/qq-sidecar/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || out.ok === false) {
        setSaveMsg(`保存失败：${out.error ?? `HTTP ${r.status}`}`);
        return;
      }
      setDirty(false);
      let note = "";
      if (running) {
        const rr = await fetch("/__rana/qq-sidecar/control", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "restart" }),
        });
        const ro = (await rr.json()) as { ok?: boolean; error?: string };
        note = ro.ok === false ? `；重启失败：${ro.error ?? "未知原因"}` : "；已重启生效";
      }
      setSaveMsg(`已保存${note}`);
      await new Promise((res) => setTimeout(res, 900));
      await load();
    } catch (e) {
      setSaveMsg(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const st = data?.status ?? null;
  const activity = [...(data?.activity ?? [])].reverse();

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 1000 }}>
        <div className="page-intro">
          <h2>QQ 陪伴</h2>
          <p>
            SnowLuma 的 QQ 消息走这个边车进 OpenClaw 的 rana-qq-public · 群友感：合并窗口 / 节流 / 点名必回 / 偶尔潜水
            {error && <span className="sys-err">（{error}）</span>}
          </p>
        </div>

        {/* 🌙 今日作息：哨兵账本快照（owner-usage.json 等仅本机文件，读不到降级空态） */}
        <RhythmCard rhythm={data?.rhythm} />

        {/* SnowLuma（消息搬运工）状态 + 启动 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>
            {snowlumaRunning ? "🟢 SnowLuma 在线" : "❌ SnowLuma 没在运行"}{" "}
            <small>消息搬运工 · 探测端口 {data?.snowluma?.wsPort ?? 3001}</small>
          </h3>
          <div className="dsh-actions" style={{ marginBottom: 8 }}>
            <button className="btn" disabled={Boolean(busy) || snowlumaRunning} onClick={() => void startSnowLuma()}>
              {busy === "snowluma" ? "启动中…" : "启动 SnowLuma"}
            </button>
            {snowMsg && <span className={snowMsg.startsWith("失败") ? "sys-err" : "dsh-ok"}>{snowMsg}</span>}
          </div>
          {!snowlumaRunning && (
            <p className="sys-err" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
              它是挂在 QQ 本体上的「消息搬运工」：把群消息搬进边车、把回复搬回 QQ，没它整条链路不通，下面的边车跑得再好也没消息可搬。
              电脑重启后它不会自己起来（老规矩：开机不自启），点上面的按钮即可。
              {data?.snowluma?.homeDir ? ` 安装位置：${data.snowluma.homeDir}；老起不来就看 ${data.snowluma.homeDir}\\logs\\ 里的日志。` : ""}
            </p>
          )}
        </div>

        {/* 运行状态 + 启停 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>
            {running ? "🟢 边车运行中" : "⚪ 边车已停止"}{" "}
            <small>{st ? `PID ${st.pid} · 已运行 ${fmtUptime(st.startedAt)}` : "没有心跳"}</small>
          </h3>
          <div className="dsh-actions" style={{ marginBottom: 8 }}>
            <button className="btn" disabled={Boolean(busy) || running} onClick={() => void control("start")}>
              {busy === "start" ? "启动中…" : "启动"}
            </button>
            <button className="btn" disabled={Boolean(busy) || !running} onClick={() => void control("stop")}>
              {busy === "stop" ? "停止中…" : "停止"}
            </button>
            <button className="btn" disabled={Boolean(busy) || !running} onClick={() => void control("restart")}>
              {busy === "restart" ? "重启中…" : "重启"}
            </button>
            {msg && <span className={msg.startsWith("失败") ? "sys-err" : "dsh-ok"}>{msg}</span>}
          </div>

          <div style={rowStyle}><span style={labelStyle}>QQ 号</span><span>{st?.account?.uin ?? "—"} {st?.account?.nickname ?? ""}</span></div>
          <div style={rowStyle}><span style={labelStyle}>OneBot WS</span><span>{st?.ws === "connected" ? "已连接" : st?.ws === "connecting" ? "连接中…" : "未连接（自动重连中）"}</span></div>
          <div style={rowStyle}><span style={labelStyle}>智能体</span><span>{st?.agent || data?.config.agent || "—"}</span></div>
          <div style={rowStyle}><span style={labelStyle}>白名单群</span><span>{st?.groups?.join("、") || data?.config.groups?.join("、") || "—"}</span></div>
          <div style={rowStyle}><span style={labelStyle}>最近收消息</span><span>{fmtTime(st?.lastMessageAt)}</span></div>
          <div style={rowStyle}><span style={labelStyle}>最近回消息</span><span>{fmtTime(st?.lastReplyAt)}</span></div>
          <div style={rowStyle}>
            <span style={labelStyle}>累计</span>
            <span>
              收 {st?.stats.received ?? 0} · 回 {st?.stats.replied ?? 0} · 潜水 {st?.stats.lurked ?? 0} · 失败 {st?.stats.failed ?? 0}
            </span>
          </div>
          {st?.lastError && <div style={{ ...rowStyle, color: "#e66" }}><span style={labelStyle}>最近错误</span><span>{st.lastError}</span></div>}
          {data?.stale && <div className="sys-err">心跳已过期，进程可能卡住，可点「重启」。</div>}
          {!data?.config.exists && (
            <div className="sys-err" style={{ marginTop: 6 }}>
              还没有 config.json：复制 qq-sidecar/config.example.json，填好 onebot.homeDir 再启动。
            </div>
          )}
        </div>

        {/* 可设置项：白名单 + 群友感 + 单条字数 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>
            ⚙️ 可设置项 <small>保存后自动重启 sidecar 生效；只写 config.json，不碰 token</small>
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 10 }}>
            <label style={formLabel}>
              群白名单（逗号/空格分隔）
              <textarea
                rows={3}
                style={inputStyle}
                value={groupsText}
                placeholder="例如 123456789, 987654321"
                onChange={(e) => {
                  setGroupsText(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <label style={formLabel}>
              私聊白名单（QQ 号）
              <textarea
                rows={3}
                style={inputStyle}
                value={privateText}
                placeholder="留空就是私聊一概不回"
                onChange={(e) => {
                  setPrivateText(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <label style={formLabel}>
              合并窗口（秒）
              <input
                type="number"
                min={0}
                max={60}
                step={0.5}
                style={inputStyle}
                value={form.mergeSec}
                onChange={(e) => {
                  setForm({ ...form, mergeSec: Number(e.target.value) });
                  setDirty(true);
                }}
              />
            </label>
            <label style={formLabel}>
              回复节流（秒）
              <input
                type="number"
                min={0}
                max={600}
                step={1}
                style={inputStyle}
                value={form.intervalSec}
                onChange={(e) => {
                  setForm({ ...form, intervalSec: Number(e.target.value) });
                  setDirty(true);
                }}
              />
            </label>
            <label style={formLabel}>
              潜水概率（%，0=每句都回）
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                style={inputStyle}
                value={form.lurkPct}
                onChange={(e) => {
                  setForm({ ...form, lurkPct: Number(e.target.value) });
                  setDirty(true);
                }}
              />
            </label>
            <label style={formLabel}>
              表情概率（%）
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                style={inputStyle}
                value={form.emojiPct}
                onChange={(e) => {
                  setForm({ ...form, emojiPct: Number(e.target.value) });
                  setDirty(true);
                }}
              />
            </label>
            <label style={formLabel}>
              单条最大字数
              <input
                type="number"
                min={100}
                max={2000}
                step={50}
                style={inputStyle}
                value={form.maxChars}
                onChange={(e) => {
                  setForm({ ...form, maxChars: Number(e.target.value) });
                  setDirty(true);
                }}
              />
            </label>
            <label style={{ ...formLabel, display: "flex", alignItems: "center", gap: 6, paddingTop: 18 }}>
              <input
                type="checkbox"
                checked={form.atTrigger}
                onChange={(e) => {
                  setForm({ ...form, atTrigger: e.target.checked });
                  setDirty(true);
                }}
              />
              @/点名必回
            </label>
            <label style={{ ...formLabel, gridColumn: "1 / -1" }}>
              点名关键词（顿号/逗号分隔，不区分大小写）
              <input
                type="text"
                style={inputStyle}
                value={form.keywords}
                placeholder="rana、乐奈、rana酱"
                onChange={(e) => {
                  setForm({ ...form, keywords: e.target.value });
                  setDirty(true);
                }}
              />
            </label>
          </div>
          <div className="dsh-actions" style={{ marginTop: 10 }}>
            <button className="btn" disabled={Boolean(busy)} onClick={() => void save()}>
              {busy === "save" ? "保存中…" : running ? "保存并重启" : "保存"}
            </button>
            {dirty && !saveMsg && <span style={{ fontSize: 12, opacity: 0.6 }}>有未保存的修改</span>}
            {saveMsg && <span className={saveMsg.startsWith("保存失败") ? "sys-err" : "dsh-ok"}>{saveMsg}</span>}
          </div>
        </div>

        {/* 最近活动 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>
            📨 最近活动 <small>最新在上，每 5 秒刷新</small>
          </h3>
          {activity.length === 0 ? (
            <p style={{ opacity: 0.6, fontSize: 13 }}>还没有活动记录。</p>
          ) : (
            <div style={{ maxHeight: 320, overflow: "auto" }}>
              {activity.map((a, i) => (
                <div key={`${a.ts}-${i}`} style={{ ...rowStyle, borderTop: i ? "1px dashed rgba(127,127,127,.2)" : undefined }}>
                  <span style={{ ...labelStyle, minWidth: 108 }}>{fmtTime(a.ts)}</span>
                  <span style={{ minWidth: 52 }}>
                    {a.type === "in" ? "💬 收到" : a.type === "reply" ? "📤 回复" : a.type === "lurk" ? "💤 潜水" : a.type}
                  </span>
                  <span style={{ flex: 1 }}>
                    {a.type === "in" && `${a.name ?? ""}(${a.userId ?? ""})：${a.text ?? ""}`}
                    {a.type === "reply" && `${a.chunks ?? 0} 条（${Math.round((a.ms ?? 0) / 1000)}s）：${a.text ?? ""}`}
                    {a.type === "lurk" && `${a.reason ?? ""}：${a.preview ?? ""}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 日志尾巴 */}
        <div className="card">
          <h3>
            📜 日志尾巴 <small>qq-sidecar/state/sidecar.log</small>
          </h3>
          <pre style={{ maxHeight: 300, overflow: "auto", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", opacity: 0.85 }}>
            {(data?.logs ?? []).join("\n") || "（暂无日志）"}
          </pre>
        </div>
      </div>
    </div>
  );
}
