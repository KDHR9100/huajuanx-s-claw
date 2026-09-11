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
}
interface PowerInfo {
  plans: Array<{ guid: string; name: string }>;
  activeGuid: string;
}
interface StatusPayload {
  sys?: SysInfo;
  gpu?: GpuInfo | null;
  power?: PowerInfo | null;
}

const POLL_MS = 5000;

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

  const sys = data?.sys;
  const gpu = data?.gpu;
  const power = data?.power;
  const memUsed = sys ? sys.memTotalGB - sys.memFreeGB : 0;
  const memPct = sys && sys.memTotalGB > 0 ? (memUsed / sys.memTotalGB) * 100 : 0;
  const uptimeText = sys
    ? sys.uptimeHours >= 24
      ? `${Math.floor(sys.uptimeHours / 24)} 天 ${Math.round(sys.uptimeHours % 24)} 小时`
      : `${sys.uptimeHours.toFixed(1)} 小时`
    : "—";

  return (
    <div className="wallboard">
      <div className="board-inner">
        <div className="page-intro">
          <h2>电脑状态</h2>
          <p>家里的样子，她帮你看着。{error && <span className="sys-err">（{error}）</span>}</p>
        </div>
        <div className="sys-grid">
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
        </div>
      </div>
    </div>
  );
}
