import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const execFileP = promisify(execFile);

// gateway 默认监听 ws://127.0.0.1:18789。
// 前端直连该地址；若浏览器 Origin 被网关拒绝，可改用 /gateway 代理路径
// （见 src/lib/gateway.ts 的回退逻辑与下方 server.proxy 配置）。

// 仅开发服务器：为本机前端提供 gateway token。
// 优先读本项目的 gateway 状态目录（K:\openclaw\.openclaw\.openclaw\openclaw.json），
// 再回退到 %USERPROFILE%\.openclaw\openclaw.json。
// 只在 loopback dev server 暴露；生产部署请通过设置面板手动填 token。
function readGatewayToken(): string {
  const candidates = [
    "K:\\openclaw\\.openclaw\\.openclaw\\openclaw.json",
    path.join(process.env.USERPROFILE ?? "", ".openclaw", "openclaw.json"),
  ];
  for (const file of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as { gateway?: { auth?: { token?: string } } };
      const token = cfg?.gateway?.auth?.token;
      if (token) return token;
    } catch {
      // 尝试下一个候选
    }
  }
  return "";
}

const OPENCLAW_CONFIG = "K:\\openclaw\\.openclaw\\.openclaw\\openclaw.json";

interface ModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  params?: Record<string, unknown>;
  [k: string]: unknown;
}
interface ProviderEntry {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: ModelEntry[];
  [k: string]: unknown;
}
type ProvidersMap = Record<string, ProviderEntry>;

interface FullConfig {
  models?: { providers?: ProvidersMap };
  agents?: {
    defaults?: { model?: { primary?: string }; compaction?: { memoryFlush?: { model?: string } }; models?: Record<string, unknown> };
    entries?: Record<string, { model?: string; utilityModel?: string }>;
  };
  [k: string]: unknown;
}

function readFullConfig(): FullConfig {
  return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf8")) as FullConfig;
}

function maskKey(key?: string): string {
  return key ? key.slice(0, 5) + "…" + key.slice(-4) : "";
}

function isLocalProvider(p: ProviderEntry): boolean {
  return /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(p.baseUrl ?? "");
}

/** 引用某 provider 的配置项（默认模型/agent 模型等），删除前检查 */
function providerReferences(cfg: FullConfig, providerId: string): string[] {
  const refs: string[] = [];
  const prefix = providerId + "/";
  const primary = cfg.agents?.defaults?.model?.primary;
  if (primary?.startsWith(prefix)) refs.push(`默认模型 ${primary}`);
  const flush = cfg.agents?.defaults?.compaction?.memoryFlush?.model;
  if (flush?.startsWith(prefix)) refs.push(`记忆落地模型 ${flush}`);
  for (const [agentId, entry] of Object.entries(cfg.agents?.entries ?? {})) {
    if (entry.model?.startsWith(prefix)) refs.push(`agent ${agentId} 的模型 ${entry.model}`);
    if (entry.utilityModel?.startsWith(prefix)) refs.push(`agent ${agentId} 的 utilityModel`);
  }
  for (const key of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    if (key.startsWith(prefix)) refs.push(`模型别名配置 ${key}`);
  }
  return refs;
}

/**
 * 云端模型多 provider 配置端点：
 * - GET  读全部 provider（key 打码，附模型列表与 local 标记）
 * - POST {id, baseUrl, apiKey?, models?} 新增/更新一个 provider（models 保留既有条目的 params 等扩展字段）
 * - DELETE ?id= 删除 provider（本地 provider 与仍被引用的拒删）
 * 写 openclaw.json 后由 gateway 文件监听热重载。
 * 另有 POST /__rana/provider-models {baseUrl, apiKey?} 服务端代理拉取 /models 列表（规避浏览器 CORS）。
 */
