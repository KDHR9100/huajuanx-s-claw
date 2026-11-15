// 电脑状态页：钉在墙上的仪表卡（真数据，来自 /__rana/sys/status 中间件）。
// 页面挂载时才轮询（切页即卸载停止）；单项失败显示「……看不见了」不拖垮整页。
import { useCallback, useEffect, useRef, useState } from "react";

interface DiskRow {
  drive: string;
  label: string;
  sizeGB: number;
  freeGB: number;
}
interface SysInfo {
  disks: DiskRow[];
  cpu: number | null;
  memTotalGB: number;
  memFreeGB: number;
  uptimeHours: number;
}
interface GpuInfo {
  name: string;
  memTotalMB: number;
  memUsedMB: number;
  tempC: number;
  utilPct: number;
  procs?: Array<{ pid: number; name: string; memMB: number | null }> | null;
}
interface PowerInfo {
  plans: Array<{ guid: string; name: string }>;
  activeGuid: string;
}
interface VirtInfo {
  hypervisorPresent: boolean;
  vbsStatus: number;
  hvciRunning: boolean;
}
interface ServiceRow {
  name: string;
  port: number;
  listening: boolean;
  pid: number;
  proc: string | null;
  uptimeSec: number | null;
}
interface NetInfo {
  speed?: { downKBs: number; upKBs: number } | null;
  probes?: Array<{ label: string; ok: boolean; ms: number }>;
}
interface PatrolInfo {
  updatedAt: number;
  checks?: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  anomalies?: Array<{ id: string; label: string; detail: string }>;
  sendError?: string;
}
/** 契约守卫灯（server/lib/guard-light.ts 输出）：跨进程文件契约读侧违规台账 */
interface GuardViolation {
  contract: string;
  at: string;
  problem: string;
}
interface GuardLightInfo {
  lamp: "green" | "red";
  violations: GuardViolation[];
  total: number;
}
/** 会话健康哨兵（server/lib/session-health.ts 输出）：各 agent 库 session_windows 窗口健康。
 *  口径：每 session_key 取最新窗口判定——最新窗口 failed=真坏死（sick）；
 *  被新窗口顶掉的老 failed=伤疤（healedFailed），不算病。 */
interface ShSickRow {
  sessionKey: string;
  name?: string | null;
  lastFailedAt: number | null;
}
interface ShAgentRow {
  id: string;
  name: string;
  total: number;
  sick: number;
  healedFailed?: number;
  sickRows?: ShSickRow[];
  lastFailedAt: number | null;
  lastFailedKey: string | null;
  lastFailedName?: string | null;
  unknown?: boolean;
}
interface SessionHealthInfo {
  lamp: "green" | "red" | "gray";
  agents: ShAgentRow[];
  checkedAt: number;
}
interface StatusPayload {
  platform?: "win32" | "linux";
  sys?: SysInfo;
  gpu?: GpuInfo | null;
  power?: PowerInfo | null;
  virt?: VirtInfo | null;
  services?: ServiceRow[];
  net?: NetInfo | null;
  patrol?: PatrolInfo | null;
  contractGuards?: GuardLightInfo | null;
  sessionHealth?: SessionHealthInfo | null;
}

/** 家里探针上报（/__rana/sys/home；report 结构与 status 的 Windows 部分同构） */
interface HomePayload {
  receivedAt: number;
  report?: { sys?: SysInfo; gpu?: GpuInfo | null; power?: PowerInfo | null };
}

const POLL_MS = 5000;

