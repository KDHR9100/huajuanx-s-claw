import fs from "node:fs";
import path from "node:path";
import { execFileP } from "../lib/exec";
import { RANA_WEB } from "../lib/paths";
import { readFullConfig, isLocalProvider } from "../lib/config";
import { json, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 电脑状态端点（本机只读监控 + 电源计划切换）：
 * - GET /__rana/sys/status  聚合系统数据，8 秒缓存；按运行平台分派——
 *   · win32（家里的电脑）：硬盘/CPU/内存/开机时长/显卡+显存进程/电源计划/虚拟化/服务端口/网速/外网连通（PowerShell 套件）
 *   · linux（云服务器）：/proc + df + ss 同构数据（无电源/虚拟化/GPU 卡）
 * - POST /__rana/sys/power {guid}  切换电源计划（仅接受 GUID 格式参数、仅本机回环来源；仅 win32）
 * - POST /__rana/sys/virt {mode}   虚拟化模式切换（仅 win32）
 * - POST /__rana/sys/home-report   家里探针上报（X-Home-Token 独立小 token 校验，无 token 配置则拒绝——fail-closed）
 * - GET  /__rana/sys/home          读探针最后上报（给云端页面「🏠 家里」卡）
 * 服务端口清单 = 平台默认项 + rana-web/services.json 用户自加项（{name,port}）。
 * 所有子进程调用均用 execFile 数组参数（不经 shell、无字符串拼接）。
 */
export function ranaSysStatusMiddleware(): Plugin {
  const here = RANA_WEB;
  const IS_WIN = process.platform === "win32";
  const PLATFORM = IS_WIN ? "win32" : "linux";
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CACHE_MS = 8000;
  interface DiskRow { drive: string; label: string; sizeGB: number; freeGB: number }
  let cache: { at: number; data: unknown } | null = null;

  /** Windows 系统数据：一次 PowerShell 调用拿硬盘/CPU/内存/开机时长 */
  const querySystem = async () => {
    // eslint-disable-next-line no-useless-escape -- PS 里 @() 强制数组
    const ps = [
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
      "$os = Get-CimInstance Win32_OperatingSystem",
      "$cpu = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average",
      "$disks = @(Get-Volume | Where-Object DriveLetter | ForEach-Object { [pscustomobject]@{ drive = [string]$_.DriveLetter; label = [string]$_.FileSystemLabel; sizeGB = [math]::Round($_.Size/1GB); freeGB = [math]::Round($_.SizeRemaining/1GB) } })",
      "[pscustomobject]@{ disks = $disks; cpu = $cpu; memTotalGB = [math]::Round($os.TotalVisibleMemorySize/1MB,1); memFreeGB = [math]::Round($os.FreePhysicalMemory/1MB,1); uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours,1) } | ConvertTo-Json -Compress -Depth 3",
    ].join("; ");
    const { stdout } = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  };

  /** 显卡：nvidia-smi CSV（无显卡/超时返回 null，前端单独降级）；附带占显存的进程明细 */
  const queryGpu = async () => {
    try {
      const { stdout } = await execFileP(
        "nvidia-smi",
        ["--query-gpu=name,memory.total,memory.used,temperature.gpu,utilization.gpu", "--format=csv,noheader,nounits"],
        { encoding: "utf8", timeout: 8000, windowsHide: true },
      );
      const parts = stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
      if (parts.length < 5) return null;
      const procs: Array<{ pid: number; name: string; memMB: number | null }> = [];
      try {
        // nvidia-smi 在 Windows WDDM 模式下查不到每进程显存（全是 [N/A]），
        // 改用系统 GPU 性能计数器「GPU Process Memory(*)\Local Usage」按 pid 汇总
        const psProcs = [
          "$m = @{}",
          "Get-Counter '\\GPU Process Memory(*)\\Local Usage' -ErrorAction SilentlyContinue | ForEach-Object { $_.CounterSamples } | ForEach-Object { if ($_.InstanceName -match 'pid_(\\d+)') { $k = [int]$Matches[1]; $m[$k] = [double]$m[$k] + $_.CookedValue } }",
          "$top = $m.GetEnumerator() | Sort-Object Value -Descending | Where-Object { $_.Value -gt 50MB } | Select-Object -First 8",
          "$out = foreach ($e in $top) { $p = Get-Process -Id $e.Key -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ pid = $e.Key; name = $p.ProcessName; memMB = [math]::Round($e.Value / 1MB) } } }",
          "@($out) | ConvertTo-Json -Compress",
        ].join("; ");
        const procsRes = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", psProcs], {
          encoding: "utf8", timeout: 15000, windowsHide: true,
        });
        let rows = JSON.parse(procsRes.stdout) as Array<{ pid?: number; name?: string; memMB?: number }>;
        if (!Array.isArray(rows)) rows = [rows];
        for (const r of rows) {
          if (r?.name) procs.push({ pid: Number(r.pid ?? 0), name: String(r.name), memMB: Number(r.memMB ?? 0) });
        }
      } catch {
        // 明细失败不影响主数据
      }
      return {
        name: parts[0],
        memTotalMB: Number(parts[1]),
        memUsedMB: Number(parts[2]),
        tempC: Number(parts[3]),
        utilPct: Number(parts[4]),
        procs,
      };
    } catch {
      return null;
    }
  };

  /** 电源计划列表 + 当前激活（powercfg 输出为 GBK 编码，需按 GBK 解码；GUID 行末带名称） */
  const queryPower = async () => {
    const dec = new TextDecoder("gbk");
    const parse = (s: string) =>
      Array.from(s.matchAll(/([0-9a-f-]{36})\s*\*?\s*\(([^)]+)\)/gi)).map((m) => ({ guid: m[1], name: m[2].trim() }));
    const [list, active] = await Promise.all([
      execFileP("powercfg", ["/list"], { encoding: "buffer", timeout: 8000, windowsHide: true }),
      execFileP("powercfg", ["/getactivescheme"], { encoding: "buffer", timeout: 8000, windowsHide: true }),
    ]);
    const plans = parse(dec.decode(Buffer.from(list.stdout)));
    const activeGuid = parse(dec.decode(Buffer.from(active.stdout)))[0]?.guid ?? "";
    return { plans, activeGuid };
  };

  /** 虚拟化状态检测（免管理员）：hypervisor 是否在跑 + VBS/HVCI 状态 */
  const queryVirt = async () => {
    const ps = [
      "$cs = Get-CimInstance Win32_ComputerSystem",
      "$dg = $null",
      "try { $dg = Get-CimInstance -Namespace root\\Microsoft\\Windows\\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction Stop } catch {}",
      "[pscustomobject]@{ hypervisorPresent = [bool]$cs.HypervisorPresent; vbsStatus = if ($dg) { [int]$dg.VirtualizationBasedSecurityStatus } else { -1 }; hvciRunning = if ($dg) { [bool]($dg.SecurityServicesRunning -contains 2) } else { $false } } | ConvertTo-Json -Compress",
    ].join("; ");
    const { stdout } = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    return JSON.parse(stdout) as { hypervisorPresent: boolean; vbsStatus: number; hvciRunning: boolean };
  };

  /** Linux（云服务器）系统数据：df + /proc 三件套；CPU 为两次采样差分（首拍为 null） */
  let lastCpuSample: { busy: number; total: number } | null = null;
  const readCpuTimes = () => {
    const parts = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    return { busy: total - idle, total };
  };
  const querySystemLinux = async () => {
    const { stdout } = await execFileP("df", ["-B1G", "--output=source,target,size,avail", "-x", "tmpfs", "-x", "devtmpfs"], {
      encoding: "utf8", timeout: 10000,
    });
    const disks: DiskRow[] = [];
    for (const line of stdout.trim().split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      disks.push({ drive: cols[1], label: cols[0], sizeGB: Number(cols[2]), freeGB: Number(cols[3]) });
    }
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const memTotalKB = Number(meminfo.match(/^MemTotal:\s+(\d+) kB$/m)?.[1] ?? 0);
    const memAvailKB = Number(meminfo.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1] ?? 0);
    const uptimeSec = Number(fs.readFileSync("/proc/uptime", "utf8").trim().split(" ")[0]);
    const cpuTimes = readCpuTimes();
    let cpu: number | null = null;
    if (lastCpuSample && cpuTimes.total > lastCpuSample.total) {
      cpu = Math.round(((cpuTimes.busy - lastCpuSample.busy) / (cpuTimes.total - lastCpuSample.total)) * 100);
    }
    lastCpuSample = cpuTimes;
    return {
      disks,
      cpu,
      memTotalGB: Math.round((memTotalKB / 1024 / 1024) * 10) / 10,
      memFreeGB: Math.round((memAvailKB / 1024 / 1024) * 10) / 10,
      uptimeHours: Math.round((uptimeSec / 3600) * 10) / 10,
    };
  };

  /** Linux 服务端口：ss -tlnp + /proc/<pid>/stat 算进程已运行时长 */
  const linuxBootTime = () => Number(fs.readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1] ?? 0);
  const linuxProcUptimeSec = (pid: number): number | null => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startTimeJ = Number(after[19]); // after[0]=state(第3字段),第22字段=after[19]
      const bt = linuxBootTime();
      if (!startTimeJ || !bt) return null;
      return Math.max(0, Math.floor(Date.now() / 1000 - (bt + startTimeJ / 100)));
    } catch {
      return null;
    }
  };
  const queryServicesLinux = async () => {
    const wanted = readServiceList();
    const { stdout } = await execFileP("ss", ["-tlnp"], { encoding: "utf8", timeout: 10000 });
    const rows = stdout.trim().split("\n").slice(1);
    return wanted.map((s) => {
      const hit = rows.find((r) => {
        const cols = r.trim().split(/\s+/);
        const local = cols[3] ?? "";
        return local.endsWith(`:${s.port}`) || local.endsWith(`]:${s.port}`);
      });
      const pid = Number(hit?.match(/pid=(\d+)/)?.[1] ?? 0);
      return {
        ...s,
        listening: Boolean(hit),
        pid,
        proc: pid ? (hit?.match(/users:\(\("([^"]+)"/)?.[1] ?? "listening") : hit ? "listening" : null,
        uptimeSec: pid ? linuxProcUptimeSec(pid) : null,
      };
    });
  };

  /** Linux 网速：/proc/net/dev 差分（排除 lo） */
  let lastNetSampleLinux: { recv: number; sent: number } | null = null;
  const queryNetSpeedLinux = () => {
    const recvTotal: number[] = [];
    const sentTotal: number[] = [];
    for (const line of fs.readFileSync("/proc/net/dev", "utf8").trim().split("\n").slice(2)) {
      const [iface, rest] = line.split(":");
      if (!iface?.trim() || iface.trim() === "lo") continue;
      const cols = rest?.trim().split(/\s+/).map(Number) ?? [];
      if (cols.length >= 9) {
        recvTotal.push(cols[0]);
        sentTotal.push(cols[8]);
      }
    }
    const recv = recvTotal.reduce((a, b) => a + b, 0);
    const sent = sentTotal.reduce((a, b) => a + b, 0);
    let speed: { downKBs: number; upKBs: number } | null = null;
    if (lastNetSampleLinux) {
      speed = {
        downKBs: Math.max(0, (recv - lastNetSampleLinux.recv) / 8000 / 1.024),
        upKBs: Math.max(0, (sent - lastNetSampleLinux.sent) / 8000 / 1.024),
      };
    }
    lastNetSampleLinux = { recv, sent };
    return speed;
  };

  /** 服务端口清单：平台默认项 + rana-web/services.json 自加项（{name,port}，端口非法/重名的忽略） */
  const DEFAULT_SERVICES: Array<{ name: string; port: number }> = IS_WIN
    ? [
        { name: "OpenClaw 网关", port: 18789 },
        { name: "rana-web 前端", port: 5173 },
        { name: "LM Studio", port: 1234 },
        { name: "Clash 代理", port: 7897 },
      ]
    : [
        { name: "OpenClaw 网关", port: 18789 },
        { name: "rana-web 前端", port: 5173 },
        { name: "SSE 修复代理", port: 18801 },
      ];
  const readServiceList = () => {
    const list = [...DEFAULT_SERVICES];
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(here, "services.json"), "utf8")) as Array<{ name?: unknown; port?: unknown }>;
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const port = Number(item?.port);
          const name = String(item?.name ?? "").trim().slice(0, 24);
          if (!Number.isInteger(port) || port < 1 || port > 65535 || !name) continue;
          if (list.some((s) => s.port === port)) continue;
          list.push({ name, port });
        }
      }
    } catch {
      // 没有配置文件或格式不对：只用默认清单
    }
    return list;
  };

  /** 服务端口监听状态：一次 PS 拿 监听行 + 进程名 + 进程已运行时长（网关跑多久就从这来） */
  const queryServices = async () => {
    const wanted = readServiceList();
    const ports = wanted.map((s) => s.port);
    const ps = [
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
      `$ports = @(${ports.join(",")})`,
      "$rows = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains [int]$_.LocalPort }",
      "$pids = @($rows | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique | Where-Object { $_ -gt 0 })",
      "$procs = @{}",
      "if ($pids.Count) { Get-Process -Id $pids -ErrorAction SilentlyContinue | ForEach-Object { $procs[[int]$_.Id] = $_ } }",
      "$out = foreach ($p in $ports) { $c = @($rows | Where-Object { [int]$_.LocalPort -eq $p })[0]; $ownerPid = 0; $pname = $null; $up = $null; if ($c) { $ownerPid = [int]$c.OwningProcess; if ($procs.ContainsKey($ownerPid)) { $pr = $procs[$ownerPid]; $pname = $pr.ProcessName; try { $up = [math]::Round(([datetime]::Now - $pr.StartTime).TotalSeconds) } catch {} } }; [pscustomobject]@{ port = $p; listening = [bool]$c; pid = $ownerPid; proc = $pname; uptimeSec = $up } }",
      "@($out) | ConvertTo-Json -Compress",
    ].join("; ");
    const { stdout } = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    let rows = JSON.parse(stdout) as Array<{ port?: number; listening?: boolean; pid?: number; proc?: string | null; uptimeSec?: number | null }>;
    if (!Array.isArray(rows)) rows = [rows];
    const byPort = new Map(rows.map((r) => [Number(r.port), r]));
    return wanted.map((s) => {
      const r = byPort.get(s.port);
      return {
        ...s,
        listening: Boolean(r?.listening),
        pid: Number(r?.pid ?? 0),
        proc: r?.proc ?? null,
        uptimeSec: typeof r?.uptimeSec === "number" ? r.uptimeSec : null,
      };
    });
  };

  /** 网速：读物理网卡累计字节数，与上次采样求差（跟着 8s 状态缓存走，第一次没有速率） */
  let lastNetSample: { at: number; recv: number; sent: number } | null = null;
  const queryNetSpeed = async () => {
    const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes) | ConvertTo-Json -Compress";
    const { stdout } = await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    let rows = JSON.parse(stdout) as Array<{ Name?: string; ReceivedBytes?: number; SentBytes?: number }>;
    if (!Array.isArray(rows)) rows = [rows];
    // 只算物理网卡：WSL/Hyper-V 的 vEthernet 会出现重复计数
    const physical = rows.filter((r) => r && typeof r.ReceivedBytes === "number" && !/^vEthernet/i.test(String(r.Name ?? "")));
    const recv = physical.reduce((a, r) => a + (r.ReceivedBytes ?? 0), 0);
    const sent = physical.reduce((a, r) => a + (r.SentBytes ?? 0), 0);
    let speed: { downKBs: number; upKBs: number } | null = null;
    if (lastNetSample) {
      const dt = (Date.now() - lastNetSample.at) / 1000;
      if (dt >= 1) {
        speed = {
          downKBs: Math.max(0, (recv - lastNetSample.recv) / dt / 1024),
          upKBs: Math.max(0, (sent - lastNetSample.sent) / dt / 1024),
        };
      }
    }
    lastNetSample = { at: Date.now(), recv, sent };
    return speed;
  };

  /** 外网连通性：curl 探 GitHub（走 Clash）+ 模型 API（直连）；60 秒缓存，别一直敲人家的门 */
  const NET_PROBE_MS = 60000;
  let netProbeCache: { at: number; data: { probes: Array<{ label: string; ok: boolean; ms: number }> } } | null = null;
  const probeUrl = async (label: string, url: string, proxy?: string) => {
    const args = ["-I", "-s", "-o", IS_WIN ? "NUL" : "/dev/null", "-w", "%{time_total}", "--connect-timeout", "3", "--max-time", "5"];
    if (proxy) args.push("-x", proxy);
    args.push(url);
    try {
      const { stdout } = await execFileP("curl", args, { encoding: "utf8", timeout: 9000, windowsHide: true });
      return { label, ok: true, ms: Math.round(parseFloat(stdout.trim()) * 1000) };
    } catch {
      return { label, ok: false, ms: 0 };
    }
  };
  const queryNetProbes = async () => {
    if (netProbeCache && Date.now() - netProbeCache.at < NET_PROBE_MS) return netProbeCache.data;
    // 模型 API 直连目标：取云端 provider 里第一个非本地的 baseUrl
    let apiOrigin = "";
    try {
      for (const p of Object.values(readFullConfig().models?.providers ?? {})) {
        if (p.baseUrl && !isLocalProvider(p)) {
          apiOrigin = new URL(p.baseUrl).origin;
          break;
        }
      }
    } catch {
      // 读不到配置就只探 GitHub
    }
    const jobs: Array<Promise<{ label: string; ok: boolean; ms: number }>> = [
      IS_WIN
        ? probeUrl("GitHub（走 Clash）", "https://github.com", "http://127.0.0.1:7897")
        : probeUrl("GitHub（直连）", "https://github.com"),
    ];
    if (apiOrigin) jobs.push(probeUrl("模型 API（直连）", apiOrigin));
    const probes = await Promise.all(jobs);
    const data = { probes };
    netProbeCache = { at: Date.now(), data };
    return data;
  };

  /** 巡检快照：health-patrol.mjs 每 30 分钟写的 .health/patrol.json（缺文件=巡检没跑过） */
  const readPatrol = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(here, ".health", "patrol.json"), "utf8")) as {
        updatedAt: number;
        checks?: Array<{ id: string; label: string; ok: boolean; detail: string }>;
        anomalies?: Array<{ id: string; label: string; detail: string }>;
        sendError?: string;
      };
    } catch {
      return null;
    }
  };

  const buildStatus = async () => {
    // Linux（云服务器）：无电源/虚拟化/GPU 卡，其余同构
    if (!IS_WIN) {
      const [sys, services, netSpeed, netProbes] = await Promise.all([
        querySystemLinux(),
        queryServicesLinux().catch(() => readServiceList().map((s) => ({ ...s, listening: false, pid: 0, proc: null, uptimeSec: null }))),
        Promise.resolve(queryNetSpeedLinux()).catch(() => null),
        queryNetProbes().catch(() => ({ probes: [] })),
      ]);
      return {
        platform: PLATFORM,
        sys,
        gpu: null as unknown,
        power: null as unknown,
        virt: null as unknown,
        services,
        net: { speed: netSpeed, probes: netProbes.probes },
        patrol: readPatrol(),
        ts: Date.now(),
      };
    }
    const [sys, gpu, power, virt, services, netSpeed, netProbes] = await Promise.all([
      querySystem(),
      queryGpu().catch(() => null),
      queryPower().catch(() => null),
      queryVirt().catch(() => null),
      queryServices().catch(() => readServiceList().map((s) => ({ ...s, listening: false, pid: 0, proc: null, uptimeSec: null }))),
      queryNetSpeed().catch(() => null),
      queryNetProbes().catch(() => ({ probes: [] })),
    ]);
    return { platform: PLATFORM, sys, gpu, power, virt, services, net: { speed: netSpeed, probes: netProbes.probes }, patrol: readPatrol(), ts: Date.now() };
  };





  const handler = (
    req: { method?: string; url?: string; socket?: { remoteAddress?: string }; headers?: Record<string, unknown>; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method === "GET") {
      // ?fresh=1：页面"立即刷新"——绕过 8 秒缓存，外网连通性也重测一遍
      if (new URL(req.url ?? "/", "http://x").searchParams.get("fresh") === "1") {
        cache = null;
        netProbeCache = null;
      }
      if (cache && Date.now() - cache.at < CACHE_MS) {
        json(res, 200, cache.data);
        return;
      }
      buildStatus()
        .then((data) => {
          cache = { at: Date.now(), data };
          json(res, 200, data);
        })
        .catch((e: Error) => json(res, 500, { error: e.message }));
      return;
    }
    if (req.method === "POST") {
      if (!IS_WIN) {
        json(res, 400, { error: "电源计划切换只在家里 Windows 上有" });
        return;
      }
      if (!isLoopback(req)) {
        json(res, 403, { error: "仅本机可操作" });
        return;
      }
      let body = "";
      req.on("data", (c?: string) => { body += c ?? ""; });
      req.on("end", () => {
        let guid = "";
        try {
          guid = String((JSON.parse(body) as { guid?: string }).guid ?? "");
        } catch { /* 空_body 等 */ }
        if (!GUID_RE.test(guid)) {
          json(res, 400, { error: "guid 格式不对" });
          return;
        }
        execFileP("powercfg", ["/setactive", guid], { encoding: "utf8", timeout: 8000, windowsHide: true })
          .then(() => {
            cache = null; // 立即失效，下次查询拿新状态
            json(res, 200, { ok: true, guid });
          })
          .catch((e: Error) => json(res, 500, { error: `切不动：${e.message}` }));
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  /** 虚拟化模式切换：弹 UAC 提权跑 bcdedit/reg 命令（等价于用户桌面那个 HTA）。off=游戏模式，auto=WSL 模式；重启后生效 */
  const switchVirt = async (mode: string) => {
    const inner =
      mode === "off"
        ? "bcdedit /set hypervisorlaunchtype off; " +
          "reg add 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard' /v EnableVirtualizationBasedSecurity /t REG_DWORD /d 0 /f; " +
          "reg add 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity' /v Enabled /t REG_DWORD /d 0 /f; " +
          "reg add 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa' /v LsaCfgFlags /t REG_DWORD /d 0 /f; " +
          "Write-Host '== 虚拟化已全部关闭，重启后进入游戏模式 =='"
        : "bcdedit /set hypervisorlaunchtype auto; " +
          "dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart; " +
          "dism /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart; " +
          "Write-Host '== 已切回 WSL 模式（上方 DISM 若报错请截图给 Rana），重启后生效 =='";
    // 内层命令走 -EncodedCommand（UTF-16LE base64），避免多层引号转义
    const b64 = Buffer.from(inner, "utf16le").toString("base64");
    // Start-Process -Verb RunAs 弹 UAC；-Wait 等执行完；用户点取消则外层 exit 1
    const outer =
      "try { Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-EncodedCommand','" +
      b64 +
      "' -ErrorAction Stop; exit 0 } catch { exit 1 }";
    await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", outer], {
      encoding: "utf8", timeout: 120000, windowsHide: true,
    });
  };

  const virtHandler = (
    req: { method?: string; socket?: { remoteAddress?: string }; headers?: Record<string, unknown>; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!IS_WIN) {
      json(res, 400, { error: "虚拟化切换只在家里 Windows 上有" });
      return;
    }
    const ra = req.socket?.remoteAddress ?? "";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra);
    const origin = String(req.headers?.origin ?? "");
    if (!loopback || (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin))) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }
    let body = "";
    req.on("data", (c?: string) => { body += c ?? ""; });
    req.on("end", () => {
      let mode = "";
      try {
        mode = String((JSON.parse(body) as { mode?: string }).mode ?? "");
      } catch { /* 忽略坏 body */ }
      if (mode !== "off" && mode !== "auto") {
        json(res, 400, { error: "mode 只能是 off（游戏）或 auto（WSL）" });
        return;
      }
      switchVirt(mode)
        .then(() => {
          cache = null; // 状态即将变化（重启后），让下次查询拿新的
          json(res, 200, { ok: true, mode });
        })
        .catch(() => {
          // 用户在 UAC 弹窗点了「否」时 Start-Process 会失败
          json(res, 200, { ok: false, cancelled: true, error: "UAC 被取消或提权失败" });
        });
    });
  };

  /** 家里探针：POST 上报（X-Home-Token 独立小 token，来自 rana-web/.env 的 HOME_REPORT_TOKEN；没配 token 一律拒收——fail-closed）；GET 读最后上报 */
  const HOME_REPORT_PATH = path.join(here, ".health", "home-report.json");
  const readHomeToken = (): string => {
    try {
      const env = fs.readFileSync(path.join(here, ".env"), "utf8");
      return (env.match(/^HOME_REPORT_TOKEN=(.+)$/m)?.[1] ?? "").trim();
    } catch {
      return "";
    }
  };
  const homeHandler = (
    req: { method?: string; url?: string; headers?: Record<string, unknown>; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method === "POST") {
      const token = readHomeToken();
      const given = String(req.headers?.["x-home-token"] ?? "");
      if (!token || given !== token) {
        json(res, 403, { error: "探针 token 不对或未配置" });
        return;
      }
      let body = "";
      req.on("data", (c?: string) => {
        body += c ?? "";
        if (body.length > 65536) body = ""; // 超限视为坏包
      });
      req.on("end", () => {
        try {
          const report = JSON.parse(body) as Record<string, unknown>;
          if (!report || typeof report !== "object") throw new Error("bad");
          fs.mkdirSync(path.dirname(HOME_REPORT_PATH), { recursive: true });
          fs.writeFileSync(HOME_REPORT_PATH, JSON.stringify({ receivedAt: Date.now(), report }));
          json(res, 200, { ok: true });
        } catch {
          json(res, 400, { error: "上报内容不是合法 JSON" });
        }
      });
      return;
    }
    if (req.method === "GET") {
      try {
        json(res, 200, JSON.parse(fs.readFileSync(HOME_REPORT_PATH, "utf8")));
      } catch {
        json(res, 200, null);
      }
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-sys-status",
    configureServer(server) {
      server.middlewares.use("/__rana/sys/status", handler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/power", handler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/virt", virtHandler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/home-report", homeHandler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/home", homeHandler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/sys/status", handler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/power", handler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/virt", virtHandler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/home-report", homeHandler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/home", homeHandler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