function ranaProviderConfigMiddleware(): Plugin {
  const readProviders = () => readFullConfig().models?.providers ?? {};

  const listProviders = () => {
    const providers = readProviders();
    return Object.entries(providers).map(([id, p]) => ({
      id,
      baseUrl: p.baseUrl ?? "",
      apiKeyMasked: maskKey(p.apiKey),
      hasKey: Boolean(p.apiKey),
      local: isLocalProvider(p),
      models: (p.models ?? []).map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, params: m.params ?? {} })),
    }));
  };

  const upsertProvider = (body: string) => {
    const { id, baseUrl, apiKey, models } = JSON.parse(body) as {
      id?: string; baseUrl?: string; apiKey?: string; models?: Array<{ id?: string; name?: string; contextWindow?: number }>;
    };
    if (!id || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new Error("provider id 需为小写字母/数字/连字符");
    const cfg = readFullConfig();
    const providers = (cfg.models ?? {}).providers ?? {};
    const cur = providers[id];
    if (!cur && (!baseUrl || !/^https?:\/\//.test(baseUrl))) throw new Error("新建 provider 必须填写 http(s):// 开头的 baseUrl");
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl 必须以 http(s):// 开头");
    if (!apiKey && !cur?.apiKey) throw new Error("当前无 key，必须填写 apiKey");
    fs.copyFileSync(OPENCLAW_CONFIG, OPENCLAW_CONFIG + ".bak-cloud");
    let next: ProviderEntry = { ...(cur ?? {}) };
    if (baseUrl) next.baseUrl = baseUrl.replace(/\/+$/, "");
    if (apiKey) next.apiKey = apiKey;
    if (!next.api) next.api = "openai-completions";
    if (Array.isArray(models)) {
      // 保留既有模型条目的扩展字段（params/cost 等），只按 UI 提交的字段覆盖
      const oldById = new Map((cur?.models ?? []).map((m) => [m.id, m]));
      next.models = models
        .filter((m): m is { id: string; name?: string; contextWindow?: number } => Boolean(m && typeof m.id === "string" && m.id.trim()))
        .map((m) => ({
          ...(oldById.get(m.id.trim()) ?? {}),
          id: m.id.trim(),
          ...(m.name ? { name: m.name } : {}),
          ...(typeof m.contextWindow === "number" && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
        }));
    }
    providers[id] = next;
    cfg.models = { ...(cfg.models ?? {}), providers };
    fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(cfg, null, 2), "utf8");
    return { ok: true as const, saved: id };
  };

  const deleteProvider = (id: string) => {
    const cfg = readFullConfig();
    const providers = (cfg.models ?? {}).providers ?? {};
    const cur = providers[id];
    if (!cur) throw new Error(`provider ${id} 不存在`);
    if (isLocalProvider(cur)) throw new Error("本地 provider（LM Studio）请直接编辑配置文件，不在云端面板删除");
    const refs = providerReferences(cfg, id);
    if (refs.length) throw new Error(`仍被引用，不能删除：${refs.join("；")}`);
    fs.copyFileSync(OPENCLAW_CONFIG, OPENCLAW_CONFIG + ".bak-cloud");
    delete providers[id];
    cfg.models = { ...(cfg.models ?? {}), providers };
    fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(cfg, null, 2), "utf8");
    return { ok: true as const, deleted: id };
  };

  const fetchProviderModels = async (body: string) => {
    const { baseUrl, apiKey, providerId } = JSON.parse(body) as { baseUrl?: string; apiKey?: string; providerId?: string };
    let url = baseUrl;
    let key = apiKey;
    if (!url && providerId) {
      const p = readProviders()[providerId];
      url = p?.baseUrl;
      key = key || p?.apiKey;
    }
    if (!url || !/^https?:\/\//.test(url)) throw new Error("需要 http(s):// 的 baseUrl");
    if (!key) throw new Error("缺少 API key（填写或选择已保存 key 的 provider）");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(url.replace(/\/+$/, "") + "/models", {
        headers: { authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`接口返回 HTTP ${r.status}`);
      const j = (await r.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string } | string> };
      const rows = j.data ?? j.models ?? [];
      const ids = rows.map((m) => (typeof m === "string" ? m : m.id ?? "")).filter(Boolean);
      return { ok: true as const, models: ids.sort() };
    } finally {
      clearTimeout(timer);
    }
  };

  const handler = (
    req: { method?: string; url?: string; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    res.setHeader("content-type", "application/json");
    const safe = (fn: () => unknown) => {
      try {
        const out = fn();
        res.end(JSON.stringify(out));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    };
    if (req.method === "GET") {
      safe(() => ({ providers: listProviders() }));
      return;
    }
    if (req.method === "DELETE") {
      const id = new URL(req.url ?? "", "http://x").searchParams.get("id") ?? "";
      safe(() => (id ? deleteProvider(id) : { error: "缺少 id" }));
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c?: string) => { body += c ?? ""; });
      req.on("end", () => {
        safe(() => upsertProvider(body));
      });
      return;
    }
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "method not allowed" }));
  };

  const modelsHandler = (
    req: { method?: string; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    res.setHeader("content-type", "application/json");
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    let body = "";
    req.on("data", (c?: string) => { body += c ?? ""; });
    req.on("end", () => {
      fetchProviderModels(body)
        .then((out) => res.end(JSON.stringify(out)))
        .catch((e: Error) => {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: e.message }));
        });
    });
  };
  return {
    name: "rana-provider-config",
    configureServer(server) {
      server.middlewares.use("/__rana/provider-config", handler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/provider-models", modelsHandler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/provider-config", handler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/provider-models", modelsHandler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 电脑状态端点（本机只读监控 + 电源计划切换）：
 * - GET /__rana/sys/status  聚合系统数据（硬盘/CPU/内存/开机时长/显卡+显存进程/电源计划/虚拟化/服务端口/网速/外网连通），8 秒缓存
 * - POST /__rana/sys/power {guid}  切换电源计划（仅接受 GUID 格式参数、仅本机回环来源）
 * 服务端口清单 = 默认四件套 + rana-web/services.json 用户自加项（{name,port}）。
 * 所有子进程调用均用 execFile 数组参数（不经 shell、无字符串拼接）。
 */
function ranaSysStatusMiddleware(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CACHE_MS = 8000;
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

  /** 服务端口清单：默认四件套 + rana-web/services.json 自加项（{name,port}，端口非法/重名的忽略） */
  const DEFAULT_SERVICES: Array<{ name: string; port: number }> = [
    { name: "OpenClaw 网关", port: 18789 },
    { name: "rana-web 前端", port: 5173 },
    { name: "LM Studio", port: 1234 },
    { name: "Clash 代理", port: 7897 },
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
    const args = ["-I", "-s", "-o", "NUL", "-w", "%{time_total}", "--connect-timeout", "3", "--max-time", "5"];
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
    const jobs: Array<Promise<{ label: string; ok: boolean; ms: number }>> = [probeUrl("GitHub（走 Clash）", "https://github.com", "http://127.0.0.1:7897")];
    if (apiOrigin) jobs.push(probeUrl("模型 API（直连）", apiOrigin));
    const probes = await Promise.all(jobs);
    const data = { probes };
    netProbeCache = { at: Date.now(), data };
    return data;
  };

  const buildStatus = async () => {
    const [sys, gpu, power, virt, services, netSpeed, netProbes] = await Promise.all([
      querySystem(),
      queryGpu().catch(() => null),
      queryPower().catch(() => null),
      queryVirt().catch(() => null),
      queryServices().catch(() => readServiceList().map((s) => ({ ...s, listening: false, pid: 0, proc: null, uptimeSec: null }))),
      queryNetSpeed().catch(() => null),
      queryNetProbes().catch(() => ({ probes: [] })),
    ]);
    return { sys, gpu, power, virt, services, net: { speed: netSpeed, probes: netProbes.probes }, ts: Date.now() };
  };

  const isLoopback = (req: { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> }) => {
    const ra = req.socket?.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra)) return false;
    const origin = String(req.headers?.origin ?? "");
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return false;
    return true;
  };

  const json = (res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void }, code: number, out: unknown) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = code;
    res.end(JSON.stringify(out));
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
          "Write-Host '== 已切回 WSL 模式，重启后生效 =='";
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

  return {
    name: "rana-sys-status",
    configureServer(server) {
      server.middlewares.use("/__rana/sys/status", handler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/power", handler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/virt", virtHandler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/sys/status", handler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/power", handler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/sys/virt", virtHandler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 乐奈头像端点（图片只存本地 .avatars/ 目录，该目录已进 .gitignore 不入公开仓库）：
 * - GET    /__rana/avatar   当前头像（无则 404）
 * - POST   /__rana/avatar   上传（png/jpg/webp ≤4MB，raw body + content-type 判类型；仅本机回环）
 * - DELETE /__rana/avatar   恢复默认手绘脸（删除文件）
 */
function ranaAvatarMiddleware(): Plugin {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".avatars");
  const EXT_BY_TYPE: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  const files = () => {
    try {
      return fs.readdirSync(dir).filter((f) => /\.(png|jpg|webp)$/.test(f));
    } catch {
      return [];
    }
  };
  const current = () => files().map((f) => path.join(dir, f))[0];

  const json = (res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void }, code: number, out: unknown) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = code;
    res.end(JSON.stringify(out));
  };
  const isLoopback = (req: { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> }) => {
    const ra = req.socket?.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra)) return false;
    const origin = String(req.headers?.origin ?? "");
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return false;
    return true;
  };

  const handler = (
    req: { method?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string }; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string | Buffer) => void },
  ) => {
    if (req.method === "GET") {
      const file = current();
      if (!file) {
        json(res, 404, { error: "no avatar" });
        return;
      }
      const ext = path.extname(file).slice(1);
      res.setHeader("content-type", ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "image/webp");
      res.setHeader("cache-control", "no-cache");
      res.end(fs.readFileSync(file));
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }
    if (req.method === "DELETE") {
      for (const f of files()) fs.rmSync(path.join(dir, f));
      json(res, 200, { ok: true, cleared: true });
      return;
    }
    if (req.method === "POST") {
      const ext = EXT_BY_TYPE[String(req.headers?.["content-type"] ?? "")] ?? "";
      if (!ext) {
        json(res, 400, { error: "只支持 png / jpg / webp" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c?: string) => {
        size += c?.length ?? 0;
        if (size > 4 * 1024 * 1024) {
          json(res, 413, { error: "图片太大（限 4MB）" });
          return;
        }
        chunks.push(Buffer.from(c ?? "", "binary"));
      });
      req.on("end", () => {
        try {
          fs.mkdirSync(dir, { recursive: true });
          for (const f of files()) fs.rmSync(path.join(dir, f)); // 单一头像：旧的清掉
          fs.writeFileSync(path.join(dir, `avatar.${ext}`), Buffer.concat(chunks));
          json(res, 200, { ok: true, url: `/__rana/avatar?t=${Date.now()}` });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-avatar",
    configureServer(server) {
      server.middlewares.use("/__rana/avatar", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/avatar", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 早报数据端点：GET /__rana/news 读本地 .news/report.json（由 news-report.mjs 每天 08:00 生成）。
 * 无文件/读失败返回 {empty:true}，前端展示引导文案。
 */
function ranaNewsMiddleware(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, ".news", "report.json");
  let generating = false; // 互斥：并发触发生成（含 React dev 双 effect）只跑一次脚本
  const newsHandler = (
    req: { method?: string; socket?: { remoteAddress?: string }; headers?: Record<string, unknown> },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      try {
        res.end(fs.readFileSync(file, "utf8"));
      } catch {
        res.end(JSON.stringify({ empty: true }));
      }
      return;
    }
    // POST /__rana/news/generate：打开早报页且今天还没生成过时，前端触发生成（省额度：不开页面不查询）
    if (req.method === "POST") {
      const ra = req.socket?.remoteAddress ?? "";
      const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra);
      const origin = String(req.headers?.origin ?? "");
      const originOk = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
      if (!loopback || !originOk) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "仅本机可操作" }));
        return;
      }
      if (generating) {
        res.end(JSON.stringify({ ok: true, already: true }));
        return;
      }
      generating = true;
      execFileP(process.execPath, [path.join(here, "news-report.mjs")], {
        encoding: "utf8", timeout: 90000, windowsHide: true,
      })
        .then(({ stdout }) => {
          res.end(JSON.stringify({ ok: true, log: stdout.trim().split("\n").slice(-3).join(" | ") }));
        })
        .catch((e: Error) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        })
        .finally(() => {
          generating = false;
        });
      return;
    }
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "method not allowed" }));
  };
  return {
    name: "rana-news",
    configureServer(server) {
      server.middlewares.use("/__rana/news", newsHandler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/news", newsHandler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 学习计划端点 v2（数据只存本地 .study/ 目录，已进 .gitignore 不入公开仓库）：
 * - GET    /__rana/study                  读课程表 schedule.json（v1 自动迁移 v2）
 * - POST   /__rana/study/save             保存 {courses?, plans?, contract?}（materials 由上传/删除端点管理）
 * - POST   /__rana/study/material?name=   上传学习资料（raw body ≤10MB）
 * - DELETE /__rana/study/material?id=     删除资料（仍被课程引用时拒删）
 * - POST   /__rana/study/plan             排课（Rana 按 study-planner skill 直接改 schedule.json）
 * - POST   /__rana/study/quiz-gen         出题：{courseId} | {mistakeIds:错题重考} | {planId, final:期末考}
 * - POST   /__rana/study/quiz-grade       判分；错题自动回收、错题重考自动销账、期末考成绩记到计划
 * 服务端还负责：done 课自动排复习课（+1/+7/+16 天）、连续打卡计算、打卡里程碑评语（异步）。
 */
function ranaStudyMiddleware(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const studyDir = path.join(here, ".study");
  const scheduleFile = path.join(studyDir, "schedule.json");
  const materialsDir = path.join(studyDir, "materials");
  let agentBusy = false;

  interface StudyQuiz {
    status?: "none" | "pending" | "done";
    score?: number;
    comment?: string;
    at?: number;
  }
  interface StudyCourse {
    id: string;
    title: string;
    date: string;
    timeStart?: string;
    timeEnd?: string;
    status: "planned" | "done";
    kind?: "lesson" | "review";
    reviewOf?: string;
    reviewGap?: number;
    planId?: string;
    dependsOn?: string[];
    estMin?: number;
    materialIds?: string[];
    note?: string;
    postponedCount?: number;
    doneAt?: number;
    quiz?: StudyQuiz;
  }
  interface StudyMaterial {
    id: string;
    name: string;
    file: string;
    size: number;
    addedAt: number;
  }
  interface StudyPlan {
    id: string;
    name: string;
    createdAt: number;
    lastFinal?: { score: number; comment: string; at: number };
  }
  interface StudyMistake {
    id: string;
    courseId?: string;
    courseTitle: string;
    q: string;
    myAnswer: string;
    review?: string;
    addedAt: number;
    resolvedAt?: number;
  }
  interface StudyReport {
    id: string;
    kind: "weekly";
    title: string;
    text: string;
    at: number;
  }
  interface StudySchedule {
    version: number;
    plans: StudyPlan[];
    courses: StudyCourse[];
    materials: StudyMaterial[];
    mistakes: StudyMistake[];
    reports: StudyReport[];
    streak: { days: number; best: number; lastDay: string; comment?: string; commentDay?: string };
    contract?: { text: string; updatedAt: number };
    updatedAt: number;
  }

  const DEFAULT_PLAN_ID = "p-default";
  /** 学完一节正课自动安排的复习间隔（天）：1 / 7 / 16 */
  const REVIEW_GAPS = [1, 7, 16];
  /** 打卡里程碑（连续天数），到了让她说一句 */
  const STREAK_MILESTONES = [3, 7, 14, 21, 30, 50, 100, 365];

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const addDays = (ds: string, n: number) => {
    const [y, m, d] = ds.split("-").map(Number);
    return localDate(new Date(y, m - 1, d + n));
  };
  const todayStr = () => localDate(new Date());
  /** 从 from 的第二天起，找第一个当天没有任何课的日期（与页面顺延规则一致；测验不过重学用） */
  const nextFreeDay = (s: StudySchedule, from: string): string => {
    const taken = new Set(s.courses.map((c) => c.date));
    let d = addDays(from, 1);
    for (let i = 0; i < 400; i++) {
      if (!taken.has(d)) return d;
      d = addDays(d, 1);
    }
    return d;
  };

  const emptySchedule = (): StudySchedule => ({
    version: 2,
    plans: [{ id: DEFAULT_PLAN_ID, name: "默认计划", createdAt: Date.now() }],
    courses: [],
    materials: [],
    mistakes: [],
    reports: [],
    streak: { days: 0, best: 0, lastDay: "" },
    updatedAt: 0,
  });

  const readSchedule = (): StudySchedule => {
    try {
      const s = JSON.parse(fs.readFileSync(scheduleFile, "utf8")) as StudySchedule;
      // v1 → v2 迁移：补齐新字段，旧数据原样保留
      if (!Array.isArray(s.plans) || !s.plans.length) s.plans = emptySchedule().plans;
      if (!Array.isArray(s.courses)) s.courses = [];
      if (!Array.isArray(s.materials)) s.materials = [];
      if (!Array.isArray(s.mistakes)) s.mistakes = [];
      if (!Array.isArray(s.reports)) s.reports = [];
      if (!s.streak) s.streak = { days: 0, best: 0, lastDay: "" };
      s.version = 2;
      return s;
    } catch {
      return emptySchedule();
    }
  };

  /** 连续打卡：按 doneAt 的本地日期，从最近一天（今天或昨天）往前数连续有完成的天数 */
  const computeStreak = (s: StudySchedule) => {
    const days = new Set(
      s.courses.filter((c) => c.status === "done" && c.doneAt).map((c) => localDate(new Date(c.doneAt!))),
    );
    if (!days.size) {
      s.streak.days = 0;
      s.streak.lastDay = "";
      return;
    }
    const sorted = [...days].sort().reverse();
    let last = sorted[0];
    const t = todayStr();
    if (last !== t && last !== addDays(t, -1)) {
      // 最近一次完成既不是今天也不是昨天：断卡
      s.streak.days = 0;
      s.streak.lastDay = last;
      return;
    }
    let n = 1;
    while (days.has(addDays(last, -1))) {
      last = addDays(last, -1);
      n++;
    }
    s.streak.days = n;
    s.streak.lastDay = sorted[0];
    s.streak.best = Math.max(s.streak.best ?? 0, n);
  };

  const writeSchedule = (s: StudySchedule) => {
    fs.mkdirSync(studyDir, { recursive: true });
    try {
      fs.copyFileSync(scheduleFile, scheduleFile + ".bak");
    } catch {
      // 首次写入没有旧文件
    }
    computeStreak(s);
    s.updatedAt = Date.now();
    fs.writeFileSync(scheduleFile, JSON.stringify(s, null, 2), "utf8");
  };

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}$/;

  /** 校验并规整页面提交的 courses：未知字段丢弃，坏行抛错（页面直接展示错误） */
  const cleanCourses = (input: unknown): StudyCourse[] => {
    if (!Array.isArray(input)) throw new Error("courses 需为数组");
    if (input.length > 2000) throw new Error("课程数超出上限（2000）");
    const ids = new Set<string>();
    return input.map((raw, i) => {
      const c = raw as Partial<StudyCourse>;
      if (!c || typeof c !== "object") throw new Error(`第 ${i + 1} 条课程格式不对`);
      const id = String(c.id ?? "");
      const title = String(c.title ?? "").trim();
      const date = String(c.date ?? "");
      if (!id || !title || !DATE_RE.test(date)) throw new Error(`第 ${i + 1} 条课程缺 id/标题，或日期不是 YYYY-MM-DD`);
      if (ids.has(id)) throw new Error(`课程 id 重复：${id}`);
      ids.add(id);
      const quizRaw = (c.quiz ?? {}) as StudyQuiz;
      const quiz: StudyQuiz = {
        status: quizRaw.status === "done" || quizRaw.status === "pending" ? quizRaw.status : "none",
        ...(typeof quizRaw.score === "number" ? { score: quizRaw.score } : {}),
        ...(typeof quizRaw.comment === "string" ? { comment: quizRaw.comment } : {}),
        ...(typeof quizRaw.at === "number" ? { at: quizRaw.at } : {}),
      };
      return {
        id,
        title,
        date,
        status: c.status === "done" ? "done" : "planned",
        ...(c.kind === "review" ? { kind: "review" as const } : { kind: "lesson" as const }),
        ...(typeof c.reviewOf === "string" ? { reviewOf: c.reviewOf } : {}),
        ...(typeof c.reviewGap === "number" ? { reviewGap: c.reviewGap } : {}),
        ...(typeof c.planId === "string" && c.planId ? { planId: c.planId } : { planId: DEFAULT_PLAN_ID }),
        ...(Array.isArray(c.dependsOn) && c.dependsOn.length ? { dependsOn: c.dependsOn.map(String) } : {}),
        ...(typeof c.estMin === "number" && c.estMin > 0 ? { estMin: Math.round(c.estMin) } : {}),
        ...(typeof c.timeStart === "string" && TIME_RE.test(c.timeStart) ? { timeStart: c.timeStart } : {}),
        ...(typeof c.timeEnd === "string" && TIME_RE.test(c.timeEnd) ? { timeEnd: c.timeEnd } : {}),
        ...(Array.isArray(c.materialIds) ? { materialIds: c.materialIds.map(String) } : {}),
        ...(typeof c.note === "string" ? { note: c.note } : {}),
        ...(typeof c.postponedCount === "number" ? { postponedCount: c.postponedCount } : {}),
        ...(typeof c.doneAt === "number" ? { doneAt: c.doneAt } : {}),
        quiz,
      };
    });
  };

  const cleanPlans = (input: unknown): StudyPlan[] => {
    if (!Array.isArray(input)) throw new Error("plans 需为数组");
    if (input.length > 20) throw new Error("计划数超出上限（20）");
    const out: StudyPlan[] = [];
    for (const raw of input) {
      const p = raw as Partial<StudyPlan>;
      const id = String(p.id ?? "");
      const name = String(p.name ?? "").trim().slice(0, 40);
      if (!id || !name) continue;
      if (out.some((x) => x.id === id)) continue;
      out.push({
        id,
        name,
        createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
        ...(p.lastFinal && typeof p.lastFinal.score === "number"
          ? { lastFinal: { score: p.lastFinal.score, comment: String(p.lastFinal.comment ?? ""), at: p.lastFinal.at ?? Date.now() } }
          : {}),
      });
    }
    if (!out.some((p) => p.id === DEFAULT_PLAN_ID)) out.unshift({ id: DEFAULT_PLAN_ID, name: "默认计划", createdAt: Date.now() });
    return out;
  };

  /** Windows 文件名安全化：去掉非法字符与前导点，限长 */
  const safeFilename = (name: string): string => {
    const cut = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").trim().slice(0, 80);
    return cut || "material";
  };

  const materialAbs = (m: StudyMaterial) => path.join(materialsDir, m.file);

  /** 唤醒 Rana：子进程跑 study-agent.mjs，解析它 stdout 的最后一行 JSON；model 可选（页面选的模型） */
  const spawnAgent = async (message: string, model?: string): Promise<{ ok: boolean; reply?: string; data?: Record<string, unknown>; error?: string }> => {
    const args = [path.join(here, "study-agent.mjs"), "--message", message];
    if (model) args.push("--model", model);
    const { stdout } = await execFileP(process.execPath, args, {
      encoding: "utf8",
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  };

  /** 排课/出题/判分共用的互斥执行：她一次只干一件事 */
  const runAgent = async (message: string, model?: string) => {
    if (agentBusy) throw new Error("她正忙着上一个请求，等一下再试");
    agentBusy = true;
    try {
      return await spawnAgent(message, model);
    } finally {
      agentBusy = false;
    }
  };

  /** 学完一节正课 → 自动排复习课（+1/+7/+16 天，已存在的不重复排） */
  const insertReviews = (s: StudySchedule, course: StudyCourse) => {
    if (course.kind === "review") return; // 复习课不再套娃
    const doneDay = course.doneAt ? localDate(new Date(course.doneAt)) : todayStr();
    for (const gap of REVIEW_GAPS) {
      const id = `rv-${course.id}-${gap}`;
      if (s.courses.some((c) => c.id === id)) continue;
      s.courses.push({
        id,
        title: `复习：${course.title}`,
        date: addDays(doneDay, gap),
        status: "planned",
        kind: "review",
        reviewOf: course.id,
        reviewGap: gap,
        planId: course.planId ?? DEFAULT_PLAN_ID,
        estMin: 30,
        ...(course.materialIds?.length ? { materialIds: [...course.materialIds] } : {}),
        quiz: { status: "none" },
      });
    }
  };

  /** 打卡里程碑：到了给一句她的评语（异步，不挡保存请求） */
  const fireStreakComment = () => {
    const s = readSchedule();
    if (!s.streak.days || !STREAK_MILESTONES.includes(s.streak.days)) return;
    if (s.streak.commentDay === todayStr()) return;
    const days = s.streak.days;
    void runAgent(
      [
        `【打卡评语·页面触发】用户刚把连续学习打卡打到了 ${days} 天。`,
        `给一句评语（就一句，保持你平时的说话风格：话少、直接，坚持这么久可以难得地夸一句，别肉麻）。`,
        '最后输出一个 ```json 代码块：{"comment":"评语"}',
      ].join("\n"),
    )
      .then((r) => {
        const comment = (r.data ?? {}).comment;
        if (typeof comment !== "string" || !comment) return;
        const fresh = readSchedule(); // 写回前重读，别覆盖这期间的改动
        if (fresh.streak.days === days && fresh.streak.commentDay !== todayStr()) {
          fresh.streak.comment = comment;
          fresh.streak.commentDay = todayStr();
          writeSchedule(fresh);
        }
      })
      .catch(() => {
        // 评语失败无所谓，打卡数照算
      });
  };

  /** 判分后回收错题（答错/半对的题），返回新增的错题 */
  const collectMistakes = (
    s: StudySchedule,
    courseTitle: string,
    courseId: string | undefined,
    questions: Array<{ idx: number; q: string }>,
    answers: Array<{ idx: number; answer: string }>,
    verdicts: Array<{ idx: number; correct: boolean | string; review?: string }>,
  ): StudyMistake[] => {
    const out: StudyMistake[] = [];
    for (const v of verdicts) {
      if (v.correct === true) continue;
      const q = questions.find((x) => x.idx === v.idx);
      const a = answers.find((x) => x.idx === v.idx);
      if (!q) continue;
      out.push({
        id: `mk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${v.idx}`,
        ...(courseId ? { courseId } : {}),
        courseTitle,
        q: q.q,
        myAnswer: a?.answer ?? "",
        review: v.review ?? "",
        addedAt: Date.now(),
      });
    }
    s.mistakes.push(...out);
    if (s.mistakes.length > 500) s.mistakes = s.mistakes.slice(-500); // 错题本封顶，太老的丢弃
    return out;
  };

  const matLines = (s: StudySchedule) =>
    s.materials.length
      ? s.materials.map((m) => `- ${m.id} ${m.name} → ${materialAbs(m)}`).join("\n")
      : "（资料库目前是空的：提醒用户先上传资料，或把资料发到聊天里。）";

  const courseMats = (course: StudyCourse, s: StudySchedule) => {
    const mats = (course.materialIds ?? [])
      .map((id) => s.materials.find((m) => m.id === id))
      .filter((m): m is StudyMaterial => Boolean(m));
    return mats.length
      ? mats.map((m) => `- ${m.name} → ${materialAbs(m)}`).join("\n")
      : "（这节课没挂资料，按课程标题和笔记出。）";
  };

  /** 难度自适应的上下文：近期成绩 + 未解决错题 */
  const difficultyContext = (s: StudySchedule, planId: string) => {
    const recent = s.courses
      .filter((c) => (c.planId ?? DEFAULT_PLAN_ID) === planId && c.quiz?.status === "done")
      .sort((a, b) => (b.quiz?.at ?? 0) - (a.quiz?.at ?? 0))
      .slice(0, 6)
      .map((c) => `${c.title}=${c.quiz?.score}分`);
    const open = s.mistakes.filter((m) => !m.resolvedAt);
    return [
      recent.length ? `该计划近期测验：${recent.join("、")}` : "该计划还没有测验记录",
      open.length ? `未解决错题 ${open.length} 道，例如：${open.slice(0, 3).map((m) => `「${m.q.slice(0, 40)}」`).join("；")}` : "没有未解决错题",
      "出题时自适应：掌握好的点别出重复送分题；错过的、分数低的地方多出、出难一点。",
    ].join("\n");
  };

  const planMessage = (requirements: string) => {
    const s = readSchedule();
    return [
      "【学习排课·页面触发】用户在学习计划页面点了「让Rana排课」。",
      `用户要求：${requirements.trim() || "（没写具体要求。按资料情况合理排，拿不准的假设写进 summary 里说明。）"}`,
      `资料库（可用 read 工具读的绝对路径）：\n${matLines(s)}`,
      `课程表文件：${scheduleFile}（先 read 最新内容，改完写回；数据格式与规则见 study-planner skill）`,
      '按 study-planner skill 的流程处理（估时、超90分钟拆分、负荷均衡、依赖关系都按 skill 里的规则）。完成后回复的最后必须是一个 ```json 代码块：{"ok":true,"summary":"一两句话说明排了什么"}；失败则 {"ok":false,"summary":"原因"}。',
    ].join("\n\n");
  };

  const quizGenMessage = (course: StudyCourse, s: StudySchedule, requirements: string) =>
    [
      `【出题·页面触发】用户学完了课程「${course.title}」（${course.date}${course.kind === "review" ? "，这是复习课，题目要综合一点" : ""}），点了「出题测验」。`,
      `课程笔记：${course.note?.trim() || "无"}`,
      `关联资料（可用 read 工具读的绝对路径）：\n${courseMats(course, s)}`,
      `难度参考（自适应）：\n${difficultyContext(s, course.planId ?? DEFAULT_PLAN_ID)}`,
      `用户附加要求：${requirements.trim() || "无"}`,
      '按 study-quiz skill 出题。回复的最后必须是一个 ```json 代码块：{"questions":[{"idx":1,"type":"choice","q":"…","options":["…","…","…","…"]},{"idx":2,"type":"short","q":"…"}]}。题目里不要带答案。',
    ].join("\n\n");

  const drillMessage = (mistakes: StudyMistake[]) =>
    [
      "【出题·错题重考·页面触发】以下是用户之前的错题（含他当时的错误作答与点评）：",
      JSON.stringify(
        mistakes.map((m) => ({ id: m.id, 课程: m.courseTitle, 题: m.q, 他的答案: m.myAnswer, 当时点评: m.review ?? "" })),
        null,
        1,
      ),
      "针对这些薄弱点出 3~5 道新题：可以换角度、换题型问同一个点，别原题复读。",
      '回复的最后必须是一个 ```json 代码块：{"questions":[{"idx":1,"type":"choice","q":"…","options":[…],"targetMistake":"对应的错题id"}]}，每题标 targetMistake。',
    ].join("\n\n");

  const finalMessage = (plan: StudyPlan, s: StudySchedule) => {
    const cs = s.courses.filter((c) => (c.planId ?? DEFAULT_PLAN_ID) === plan.id);
    const mats = [...new Set(cs.flatMap((c) => c.materialIds ?? []))]
      .map((id) => s.materials.find((m) => m.id === id))
      .filter((m): m is StudyMaterial => Boolean(m));
    return [
      `【期末考·页面触发】用户要对计划「${plan.name}」发起期末考。`,
      `计划内课程：\n${cs.map((c) => `- ${c.title}（${c.status === "done" ? "已学完" : "未完成"}${c.quiz?.score != null ? `，测验${c.quiz.score}分` : ""}）`).join("\n") || "（还没有课程）"}`,
      `涉及资料（可用 read 工具读的绝对路径）：\n${mats.map((m) => `- ${m.name} → ${materialAbs(m)}`).join("\n") || "（无资料）"}`,
      `难度参考（自适应）：\n${difficultyContext(s, plan.id)}`,
      "按 study-quiz skill 的期末考模式：综合全部资料出 10 题混合大卷，覆盖面要全，错过的点重点考。",
      '回复的最后必须是一个 ```json 代码块：{"questions":[…]}（格式同学规出题）。',
    ].join("\n\n");
  };

  const quizGradeMessage = (courseTitle: string, matText: string, questions: unknown, answers: unknown, hint: string) =>
    [
      `【判题·页面触发】${courseTitle}，请判分。`,
      matText,
      `题目与用户作答（JSON）：\n${JSON.stringify({ questions, answers }, null, 1)}`,
      hint,
      '按 study-quiz skill 判题。回复的最后必须是一个 ```json 代码块：{"score":0到100的整数,"comment":"总评","verdicts":[{"idx":1,"correct":true,"review":"一句点评"}]}。',
    ].join("\n\n");

  const json = (
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
    code: number,
    out: unknown,
  ) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = code;
    res.end(JSON.stringify(out));
  };
  const isLoopback = (req: { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> }) => {
    const ra = req.socket?.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra)) return false;
    const origin = String(req.headers?.origin ?? "");
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return false;
    return true;
  };
  const readBody = (req: { on: (ev: string, cb: (c?: string) => void) => void }) =>
    new Promise<string>((resolve) => {
      let body = "";
      req.on("data", (c?: string) => {
        body += c ?? "";
      });
      req.on("end", () => resolve(body));
    });

  const handler = (
    req: {
      method?: string;
      url?: string;
      socket?: { remoteAddress?: string };
      headers?: Record<string, unknown>;
      on: (ev: string, cb: (c?: string) => void) => void;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string | Buffer) => void },
  ) => {
    const u = new URL(req.url ?? "/", "http://x");
    const route = u.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && route === "/") {
      json(res, 200, readSchedule());
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }

    if (req.method === "POST" && route === "/save") {
      readBody(req).then((body) => {
        try {
          const parsed = JSON.parse(body || "{}") as { courses?: unknown; plans?: unknown; contract?: { text?: string } };
          const s = readSchedule();
          const before = new Map(s.courses.map((c) => [c.id, c]));
          if (parsed.plans !== undefined) s.plans = cleanPlans(parsed.plans);
          if (parsed.courses !== undefined) s.courses = cleanCourses(parsed.courses);
          if (parsed.contract !== undefined) {
            const text = String(parsed.contract?.text ?? "").trim().slice(0, 500);
            s.contract = text ? { text, updatedAt: Date.now() } : undefined;
          }
          // 新学完的课：补 doneAt + 自动排复习课
          let reviewsAdded = 0;
          for (const c of s.courses) {
            if (c.status === "done" && !c.doneAt && !before.get(c.id)?.doneAt) {
              c.doneAt = Date.now();
              const n0 = s.courses.length;
              insertReviews(s, c);
              reviewsAdded += s.courses.length - n0;
            }
          }
          writeSchedule(s);
          fireStreakComment(); // 内部自判：到里程碑且今天没说过才让她说一句（异步，不挡保存）
          json(res, 200, { ok: true, reviewsAdded, updatedAt: s.updatedAt, streak: s.streak });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/material") {
      const name = safeFilename(decodeURIComponent(u.searchParams.get("name") ?? "material"));
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on("data", (c?: string) => {
        size += c?.length ?? 0;
        if (size > 10 * 1024 * 1024) {
          tooBig = true;
          return;
        }
        chunks.push(Buffer.from(c ?? "", "binary"));
      });
      req.on("end", () => {
        if (tooBig) {
          json(res, 413, { error: "文件太大（限 10MB）" });
          return;
        }
        try {
          const s = readSchedule();
          const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const file = `${id}-${name}`;
          fs.mkdirSync(materialsDir, { recursive: true });
          fs.writeFileSync(path.join(materialsDir, file), Buffer.concat(chunks));
          const material: StudyMaterial = { id, name, file, size, addedAt: Date.now() };
          s.materials.push(material);
          writeSchedule(s);
          json(res, 200, { ok: true, material });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/material") {
      const id = u.searchParams.get("id") ?? "";
      try {
        const s = readSchedule();
        const m = s.materials.find((x) => x.id === id);
        if (!m) throw new Error(`资料不存在：${id || "(空id)"}`);
        const usedBy = s.courses.filter((c) => (c.materialIds ?? []).includes(id));
        if (usedBy.length) throw new Error(`还有 ${usedBy.length} 节课挂着这份资料（先在课程里解绑或删课）`);
        s.materials = s.materials.filter((x) => x.id !== id);
        try {
          fs.rmSync(materialAbs(m));
        } catch {
          // 文件没了也不阻塞登记清理
        }
        writeSchedule(s);
        json(res, 200, { ok: true, deleted: id });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return;
    }

    if (req.method === "POST" && (route === "/plan" || route === "/quiz-gen" || route === "/quiz-grade")) {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;

          if (route === "/plan") {
            const r = await runAgent(planMessage(String(parsed.requirements ?? "")), model);
            const d = (r.data ?? {}) as { ok?: boolean; summary?: string };
            const ok = r.ok && d.ok !== false;
            json(res, ok ? 200 : 500, {
              ok,
              summary: d.summary ?? (r.reply ?? r.error ?? "").slice(0, 300),
              schedule: readSchedule(),
            });
            return;
          }

          if (route === "/quiz-gen") {
            const s = readSchedule();
            // 三种出题：错题重考 > 期末考 > 普通课程
            if (Array.isArray(parsed.mistakeIds) && parsed.mistakeIds.length) {
              const mistakes = s.mistakes.filter(
                (m) => !m.resolvedAt && (parsed.mistakeIds as string[]).includes(m.id),
              );
              if (!mistakes.length) {
                json(res, 400, { error: "这些错题不存在或都已销账" });
                return;
              }
              const r = await runAgent(drillMessage(mistakes), model);
              const questions = (r.data ?? {}).questions;
              if (!r.ok || !Array.isArray(questions) || !questions.length) {
                json(res, 500, { ok: false, error: "她没按契约出题：" + (r.error ?? (r.reply ?? "").slice(0, 200)) });
                return;
              }
              json(res, 200, { ok: true, questions });
              return;
            }
            if (parsed.final === true && typeof parsed.planId === "string") {
              const plan = s.plans.find((p) => p.id === parsed.planId);
              if (!plan) {
                json(res, 400, { error: `计划不存在：${parsed.planId}` });
                return;
              }
              const r = await runAgent(finalMessage(plan, s), model);
              const questions = (r.data ?? {}).questions;
              if (!r.ok || !Array.isArray(questions) || !questions.length) {
                json(res, 500, { ok: false, error: "她没按契约出期末考卷：" + (r.error ?? (r.reply ?? "").slice(0, 200)) });
                return;
              }
              json(res, 200, { ok: true, questions });
              return;
            }
            const courseId = String(parsed.courseId ?? "");
            const course = s.courses.find((c) => c.id === courseId);
            if (!course) {
              json(res, 400, { error: `课程不存在：${courseId || "(空id)"}` });
              return;
            }
            const r = await runAgent(quizGenMessage(course, s, String(parsed.requirements ?? "")), model);
            const questions = (r.data ?? {}).questions;
            if (!r.ok || !Array.isArray(questions) || !questions.length) {
              json(res, 500, { ok: false, error: "她没按契约出题：" + (r.error ?? (r.reply ?? "").slice(0, 200)) });
              return;
            }
            json(res, 200, { ok: true, questions });
            return;
          }

          // quiz-grade：课程 / 错题重考 / 期末考三种
          const s = readSchedule();
          const questions = Array.isArray(parsed.questions) ? (parsed.questions as Array<Record<string, unknown>>) : [];
          const answers = Array.isArray(parsed.answers) ? (parsed.answers as Array<{ idx: number; answer: string }>) : [];
          let courseTitle = "测验";
          let matText = "（无资料）";
          let hint = "判分由页面写回课程表，你不要动 schedule.json。";

          const courseId = typeof parsed.courseId === "string" ? parsed.courseId : "";
          const course = courseId ? s.courses.find((c) => c.id === courseId) : undefined;
          let relearn = "";
          if (course) {
            courseTitle = `课程「${course.title}」的测验`;
            matText = `关联资料（判定有疑问时可 read 核对）：\n${courseMats(course, s)}`;
          } else if (parsed.drill === true) {
            courseTitle = "错题重考";
            hint = "这是错题重考：逐题判定。页面会按你的 verdict 把 targetMistake 对应的错题销账（全对才销），你不要动 schedule.json。";
          } else if (typeof parsed.forPlanId === "string") {
            const plan = s.plans.find((p) => p.id === parsed.forPlanId);
            courseTitle = `计划「${plan?.name ?? parsed.forPlanId}」的期末考`;
            hint = "这是期末考：判分严格一点，总评按整个计划的学习质量给。成绩由页面写回计划，你不要动 schedule.json。";
          }

          const r = await runAgent(quizGradeMessage(courseTitle, matText, questions, answers, hint), model);
          const d = (r.data ?? {}) as { score?: number; comment?: string; verdicts?: Array<{ idx: number; correct: boolean | string; review?: string }> };
          if (!r.ok || typeof d.score !== "number" || !Array.isArray(d.verdicts)) {
            json(res, 500, { ok: false, error: "她没按契约判分：" + (r.error ?? (r.reply ?? "").slice(0, 200)) });
            return;
          }

          // 错题回收（三种模式都收）
          const added = collectMistakes(s, course?.title ?? courseTitle, course?.id, questions as Array<{ idx: number; q: string }>, answers, d.verdicts);

          if (course) {
            course.quiz = { status: "done", score: d.score, comment: d.comment ?? "", at: Date.now() };
            // 测验不过（<60 分）不算学会：打回未学，自动顺延到后面的空位重学；
            // 清掉 doneAt 保打卡诚实（这节不算完成过），quiz 留着上次分数供页面标「上次 X 分」
            if (d.score < 60) {
              const relearnDate = nextFreeDay(s, todayStr());
              course.status = "planned";
              course.doneAt = undefined;
              course.date = relearnDate;
              course.postponedCount = (course.postponedCount ?? 0) + 1;
              course.quiz = { status: "pending", score: d.score, comment: d.comment ?? "", at: Date.now() };
              relearn = relearnDate;
            }
          } else if (parsed.drill === true) {
            // 错题重考销账：题目标了 targetMistake 且判全对 → 该错题 resolved
            for (const q of questions as Array<{ idx: number; targetMistake?: string }>) {
              const v = d.verdicts.find((x) => x.idx === q.idx);
              if (v?.correct === true && q.targetMistake) {
                const m = s.mistakes.find((x) => x.id === q.targetMistake && !x.resolvedAt);
                if (m) m.resolvedAt = Date.now();
              }
            }
          } else if (typeof parsed.forPlanId === "string") {
            const plan = s.plans.find((p) => p.id === parsed.forPlanId);
            if (plan) plan.lastFinal = { score: d.score, comment: d.comment ?? "", at: Date.now() };
          }
          writeSchedule(s);
          json(res, 200, { ok: true, verdict: d, mistakesAdded: added.length, relearn, schedule: s });
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-study",
    configureServer(server) {
      server.middlewares.use("/__rana/study", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/study", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 问卜（玄学）端点——生辰档案本地存 .fate/（已进 .gitignore，不入公开仓库）：
 * - GET  /__rana/fate/profile   读档案库（多档案 {list, active}；无则 {empty:true}；旧单档案 profile.json 自动迁入）
 * - POST /__rana/fate/profile   {action:"save"|"select"|"delete", profile?, id?} —— 多档案增改/切换/删除
 * - POST /__rana/fate/ask       解卦：万年历/八字/紫微/卦象由前端本地算好一并传来，
 *   中间件补上当前选中档案后组装提示词 → 子进程跑 fate-agent.mjs（专用会话 agent:main:fate-teller）
 *   → 返回她的解卦正文（markdown，给用户看的，不走 JSON 契约）。
 * 隐私：每次 ask 会把命盘摘要发到云端模型（用户已知情拍板）；档案本体不出本机。
 */
function ranaFateMiddleware(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fateDir = path.join(here, ".fate");
  const profilesFile = path.join(fateDir, "profiles.json");
  const legacyProfileFile = path.join(fateDir, "profile.json"); // 单档案时代的老文件，首次访问自动迁入
  let agentBusy = false;

  interface FateProfile {
    id?: string;
    nick?: string;
    gender: "男" | "女";
    birthday: string; // YYYY-MM-DD 阳历
    birthTime?: string; // HH:MM，可空（八字少时柱、紫微不可排）
    birthplace?: string;
    savedAt?: number;
  }
  interface FateStore {
    version: 1;
    active: string | null;
    list: Array<FateProfile & { id: string }>;
  }

  const newId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const writeStore = (store: FateStore) => {
    fs.mkdirSync(fateDir, { recursive: true });
    try {
      fs.copyFileSync(profilesFile, profilesFile + ".bak");
    } catch {
      // 首次没有旧文件
    }
    fs.writeFileSync(profilesFile, JSON.stringify(store, null, 2), "utf8");
  };

  /** 读多档案库；没有 profiles.json 但有旧单档案 profile.json 时自动迁移（老文件保留不动） */
  const readStore = (): FateStore | { empty: true } => {
    try {
      const s = JSON.parse(fs.readFileSync(profilesFile, "utf8")) as FateStore;
      if (!s || !Array.isArray(s.list)) return { empty: true };
      s.list = s.list.filter((p) => p && p.id && p.birthday && p.gender);
      if (!s.active || !s.list.some((p) => p.id === s.active)) s.active = s.list[0]?.id ?? null;
      return s;
    } catch {
      // 试旧单档案迁移
    }
    try {
      const old = JSON.parse(fs.readFileSync(legacyProfileFile, "utf8")) as FateProfile;
      if (old && old.birthday && old.gender) {
        const id = newId();
        const store: FateStore = { version: 1, active: id, list: [{ ...old, id }] };
        writeStore(store);
        return store;
      }
    } catch {
      /* 也没有旧档案 */
    }
    return { empty: true };
  };

  const validateProfile = (p: FateProfile) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.birthday)) throw new Error("生日需为 YYYY-MM-DD");
    if (p.gender !== "男" && p.gender !== "女") throw new Error("性别需为 男/女（紫微排盘必需）");
    if (p.birthTime && !/^\d{2}:\d{2}$/.test(p.birthTime)) throw new Error("出生时间需为 HH:MM");
    if (p.nick && p.nick.length > 24) throw new Error("昵称太长");
    if (p.birthplace && p.birthplace.length > 60) throw new Error("出生地太长");
  };

  /** 保存（有 id 更新、无 id 新建）并把此人设为当前选中 */
  const upsertProfile = (p: FateProfile): FateStore => {
    validateProfile(p);
    const cur = readStore();
    const store: FateStore = "empty" in cur ? { version: 1, active: null, list: [] } : cur;
    const entry = { ...p, savedAt: Date.now() };
    const idx = p.id ? store.list.findIndex((x) => x.id === p.id) : -1;
    if (idx >= 0) store.list[idx] = { ...entry, id: store.list[idx].id };
    else {
      const id = newId();
      store.list.push({ ...entry, id });
      store.active = id;
    }
    if (p.id) store.active = p.id;
    writeStore(store);
    return store;
  };

  const selectProfile = (id: string): FateStore => {
    const cur = readStore();
    if ("empty" in cur || !cur.list.some((p) => p.id === id)) throw new Error("没有这份档案");
    cur.active = id;
    writeStore(cur);
    return cur;
  };

  const deleteProfile = (id: string): FateStore => {
    const cur = readStore();
    const store: FateStore = "empty" in cur ? { version: 1, active: null, list: [] } : cur;
    store.list = store.list.filter((p) => p.id !== id);
    if (store.active === id) store.active = store.list[0]?.id ?? null;
    writeStore(store);
    return store;
  };

  const spawnAgent = async (message: string): Promise<{ ok: boolean; reply?: string; error?: string }> => {
    const { stdout } = await execFileP(process.execPath, [path.join(here, "fate-agent.mjs"), "--message", message], {
      encoding: "utf8",
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  };

  const runAgent = async (message: string) => {
    if (agentBusy) throw new Error("她正忙着上一个请求，等一下再试");
    agentBusy = true;
    try {
      return await spawnAgent(message);
    } finally {
      agentBusy = false;
    }
  };

  /** 解卦提示词：档案（服务端补）+ 前端本地算好的命理材料，全喂给她 */
  const askMessage = (payload: {
    domain?: string;
    question?: string;
    hexagram?: Record<string, unknown>;
    almanac?: Record<string, unknown>;
    bazi?: Record<string, unknown>;
    ziwei?: Record<string, unknown>;
  }, profile: FateProfile) => {
    const dom = String(payload.domain ?? "");
    const q = String(payload.question ?? "").trim();
    return [
      "【问卦·页面触发】用户在程序页摇了一卦，请你解卦。",
      `问题域：${dom || "综合"}${q ? `；他自己的问题：「${q}」` : ""}`,
      `他的档案：${[profile.nick ? `昵称${profile.nick}` : "", `性别${profile.gender}`, `阳历生日${profile.birthday}`, profile.birthTime ? `出生时间${profile.birthTime}` : "出生时间未知", profile.birthplace ? `出生地${profile.birthplace}` : ""].filter(Boolean).join("，")}`,
      `八字（前端排好）：${JSON.stringify(payload.bazi ?? {})}`,
      `紫微要点（前端排好）：${JSON.stringify(payload.ziwei ?? {})}`,
      `今日黄历（前端排好）：${JSON.stringify(payload.almanac ?? {})}`,
      `卦象（前端排好，六爻从初爻到上爻）：${JSON.stringify(payload.hexagram ?? {})}`,
      [
        "解卦要求：",
        "1) 结合他的命盘（八字五行、紫微命宫）和卦象（本卦变卦、动爻、卦辞，动爻爻辞凭你掌握的《周易》原文引用）回答他的问题；",
        "2) 保持你平时的说话风格，话少、直接，别迷信吓唬人，也别灌鸡汤；",
        "3) 分三段：卦象说了什么 / 对他这个人的命盘意味着什么 / 落到这件事上一句可执行的建议；",
        "4) 直接输出给用户看的 markdown 正文，不要输出 ```json 契约块。",
      ].join("\n"),
    ].join("\n\n");
  };

  const json = (
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
    code: number,
    out: unknown,
  ) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = code;
    res.end(JSON.stringify(out));
  };
  const isLoopback = (req: { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> }) => {
    const ra = req.socket?.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra)) return false;
    const origin = String(req.headers?.origin ?? "");
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return false;
    return true;
  };
  const readBody = (req: { on: (ev: string, cb: (c?: string) => void) => void }) =>
    new Promise<string>((resolve) => {
      let body = "";
      req.on("data", (c?: string) => {
        body += c ?? "";
      });
      req.on("end", () => resolve(body));
    });

  const handler = (
    req: {
      method?: string;
      url?: string;
      socket?: { remoteAddress?: string };
      headers?: Record<string, unknown>;
      on: (ev: string, cb: (c?: string) => void) => void;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    const route = (new URL(req.url ?? "/", "http://x").pathname || "/").replace(/\/+$/, "") || "/";

    if (req.method === "GET" && route === "/profile") {
      const store = readStore();
      json(res, 200, "empty" in store ? { empty: true } : { list: store.list, active: store.active });
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }

    if (req.method === "POST" && route === "/profile") {
      readBody(req).then((body) => {
        try {
          const { action, profile, id } = JSON.parse(body) as {
            action?: "save" | "select" | "delete";
            profile?: FateProfile;
            id?: string;
          };
          let store: FateStore;
          if (action === "select") {
            if (!id) throw new Error("缺 id");
            store = selectProfile(id);
          } else if (action === "delete") {
            if (!id) throw new Error("缺 id");
            store = deleteProfile(id);
          } else {
            if (!profile) throw new Error("缺 profile");
            store = upsertProfile(profile);
          }
          json(res, 200, { ok: true, list: store.list, active: store.active });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/ask") {
      readBody(req)
        .then(async (body) => {
          const payload = JSON.parse(body || "{}") as Parameters<typeof askMessage>[0];
          const store = readStore();
          if ("empty" in store) {
            json(res, 400, { error: "还没填生辰档案——先在「我的档案」里存一份" });
            return;
          }
          const prof = store.list.find((p) => p.id === store.active) ?? store.list[0];
          const r = await runAgent(askMessage(payload, prof));
          if (!r.ok) {
            json(res, 500, { error: r.error ?? "她没回话" });
            return;
          }
          json(res, 200, { ok: true, reply: r.reply ?? "" });
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-fate",
    configureServer(server) {
      server.middlewares.use("/__rana/fate", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/fate", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 本地模型超参数端点（仅本地 provider 的模型；写入 openclaw.json 后网关文件监听热重载，真实生效）：
 * POST /__rana/model-params {providerId, modelId, params} —— params 只允许白名单数值键，合并进既有 params。
 * 仅本机回环来源可调。
 */
function ranaModelParamsMiddleware(): Plugin {
  const ALLOWED_KEYS = ["temperature", "top_p", "repeat_penalty", "maxTokens"] as const;
  const json = (res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void }, code: number, out: unknown) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = code;
    res.end(JSON.stringify(out));
  };
  const handler = (
    req: { method?: string; socket?: { remoteAddress?: string }; headers?: Record<string, unknown>; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
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
      try {
        const { providerId, modelId, params } = JSON.parse(body) as {
          providerId?: string; modelId?: string; params?: Record<string, unknown>;
        };
        if (!providerId || !modelId || !params || typeof params !== "object") throw new Error("缺 providerId/modelId/params");
        const clean: Record<string, number> = {};
        for (const k of ALLOWED_KEYS) {
          const v = params[k];
          if (v === undefined || v === null) continue;
          if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} 必须是数字`);
          clean[k] = v;
        }
        if (!Object.keys(clean).length) throw new Error("没有可写的参数");
        const cfg = readFullConfig();
        const prov = (cfg.models ?? {}).providers ?? {};
        const model = (prov[providerId]?.models ?? []).find((m) => m.id === modelId);
        if (!model) throw new Error(`模型不存在：${providerId}/${modelId}`);
        fs.copyFileSync(OPENCLAW_CONFIG, OPENCLAW_CONFIG + ".bak-params");
        model.params = { ...(model.params ?? {}), ...clean };
        fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(cfg, null, 2), "utf8");
        json(res, 200, { ok: true, providerId, modelId, params: model.params });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
    });
  };
  return {
    name: "rana-model-params",
    configureServer(server) {
      server.middlewares.use("/__rana/model-params", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/model-params", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 模型连通测试端点：POST /__rana/model-test {modelId} —— 用该模型发一条最小消息（max_tokens 16），
 * 测能不能通、延迟多少。apiKey 只在运行时从 openclaw.json 读，不进日志不进前端。
 * 仅本机回环来源可调。
 */
function ranaModelTestMiddleware(): Plugin {
  const json = (res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void }, code: number, out: unknown) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = code;
    res.end(JSON.stringify(out));
  };
  const testModel = async (modelId: string) => {
    const providerId = modelId.split("/")[0] ?? "";
    const model = modelId.split("/").slice(1).join("/") || modelId;
    const p = readFullConfig().models?.providers?.[providerId];
    if (!p?.baseUrl) throw new Error(`找不到 provider：${providerId || "(空)"}`);
    // apiKey 可能是明文串，也可能已是 SecretRef 对象（{source:"store",id}）——后者去 state SQLite 的 secrets 表里解析
    let apiKey: string | undefined;
    const rawKey = (p as { apiKey?: unknown }).apiKey;
    if (typeof rawKey === "string") apiKey = rawKey;
    else if (rawKey && typeof rawKey === "object" && (rawKey as { source?: string }).source === "store") {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync("K:\\openclaw\\.openclaw\\.openclaw\\state\\openclaw.sqlite", { readOnly: true });
      try {
        const row = db
          .prepare(
            "SELECT value FROM secret_store_entries WHERE name = ? AND kind = 'secret' AND deleted_at_ms IS NULL ORDER BY updated_at_ms DESC LIMIT 1",
          )
          .get(String((rawKey as { id?: string }).id ?? "")) as { value?: string } | undefined;
        apiKey = row?.value;
      } finally {
        db.close();
      }
    }
    const ctrl = new AbortController();
    // 本地大模型冷加载可能要几十秒，手动测试按钮宁可多等
    const timer = setTimeout(() => ctrl.abort(), 45000);
    const t0 = Date.now();
    try {
      const r = await fetch(p.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "连通测试：请只回复两个字：好的" }], max_tokens: 16, stream: false }),
        signal: ctrl.signal,
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        const body = (await r.text()).slice(0, 200);
        throw new Error(`HTTP ${r.status}${body ? "：" + body : ""}`);
      }
      const j = (await r.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = j.choices?.[0]?.message?.content;
      const reply = typeof content === "string" ? content.slice(0, 40) : Array.isArray(content) ? String(content[0]?.text ?? "").slice(0, 40) : "";
      return { ok: true as const, ms, reply };
    } finally {
      clearTimeout(timer);
    }
  };
  const handler = (
    req: { method?: string; socket?: { remoteAddress?: string }; headers?: Record<string, unknown>; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const ra = req.socket?.remoteAddress ?? "";
    const origin = String(req.headers?.origin ?? "");
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra) || (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin))) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }
    let body = "";
    req.on("data", (c?: string) => { body += c ?? ""; });
    req.on("end", () => {
      let modelId = "";
      try {
        modelId = String((JSON.parse(body || "{}") as { modelId?: string }).modelId ?? "");
      } catch { /* 坏 body 按空处理 */ }
      if (!modelId) {
        json(res, 400, { error: "缺 modelId" });
        return;
      }
      testModel(modelId)
        .then((out) => json(res, 200, out))
        .catch((e: Error) => json(res, 200, { ok: false, error: e.message.includes("aborted") ? "45 秒超时（本地模型冷加载也超了？）" : e.message.slice(0, 200) }));
    });
  };
  return {
    name: "rana-model-test",
    configureServer(server) {
      server.middlewares.use("/__rana/model-test", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/model-test", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 智能体装备端点（只读，给右侧面板的技能/MCP 卡用）：
 * GET /__rana/agent-info?agent=main[&refresh=1] → {agent, skills[], mcp[]}
 * - 技能：子进程跑 openclaw CLI `skills list --json`（node 直跑 openclaw.mjs，不走 .cmd shim——
 *   Windows 下 execFile 跑不了 .cmd；env 必须带 OPENCLAW_STATE_DIR），只留 modelVisible 且未停用的，
 *   自装（workspace 来源）排前面。结果按 agent 缓存 120s，refresh=1 强制刷新。
 * - MCP：读 openclaw.json 的 mcp.servers，只回 server id，command/args/env 一律不外传。
 */
function ranaAgentInfoMiddleware(): Plugin {
  const OPENCLAW_MJS = "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\openclaw\\openclaw.mjs";
  const CACHE_MS = 120000;
  const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
  const cache = new Map<string, { at: number; data: unknown }>();

  const listSkills = async (agentId: string) => {
    const { stdout } = await execFileP(
      process.execPath,
      [OPENCLAW_MJS, "skills", "list", "--json", "--agent", agentId],
      {
        encoding: "utf8",
        timeout: 20000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, OPENCLAW_STATE_DIR: "K:\\openclaw\\.openclaw\\.openclaw" },
      },
    );
    const j = JSON.parse(stdout) as {
      skills?: Array<{ name?: string; description?: string; emoji?: string; source?: string; modelVisible?: boolean; disabled?: boolean }>;
    };
    const rows = (j.skills ?? [])
      .filter((s) => s.modelVisible && !s.disabled && s.name)
      .map((s) => ({
        name: String(s.name),
        description: String(s.description ?? "").trim().slice(0, 140),
        emoji: s.emoji ? String(s.emoji) : "",
        source: s.source ? String(s.source) : "",
      }));
    // 自装的（workspace 来源）排前面，其余按名字排
    rows.sort(
      (a, b) =>
        (a.source === "openclaw-workspace" ? 0 : 1) - (b.source === "openclaw-workspace" ? 0 : 1) ||
        a.name.localeCompare(b.name),
    );
    return rows;
  };

  const listMcp = () => {
    const cfg = readFullConfig() as { mcp?: { servers?: Record<string, unknown> } };
    return Object.keys(cfg.mcp?.servers ?? {}).map((id) => ({ id }));
  };

  const handler = (
    req: { method?: string; url?: string },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const u = new URL(req.url ?? "/", "http://x");
    const agentId = (u.searchParams.get("agent") ?? "main").toLowerCase();
    const refresh = u.searchParams.get("refresh") === "1";
    if (!AGENT_RE.test(agentId)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "agent id 格式不对" }));
      return;
    }
    const hit = cache.get(agentId);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) {
      res.end(JSON.stringify(hit.data));
      return;
    }
    listSkills(agentId)
      .then((skills) => {
        const data = { agent: agentId, skills, mcp: listMcp() };
        cache.set(agentId, { at: Date.now(), data });
        res.end(JSON.stringify(data));
      })
      .catch((e: Error) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: `技能清单拿不到：${e.message}` }));
      });
  };

  return {
    name: "rana-agent-info",
    configureServer(server) {
      server.middlewares.use("/__rana/agent-info", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/agent-info", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

function ranaDevConfig(): Plugin {
  return {
    name: "rana-dev-config",
    configureServer(server) {
      server.middlewares.use("/__rana/config", ((
        _req: { headers?: unknown },
        res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
      ) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ gatewayUrl: "ws://127.0.0.1:18789", token: readGatewayToken() }));
      }) as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

export default defineConfig({
  plugins: [react(), ranaDevConfig(), ranaProviderConfigMiddleware(), ranaSysStatusMiddleware(), ranaAvatarMiddleware(), ranaNewsMiddleware(), ranaStudyMiddleware(), ranaFateMiddleware(), ranaAgentInfoMiddleware(), ranaModelTestMiddleware(), ranaModelParamsMiddleware()],
  server: {
    port: 5173,
    proxy: {
      "/gateway": {
        target: "http://127.0.0.1:18789",
        ws: true,
        rewriteWsOrigin: true,
      },
      // LM Studio 本地 REST（127.0.0.1:1234）未开 CORS，
      // 走同源代理供前端面板调用（加载/卸载本地模型）
      "/lmstudio": {
        target: "http://127.0.0.1:1234",
        rewrite: (p) => p.replace(/^\/lmstudio/, ""),
      },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      "/gateway": {
        target: "http://127.0.0.1:18789",
        ws: true,
        rewriteWsOrigin: true,
      },
      "/lmstudio": {
        target: "http://127.0.0.1:1234",
        rewrite: (p) => p.replace(/^\/lmstudio/, ""),
      },
    },
  },
});