/** 进程/服务的已运行时长：人话格式 */
function fmtUptime(sec: number | null | undefined): string {
  if (typeof sec !== "number" || sec < 0) return "";
  if (sec < 60) return `${Math.round(sec)} 秒`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时`;
  return `${Math.floor(sec / 86400)} 天 ${Math.round((sec % 86400) / 3600)} 小时`;
}

/** KB/s → 人话速率 */
function fmtRate(kbs: number): string {
  if (kbs >= 1024) return `${(kbs / 1024).toFixed(1)} MB/s`;
  return `${Math.round(kbs)} KB/s`;
}

/** 违规时间一行显示：MM-DD HH:MM（跨天的违规也要看得到日期；烂时间戳原样兜底） */
function fmtGuardAt(iso: string): string {
  const t = new Date(iso);
  if (!iso || Number.isNaN(t.getTime())) return iso || "时间未知";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** 会话 failed 时间一行显示：epoch ms → MM-DD HH:MM（烂时间戳兜底「时间未知」） */
function fmtSessionTs(ts: number | null | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "时间未知";
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return "时间未知";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** session_key 缩略：去掉 agent:<id>: 前缀（agent:main:cron:x → cron:x），一行放得下 */
function shortSessionKey(key: string | null | undefined): string {
  if (!key) return "未知窗口";
  return key.replace(/^agent:[^:]+:/, "");
}

function DiskBar({ disk }: { disk: DiskRow }) {
  const used = disk.sizeGB - disk.freeGB;
  const pct = disk.sizeGB > 0 ? Math.min(100, (used / disk.sizeGB) * 100) : 0;
  const cls = pct >= 90 ? " full" : pct >= 75 ? " warn" : "";
  return (
    <div className="disk-row">
      <div className="d-head">
        <b>
          {disk.drive}: {disk.label || "本地磁盘"}
        </b>
        <span>
          剩 {disk.freeGB} / {disk.sizeGB} GB
        </span>
      </div>
      <div className="bar">
        <i className={cls} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** 🏠 家里电脑卡（仅云端 Linux 部署显示）：读探针最后上报，数据可能滞后 */
function HomeCard() {
  const [home, setHome] = useState<HomePayload | null | undefined>(undefined); // undefined=加载中, null=从没上报过
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch("/__rana/sys/home");
        const j = (await r.json()) as HomePayload | null;
        if (!stop) setHome(j ?? null);
      } catch {
        if (!stop) setHome(null);
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 30000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, []);
  if (home === undefined) return <p className="pending-text">……看看家里。</p>;
  if (!home) {
    return (
      <>
        <div className="svc-row">
          <span className="svc-dot" />
          <span className="svc-name">探针没上报过</span>
        </div>
        <div className="plan-hint">家里的电脑没跑探针（tools/home-probe.ps1，手动跑），或云端还没配 HOME_REPORT_TOKEN。</div>
      </>
    );
  }
  const ageMin = Math.max(0, Math.round((Date.now() - home.receivedAt) / 60000));
  const online = ageMin < 3;
  const s = home.report?.sys;
  const g = home.report?.gpu;
  const p = home.report?.power;
  const memUsed = s ? s.memTotalGB - s.memFreeGB : 0;
  const activePlan = p?.plans.find((x) => x.guid === p.activeGuid)?.name;
  return (
    <>
      <div className="svc-row" title={`最后上报 ${new Date(home.receivedAt).toLocaleString()}`}>
        <span className={`svc-dot${online ? " ok" : ""}`} />
        <span className="svc-name">{online ? "家里电脑在线" : "家里电脑离线"}</span>
        <span className="svc-meta">{online ? "探针在跑" : `${ageMin} 分钟没上报了`}</span>
      </div>
      {s && (
        <>
          <div className="kv">
            <span className="k">CPU / 内存</span>
            <span className="v">
              {s.cpu !== null ? `${s.cpu}%` : "—"} · {memUsed.toFixed(1)} / {s.memTotalGB.toFixed(0)} GB
            </span>
          </div>
          <div className="kv">
            <span className="k">开机时长</span>
            <span className="v">
              {s.uptimeHours >= 24 ? `${Math.floor(s.uptimeHours / 24)} 天 ${Math.round(s.uptimeHours % 24)} 小时` : `${s.uptimeHours.toFixed(1)} 小时`}
            </span>
          </div>
        </>
      )}
      {g && (
        <div className="kv">
          <span className="k">🎮 {g.name}</span>
          <span className="v">
            {(g.memUsedMB / 1024).toFixed(1)} / {(g.memTotalMB / 1024).toFixed(0)} GB · {g.tempC}°C
          </span>
        </div>
      )}
      {activePlan && (
        <div className="kv">
          <span className="k">电源计划</span>
          <span className="v">{activePlan}</span>
        </div>
      )}
      <div className="plan-hint">手动工具不上报历史，数据只是最后一眼（{new Date(home.receivedAt).toLocaleTimeString()}）。</div>
    </>
  );
}

export default function SysPage() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(""); // 正在切换的 guid
  const [switchErr, setSwitchErr] = useState("");
  const [virtSwitching, setVirtSwitching] = useState(""); // 正在切换的虚拟化模式
  const [virtMsg, setVirtMsg] = useState("");
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async (fresh = false) => {
    try {
      const r = await fetch(`/__rana/sys/status${fresh ? "?fresh=1" : ""}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as StatusPayload);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    timerRef.current = window.setInterval(() => void load(), POLL_MS);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [load]);

  const switchPower = async (guid: string) => {
    if (switching) return;
    setSwitching(guid);
    setSwitchErr("");
    try {
      const r = await fetch("/__rana/sys/power", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guid }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      // 乐观更新：立即高亮新计划（后台 load() 稍后带完整新状态覆盖）
      setData((d) => (d?.power ? { ...d, power: { ...d.power, activeGuid: guid } } : d));
      await load();
    } catch (e) {
      setSwitchErr((e as Error).message);
    } finally {
      setSwitching("");
    }
  };

  const switchVirt = async (mode: "off" | "auto") => {
    if (virtSwitching) return;
    const warn =
      mode === "off"
        ? "关闭虚拟化后 WSL 将无法使用（重启电脑后生效）。确定切换到游戏模式吗？"
        : "开启虚拟化后部分游戏反作弊可能报错（重启电脑后生效）。确定切换到 WSL 模式吗？";
    if (!window.confirm(warn)) return;
    setVirtSwitching(mode);
    setVirtMsg("");
    try {
      const r = await fetch("/__rana/sys/virt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const j = (await r.json()) as { ok?: boolean; cancelled?: boolean; error?: string };
      if (j.cancelled) {
        setVirtMsg("你在 UAC 弹窗点了取消，没有执行。");
      } else if (!r.ok || !j.ok) {
        throw new Error(j.error ?? `HTTP ${r.status}`);
      } else {
        setVirtMsg("命令已执行完毕。重启电脑后生效，重启前状态显示不变。");
        setTimeout(() => void load(), 4000);
      }
    } catch (e) {
      setVirtMsg(`切换失败：${(e as Error).message}`);
    } finally {
      setVirtSwitching("");
    }
  };

  const sys = data?.sys;
  const gpu = data?.gpu;
  const power = data?.power;
  const services = data?.services ?? null;
  const net = data?.net ?? null;
  const patrol = data?.patrol ?? null;
  const guards = data?.contractGuards ?? null;
  const sh = data?.sessionHealth ?? null;
  const patrolAgeMin = patrol ? Math.max(1, Math.round((Date.now() - patrol.updatedAt) / 60000)) : 0;
  const memUsed = sys ? sys.memTotalGB - sys.memFreeGB : 0;
  const memPct = sys && sys.memTotalGB > 0 ? (memUsed / sys.memTotalGB) * 100 : 0;
  const uptimeText = sys
    ? sys.uptimeHours >= 24
      ? `${Math.floor(sys.uptimeHours / 24)} 天 ${Math.round(sys.uptimeHours % 24)} 小时`
      : `${sys.uptimeHours.toFixed(1)} 小时`
    : "—";
  const virt = data?.virt ?? null;
  const virtActive = Boolean(virt?.hypervisorPresent);
  // 云端 Linux 部署：状态页=服务器自己 + 🏠家里(探针)；家里的 Windows：现状全套
  const isLinux = data?.platform === "linux";

  return (
    <div className="wallboard">
      <div className="board-inner">
        <div className="page-intro">
          <h2>Rana 的状态</h2>
          <p>
            {isLinux ? "☁ 云服务器的样子，她帮你看着。" : "家里的样子，她帮你看着。"}
            {error && <span className="sys-err">（{error}）</span>}
          </p>
        </div>
        <div className="sys-grid">
          {/* 云端：家里电脑（探针上报，只读）；家里：虚拟化模式切换卡 */}
          {isLinux ? (
            <div className="card">
              <h3>
                <span className="ic">🏠</span>家里电脑 <small>手动探针 · 数据可能滞后</small>
              </h3>
              <HomeCard />
            </div>
          ) : (
          <div className="card">
            <h3>
              <span className="ic">🖥️</span>虚拟化模式 <small>重启后生效</small>
            </h3>
            {virt ? (
              <>
                <div className="virt-now">
                  当前：{virtActive ? "🐧 WSL 模式（虚拟化运行中）" : "🎮 游戏模式（虚拟化已关闭）"}
                  {virt.hvciRunning ? " · HVCI 开" : ""}
                </div>
                <div className="plans">
                  <button
                    className={`plan${virtActive ? "" : " on"}`}
                    disabled={virtSwitching !== "" || !virtActive}
                    title={virtActive ? "切到游戏模式（关闭虚拟化）" : "已是游戏模式"}
                    onClick={() => void switchVirt("off")}
                  >
                    {virtSwitching === "off" ? "…" : "🎮 游戏模式（关）"}
                  </button>
                  <button
                    className={`plan${virtActive ? " on" : ""}`}
                    disabled={virtSwitching !== "" || virtActive}
                    title={virtActive ? "已是 WSL 模式" : "切到 WSL 模式（开启虚拟化）"}
                    onClick={() => void switchVirt("auto")}
                  >
                    {virtSwitching === "auto" ? "…" : "🐧 WSL 模式（开）"}
                  </button>
                </div>
                {virtSwitching && <div className="plan-hint">屏幕上会弹 UAC 提权窗口，请点「是」……</div>}
                {virtMsg && <div className="plan-hint">{virtMsg}</div>}
              </>
            ) : (
              <p className="pending-text">……看不见了。</p>
            )}
          </div>
          )}

          {/* 电源计划：可点切换（仅家里 Windows） */}
          {!isLinux && (
          <div className="card">
            <h3>
              <span className="ic">⚡</span>电源计划 <small>powercfg</small>
            </h3>
            {power ? (
              <>
                <div className="plans">
                  {power.plans.map((p) => (
                    <button
                      key={p.guid}
                      className={`plan${p.guid === power.activeGuid ? " on" : ""}`}
                      disabled={switching !== ""}
                      onClick={() => void switchPower(p.guid)}
                    >
                      {switching === p.guid ? "…" : p.name}
                    </button>
                  ))}
                </div>
                {switchErr && <div className="plan-hint sys-err">……切不动：{switchErr}</div>}
              </>
            ) : (
              <p className="pending-text">……看不见了。</p>
            )}
          </div>
          )}

          {/* 硬盘 */}
          <div className="card">
            <h3>
              <span className="ic">💾</span>硬盘 <small>{sys?.disks.length ?? 0} 个盘</small>
            </h3>
            {sys ? sys.disks.map((d) => <DiskBar key={d.drive} disk={d} />) : <p className="pending-text">……看不见了。</p>}
          </div>

          {/* 显卡（仅家里 Windows；云服务器无独显） */}
          {!isLinux && (
          <div className="card">
            <h3>
              <span className="ic">🎮</span>显卡 <small>{gpu?.name ?? "nvidia-smi"}</small>
            </h3>
            {gpu ? (
              <>
                <div className="gauge-row">
                  <span>显存</span>
                  <b>
                    {(gpu.memUsedMB / 1024).toFixed(1)}
                    <small className="unit"> / {(gpu.memTotalMB / 1024).toFixed(0)} GB</small>
                  </b>
                </div>
                <div className="bar">
                  <i
                    className={gpu.memUsedMB / gpu.memTotalMB > 0.85 ? " warn" : ""}
                    style={{ width: `${(gpu.memUsedMB / gpu.memTotalMB) * 100}%` }}
                  />
                </div>
                <div style={{ height: 8 }} />
                <div className="kv">
                  <span className="k">利用率 / 温度</span>
                  <span className="v">
                    {gpu.utilPct}% · {gpu.tempC}°C
                  </span>
                </div>
                <div style={{ height: 6 }} />
                {gpu.procs && gpu.procs.length > 0 ? (
                  gpu.procs.slice(0, 5).map((p) => (
                    <div className="kv" key={`${p.pid}-${p.name}`}>
                      <span className="k" title={`PID ${p.pid}`}>
                        📦 {p.name}
                      </span>
                      <span className="v">{p.memMB !== null ? `${(p.memMB / 1024).toFixed(1)} GB` : "—"}</span>
                    </div>
                  ))
                ) : (
                  <div className="kv">
                    <span className="k">占显存进程</span>
                    <span className="v">没有</span>
                  </div>
                )}
              </>
            ) : (
              <p className="pending-text">……看不见了。</p>
            )}
          </div>
          )}

          {/* CPU / 内存 */}
          <div className="card">
            <h3>
              <span className="ic">🧠</span>CPU / 内存
            </h3>
            {sys ? (
              <>
                <div className="gauge-row">
                  <span>CPU</span>
                  <b>{sys.cpu !== null ? `${sys.cpu}%` : "—"}</b>
                </div>
                <div className="bar">
                  <i style={{ width: `${sys.cpu ?? 0}%` }} />
                </div>
                <div style={{ height: 8 }} />
                <div className="gauge-row">
                  <span>内存</span>
                  <b>
                    {memUsed.toFixed(1)}
                    <small className="unit"> / {sys.memTotalGB.toFixed(0)} GB</small>
                  </b>
                </div>
                <div className="bar">
                  <i className={memPct > 85 ? " warn" : ""} style={{ width: `${memPct}%` }} />
                </div>
                <div style={{ height: 8 }} />
                <div className="kv">
                  <span className="k">开机时长</span>
                  <span className="v">{uptimeText}</span>
                </div>
              </>
            ) : (
              <p className="pending-text">……看不见了。</p>
            )}
          </div>

          {/* 契约守卫灯：跨进程文件契约读侧台账（.health/contract-guards.json）——
              绿=零违规；红=有契约坏过数据（列表=最近 10 条）；灰=灯数据没拿到 */}
          <div className="card">
            <h3>
              <span className="ic">🛡</span>契约守卫 <small>边车写 → 前端读</small>
            </h3>
            {!guards ? (
              <div className="svc-row">
                <span className="guard-dot dim" />
                <span className="svc-name">守卫数据读不到</span>
                <span className="svc-meta">接口没回这盏灯</span>
              </div>
            ) : guards.lamp === "red" ? (
              <>
                <div className="svc-row">
                  <span className="guard-dot bad" />
                  <span className="svc-name">{guards.total} 次契约违规</span>
                  <span className="svc-meta">最近 {guards.violations.length} 条</span>
                </div>
                {guards.violations.map((v, i) => (
                  <div className="svc-row guard-viol" key={`${v.at}-${i}`}>
                    <span className="svc-name">{v.contract}</span>
                    <span className="svc-meta" title={v.problem}>
                      {fmtGuardAt(v.at)} · {v.problem || "字段异常"}
                    </span>
                  </div>
                ))}
              </>
            ) : (
              <div className="svc-row">
                <span className="guard-dot" />
                <span className="svc-name">全部契约健康</span>
                <span className="svc-meta">台账零违规</span>
              </div>
            )}
          </div>

          {/* 会话健康哨兵：只读直查各 agent 库 session_windows 表（不动库）——
              绿=全部会话健康；红=N 个窗口被盖 failed 章坏死（展开最近失败明细）；灰=库读不到 */}
          <div className="card">
            <h3>
              <span className="ic">🩺</span>会话健康哨兵 <small>直读 agent 库 · 只读不动库</small>
            </h3>
            {!sh ? (
              <div className="svc-row">
                <span className="guard-dot dim" />
                <span className="svc-name">哨兵数据读不到</span>
                <span className="svc-meta">接口没回这盏灯</span>
              </div>
            ) : (
              <>
                  <div className="sh-head">
                  <span className={`sh-lamp ${sh.lamp}`} />
                  <div className="sh-verdict">
                    <b>
                      {sh.lamp === "red"
                        ? `${sh.agents.reduce((n, a) => n + (a.unknown ? 0 : a.sick), 0)} 个会话窗口坏死`
                        : sh.lamp === "green"
                          ? "全部会话健康"
                          : "agent 库读不到"}
                    </b>
                    <span>
                      {sh.lamp === "red"
                        ? "会话的最新窗口被盖 failed 章后每条消息都会 draining 超时——和前几次发病一个症状"
                        : sh.lamp === "green"
                          ? "所有 agent 的会话窗口零坏死"
                          : "agent 库没读出来（网关没启动或路径不对），先降级观察"}
                    </span>
                  </div>
                </div>
                {sh.agents.map((a) => (
                  <div className="svc-row" key={a.id}>
                    <span className={`guard-dot${a.unknown ? " dim" : a.sick > 0 ? " bad" : ""}`} />
                    <span className="svc-name">{a.name}</span>
                    <span
                      className="svc-meta"
                      title={a.healedFailed ? `另有 ${a.healedFailed} 个历史 failed 已被新窗口顶掉` : undefined}
                    >
                      {a.unknown
                        ? "库读不到 · 降级观察"
                        : `${a.total} 个会话窗口 · ${a.sick > 0 ? `${a.sick} 个坏死` : "全部正常"}${
                            a.healedFailed ? ` · 另有 ${a.healedFailed} 个历史 failed 已被新窗口顶掉` : ""
                          }`}
                    </span>
                  </div>
                ))}
                {sh.lamp === "red" &&
                  sh.agents
                    .filter((a) => !a.unknown && a.sick > 0 && a.sickRows?.length)
                    .map((a) => (
                      <div className="sh-detail" key={`shf-${a.id}`}>
                        {a.sickRows!.map((s) => (
                          <div className="svc-row" key={s.sessionKey}>
                            <span className="svc-name" title={s.sessionKey}>
                              {a.name} / {s.name || shortSessionKey(s.sessionKey)}
                            </span>
                            <span className="svc-meta">最近 failed {fmtSessionTs(s.lastFailedAt)}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                <div className="plan-hint">
                  建议：先重启网关，再不好按台账 draining 条目手术 · 数据源 session_windows 表 status 字段 · 只读连接，不动库
                </div>
              </>
            )}
          </div>

          {/* 服务端口：谁在监听谁没开；⟳ 立即重测（绕过缓存，外网连通也重探） */}
          <div className="card">
            <h3>
              <span className="ic">🔌</span>服务端口 <small>红 = 没在监听</small>
              <button className="nav-btn svc-refresh" title="立即刷新（绕过缓存重测，外网连通性也会重探）" onClick={() => void load(true)}>
                ⟳
              </button>
            </h3>
            {services ? (
              <>
                {services.map((s) => (
                  <div className="svc-row" key={s.port}>
                    <span className={`svc-dot${s.listening ? " ok" : ""}`} />
                    <span className="svc-name">{s.name}</span>
                    <span className="svc-port">:{s.port}</span>
                    <span className="svc-meta" title={s.pid ? `PID ${s.pid}` : undefined}>
                      {s.listening ? [s.proc, fmtUptime(s.uptimeSec)].filter(Boolean).join(" · ") : "没在跑"}
                    </span>
                  </div>
                ))}
                <div className="plan-hint">想多盯一个端口：在 rana-web/services.json 里加一行 {"{"} name, port {"}"}</div>
              </>
            ) : (
              <p className="pending-text">……看不见了。</p>
            )}
          </div>

          {/* 巡检：零成本脚本 health-patrol 每 30 分钟一趟，异常会主动 QQ 私聊 */}
          {patrol && (
            <div className="card">
              <h3>
                <span className="ic">🩺</span>巡检
                <small>
                  {patrolAgeMin <= 90 ? `${patrolAgeMin} 分钟前` : `⚠ ${patrolAgeMin} 分钟没更新了`}
                </small>
              </h3>
              {(patrol.checks ?? []).map((c) => (
                <div className="svc-row" key={c.id} title={c.detail}>
                  <span className={`svc-dot${c.ok ? " ok" : ""}`} />
                  <span className="svc-name">{c.label}</span>
                  <span className="svc-meta">{c.detail}</span>
                </div>
              ))}
              {(patrol.anomalies ?? []).map((a) => (
                <div className="net-line" key={a.id}>
                  <span className="k">⚠ {a.label}</span>
                  <span className="v">{a.detail}</span>
                </div>
              ))}
              {patrol.sendError && <div className="plan-hint">上次 QQ 报警没发出去：{patrol.sendError}</div>}
            </div>
          )}

          {/* 网络：实时网速 + 外网连通性 */}
          <div className="card">
            <h3>
              <span className="ic">🌐</span>网络 <small>连通性 1 分钟一测</small>
              <button className="nav-btn svc-refresh" title="立即刷新（绕过缓存重测，外网连通性也会重探）" onClick={() => void load(true)}>
                ⟳
              </button>
            </h3>
            {net ? (
              <>
                <div className="net-line">
                  <span className="k">网速（物理网卡）</span>
                  <span className="v">
                    {net.speed ? `↓ ${fmtRate(net.speed.downKBs)} · ↑ ${fmtRate(net.speed.upKBs)}` : "测量中…"}
                  </span>
                </div>
                {(net.probes ?? []).map((p) => (
                  <div className="net-line" key={p.label}>
                    <span className="k">{p.label}</span>
                    <span className={p.ok ? "ok" : "bad"}>{p.ok ? `通 · ${p.ms >= 1000 ? (p.ms / 1000).toFixed(1) + " s" : p.ms + " ms"}` : "不通"}</span>
                  </div>
                ))}
              </>
            ) : (
              <p className="pending-text">……看不见了。</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
