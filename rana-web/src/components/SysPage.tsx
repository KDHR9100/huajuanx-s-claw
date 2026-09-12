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
interface StatusPayload {
  sys?: SysInfo;
  gpu?: GpuInfo | null;
  power?: PowerInfo | null;
  virt?: VirtInfo | null;
  services?: ServiceRow[];
  net?: NetInfo | null;
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

export default function SysPage() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(""); // 正在切换的 guid
  const [switchErr, setSwitchErr] = useState("");
  const [virtSwitching, setVirtSwitching] = useState(""); // 正在切换的虚拟化模式
  const [virtMsg, setVirtMsg] = useState("");
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/__rana/sys/status");
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
  const memUsed = sys ? sys.memTotalGB - sys.memFreeGB : 0;
  const memPct = sys && sys.memTotalGB > 0 ? (memUsed / sys.memTotalGB) * 100 : 0;
  const uptimeText = sys
    ? sys.uptimeHours >= 24
      ? `${Math.floor(sys.uptimeHours / 24)} 天 ${Math.round(sys.uptimeHours % 24)} 小时`
      : `${sys.uptimeHours.toFixed(1)} 小时`
    : "—";
  const virt = data?.virt ?? null;
  const virtActive = Boolean(virt?.hypervisorPresent);

  return (
    <div className="wallboard">
      <div className="board-inner">
        <div className="page-intro">
          <h2>Rana 的状态</h2>
          <p>家里的样子，她帮你看着。{error && <span className="sys-err">（{error}）</span>}</p>
        </div>
        <div className="sys-grid">
          {/* 虚拟化模式：游戏 / WSL 切换（弹 UAC 提权，重启生效） */}
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

          {/* 电源计划：可点切换 */}
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

          {/* 硬盘 */}
          <div className="card">
            <h3>
              <span className="ic">💾</span>硬盘 <small>{sys?.disks.length ?? 0} 个盘</small>
            </h3>
            {sys ? sys.disks.map((d) => <DiskBar key={d.drive} disk={d} />) : <p className="pending-text">……看不见了。</p>}
          </div>

          {/* 显卡 */}
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

          {/* 服务端口：谁在监听谁没开 */}
          <div className="card">
            <h3>
              <span className="ic">🔌</span>服务端口 <small>红 = 没在监听</small>
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

          {/* 网络：实时网速 + 外网连通性 */}
          <div className="card">
            <h3>
              <span className="ic">🌐</span>网络 <small>连通性 1 分钟一测</small>
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
