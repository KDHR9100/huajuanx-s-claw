import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSync, sign as cryptoSign, createHash, randomUUID } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore —— ws 无类型声明（仅服务端中间件用）
import WebSocket from "ws";
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client/browser";

const execFileP = promisify(execFile);

// gateway 默认监听 ws://127.0.0.1:18789。
// 前端直连该地址；若浏览器 Origin 被网关拒绝，可改用 /gateway 代理路径
// （见 src/lib/gateway.ts 的回退逻辑与下方 server.proxy 配置）。

// ===== 路径可移植化：环境变量优先，缺省相对仓库根推导（换机器/换目录不用改代码） =====
// 状态目录：OPENCLAW_STATE_DIR 环境变量优先（与启动脚本/边车同一约定），
// 缺省 = 仓库内 .openclaw/.openclaw（已 gitignore，setup.cmd 初始化的就是这里）。
const STATE_HOME = process.env.OPENCLAW_STATE_DIR
  ? path.resolve(process.env.OPENCLAW_STATE_DIR)
  : path.resolve(fileURLToPath(new URL("../.openclaw/.openclaw", import.meta.url)));

const OPENCLAW_CONFIG = path.join(STATE_HOME, "openclaw.json");

/** openclaw CLI 入口（拉运行时模型目录用；与 start-gateway.cmd 同源）：
 *  OPENCLAW_MJS 环境变量 > 常见 npm 全局位置探测 > npm root -g 兜底。 */
function resolveOpenclawMjs(): string {
  if (process.env.OPENCLAW_MJS) return process.env.OPENCLAW_MJS;
  const candidates = [
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "openclaw", "openclaw.mjs"),
    path.join(process.env.USERPROFILE ?? "", ".npm-global", "lib", "node_modules", "openclaw", "openclaw.mjs"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // 尝试下一个候选
    }
  }
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 15000, windowsHide: true, shell: true }).trim();
    const guess = path.join(root, "openclaw", "openclaw.mjs");
    if (fs.existsSync(guess)) return guess;
  } catch {
    // 探测失败：返回首选候选，调用时会给出明确报错
  }
  return candidates[0];
}
const OPENCLAW_MJS = resolveOpenclawMjs();

// 仅开发服务器：为本机前端提供 gateway token。
// 优先读本项目的 gateway 状态目录（STATE_HOME/openclaw.json），
// 再回退到 %USERPROFILE%\.openclaw\openclaw.json。
// 只在 loopback dev server 暴露；生产部署请通过设置面板手动填 token。
function readGatewayToken(): string {
  const candidates = [
    OPENCLAW_CONFIG,
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

interface ModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  params?: Record<string, unknown>;
  [k: string]: unknown;
}
interface ProviderEntry {
  baseUrl?: string;
  /** 明文 key；OpenClaw doctor 会把密钥迁进密钥库，这里会变成 {source,provider,id} 的 SecretRef 引用 */
  apiKey?: string | Record<string, unknown>;
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

function maskKey(key?: string | Record<string, unknown>): string {
  if (!key) return "";
  if (typeof key === "string") return key.slice(0, 5) + "…" + key.slice(-4);
  // SecretRef：密钥本体在 OpenClaw 密钥库里，网页侧只能显示引用 id
  const id = String(key.id ?? "");
  return `🔒密钥库(${id.slice(0, 8)}${id.length > 8 ? "…" : ""})`;
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

  /** 读 rana-web/.env 里的明文 key（可选，文件已 gitignore）：每次现读，改完即生效不用重启 vite。
   *  provider id（如 aliyun-maas）→ .env 键名（ALIYUN_MAAS_API_KEY） */
  const envKeyFor = (providerId: string) => {
    const name = providerId.toUpperCase().replace(/-/g, "_") + "_API_KEY";
    try {
      const text = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".env"), "utf8");
      const m = text.match(new RegExp("^" + name + "=(.+)$", "m"));
      return m ? m[1].trim() : "";
    } catch {
      return "";
    }
  };

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
          // runtime 校验 name 必填：没填就用 id 兜底，否则整个配置会被判 invalid
          name: (m.name && m.name.trim()) || m.id.trim(),
          ...(typeof m.contextWindow === "number" && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
        }));
    }
    providers[id] = next;
    // 首配云端 provider 时把默认模型指过去——开箱用户「填完 key 就能聊」；已有默认模型则不动
    const firstModel = Array.isArray(next.models) && next.models[0]?.id ? `${id}/${next.models[0].id}` : "";
    if (firstModel && !cfg.agents?.defaults?.model?.primary) {
      cfg.agents = cfg.agents ?? {};
      cfg.agents.defaults = cfg.agents.defaults ?? {};
      cfg.agents.defaults.model = { ...cfg.agents.defaults.model, primary: firstModel };
    }
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

  /** 密钥库托管（SecretRef）的 provider：网页拿不到明文，借 OpenClaw 运行时目录拿模型列表 */
  const runtimeCatalog = async (providerId: string) => {
    const runCli = (args: string[]) =>
      execFileP(process.execPath, [OPENCLAW_MJS, ...args], {
        encoding: "utf8",
        timeout: 120000,
        windowsHide: true,
        env: { ...process.env, OPENCLAW_STATE_DIR: STATE_HOME },
      });
    const listIds = async () => {
      const { stdout } = await runCli(["models", "list", "--all", "--provider", providerId, "--json"]);
      const j = JSON.parse(stdout) as { models?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> };
      // 目录行的模型标识在 key 字段（形如 "provider/model"），兼容 id/modelId
      const rows = j.models ?? j.items ?? [];
      return rows
        .map((r) => String(r.key ?? r.id ?? r.modelId ?? ""))
        .map((k) => (k.includes("/") ? k.split("/").slice(1).join("/") : k))
        .filter(Boolean);
    };
    let ids = await listIds();
    if (!ids.length) {
      await runCli(["models", "refresh"]); // 目录还是空的：先从 provider 拉一遍（运行时自己解析密钥）
      ids = await listIds();
    }
    if (!ids.length) throw new Error(`运行时也没拿到 ${providerId} 的模型目录（refresh 可能失败，看网络/密钥）`);
    return { ok: true as const, models: [...new Set(ids)].sort(), source: "runtime" };
  };

  const fetchProviderModels = async (body: string) => {
    const { baseUrl, apiKey, providerId } = JSON.parse(body) as { baseUrl?: string; apiKey?: string; providerId?: string };
    let url = baseUrl;
    let key: string | Record<string, unknown> | undefined = apiKey;
    // 面板会同时传 baseUrl 和 providerId：以 providerId 为准补全缺省（密钥库 key/地址都从配置取）
    if (providerId) {
      const p = readProviders()[providerId];
      url = url || p?.baseUrl;
      key = key || p?.apiKey;
    }
    if (!url || !/^https?:\/\//.test(url)) throw new Error("需要 http(s):// 的 baseUrl");
    // .env 明文 key 优先于密钥库 SecretRef（网页可直连拉全量目录）
    if ((!key || typeof key !== "string") && providerId) {
      const envKey = envKeyFor(providerId);
      if (envKey) key = envKey;
    }
    const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
    if (key && typeof key !== "string") {
      // SecretRef：明文在密钥库里（只写），网页无法直连 provider，走运行时目录
      if (!providerId) throw new Error("缺少 providerId，无法走运行时目录");
      return await runtimeCatalog(providerId);
    }
    if (!key && !local) throw new Error("缺少 API key（填写或选择已保存 key 的 provider）");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(url.replace(/\/+$/, "") + "/models", {
        ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}), // LM Studio 等本机服务免 key
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
    const [sys, gpu, power, virt, services, netSpeed, netProbes] = await Promise.all([
      querySystem(),
      queryGpu().catch(() => null),
      queryPower().catch(() => null),
      queryVirt().catch(() => null),
      queryServices().catch(() => readServiceList().map((s) => ({ ...s, listening: false, pid: 0, proc: null, uptimeSec: null }))),
      queryNetSpeed().catch(() => null),
      queryNetProbes().catch(() => ({ probes: [] })),
    ]);
    return { sys, gpu, power, virt, services, net: { speed: netSpeed, probes: netProbes.probes }, patrol: readPatrol(), ts: Date.now() };
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
 * - POST   /__rana/study/lesson-start    开始今天的课：{context:{history,schedule,materials,mistakes,reports,contract}, model?}
 *                                        勾什么附什么（信息直接写进指令，不让她读文件）；不带历史=一次性干净会话
 * - POST   /__rana/study/quiz-gen         出题：{courseId} | {mistakeIds:错题重考} | {planId, final:期末考}
 * - POST   /__rana/study/quiz-grade       判分；错题自动回收、错题重考自动销账、期末考成绩记到计划
 * - GET    /__rana/study/goals            读待办 goals.json（大方向学习目标，独立文件不与课程表互扰）
 * - POST   /__rana/study/goals            新增待办 {text}
 * - DELETE /__rana/study/goals?id=        删除待办（已排入的课程不受影响）
 * - POST   /__rana/study/goals/parse      大方向拆解（Rana 按 study-goal skill 只出方案，不写文件）
 * - POST   /__rana/study/goals/push       方案确认后写入课程表：生成课程 id、挂默认计划、过期日期自动顺延
 * 服务端还负责：done 课自动排复习课（+1/+7/+16 天）、连续打卡计算、打卡里程碑评语（异步）。
 */
function ranaStudyMiddleware(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const studyDir = path.join(here, ".study");
  const scheduleFile = path.join(studyDir, "schedule.json");
  const goalsFile = path.join(studyDir, "goals.json");
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
  /** 待办页：大方向学习目标。plan 是她拆解出的方案（未确认），push 后课程才进 schedule.json */
  interface GoalPlanCourse {
    title: string;
    date: string;
    timeStart?: string;
    timeEnd?: string;
    estMin?: number;
    note?: string;
  }
  interface StudyGoal {
    id: string;
    text: string;
    createdAt: number;
    status: "open" | "planned";
    plan?: { analysis: string; summary: string; courses: GoalPlanCourse[] } | null;
    pushedCourseIds?: string[];
    pushedAt?: number;
  }
  interface StudyGoalsFile {
    version: number;
    goals: StudyGoal[];
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

  const readGoals = (): StudyGoalsFile => {
    try {
      const g = JSON.parse(fs.readFileSync(goalsFile, "utf8")) as StudyGoalsFile;
      if (!Array.isArray(g.goals)) g.goals = [];
      g.version = 1;
      return g;
    } catch {
      return { version: 1, goals: [], updatedAt: 0 };
    }
  };

  const writeGoals = (g: StudyGoalsFile) => {
    fs.mkdirSync(studyDir, { recursive: true });
    try {
      fs.copyFileSync(goalsFile, goalsFile + ".bak");
    } catch {
      // 首次写入没有旧文件
    }
    g.updatedAt = Date.now();
    fs.writeFileSync(goalsFile, JSON.stringify(g, null, 2), "utf8");
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
    // 写入前校验：materials[].file 一律纯文件名，脏数据就地拒绝（与 materialAbs 同一规则）
    for (const m of s.materials ?? []) {
      if (typeof m.file === "string" && (!m.file || /[\\/]|\.\./.test(m.file))) {
        throw new Error(`资料文件名非法，拒绝写入：${m.file}`);
      }
    }
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

  const materialAbs = (m: StudyMaterial) => {
    // fail-closed：file 字段只允许纯文件名（上传时 safeFilename 的产物）。
    // schedule.json 若被写坏（分隔符/..），宁可炸掉出题请求，也不能把 materialsDir
    // 之外的路径喂给 agent 的 read 工具。
    if (typeof m.file !== "string" || !m.file || /[\\/]|\.\./.test(m.file)) {
      throw new Error(`资料文件名非法：${String(m.file)}`);
    }
    const abs = path.join(materialsDir, m.file);
    // 二次防线（containment）：join 的结果必须仍落在 materialsDir 里面，双保险防穿越
    if (path.relative(materialsDir, abs).startsWith("..")) {
      throw new Error(`资料路径越界：${m.file}`);
    }
    return abs;
  };

  /** 唤醒 Rana：子进程跑 study-agent.mjs，解析它 stdout 的最后一行 JSON；model 可选（页面选的模型）
   *  opts.sessionKey/ephemeral：一次性干净会话模式；opts.tail：先从常驻会话摘最近 N 轮对话当背景 */
  const spawnAgent = async (
    message: string,
    model?: string,
    opts?: { sessionKey?: string; ephemeral?: boolean; tail?: number },
  ): Promise<{ ok: boolean; reply?: string; data?: Record<string, unknown>; error?: string }> => {
    // 请求侧来的 model/sessionKey 要进子进程参数：白名单字符集，拒绝一切路径/注入形状
    if (model && !/^[A-Za-z0-9:./_-]+$/.test(model)) throw new Error(`model 含非法字符`);
    if (opts?.sessionKey && !/^[A-Za-z0-9:_-]+$/.test(opts.sessionKey)) throw new Error(`sessionKey 含非法字符`);
    const args = [path.join(here, "study-agent.mjs"), "--message", message];
    if (model) args.push("--model", model);
    if (opts?.sessionKey) args.push("--session-key", opts.sessionKey);
    if (opts?.ephemeral) args.push("--ephemeral");
    if (opts?.tail) args.push("--tail", String(opts.tail));
    const { stdout } = await execFileP(process.execPath, args, {
      encoding: "utf8",
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  };

  /** 互斥执行也带上会话参数（她一次只干一件事） */
  const runAgent = async (
    message: string,
    model?: string,
    opts?: { sessionKey?: string; ephemeral?: boolean; tail?: number },
  ) => {
    if (agentBusy) throw new Error("她正忙着上一个请求，等一下再试");
    agentBusy = true;
    try {
      return await spawnAgent(message, model, opts);
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

  /** 「开始今天的课」勾选面板的上下文选项（页面传来的，默认值在页面侧） */
  interface LessonCtx {
    history: "none" | "tail5" | "all";
    schedule: boolean;
    materials: boolean;
    mistakes: boolean;
    reports: boolean;
    contract: boolean;
  }
  /** 按勾选项拼一条自给自足的上课指令：勾了什么附什么，并明确告诉她别再读文件 */
  const lessonMessage = (ctx: LessonCtx, s: StudySchedule): string => {
    const t = todayStr();
    const todays = s.courses.filter((c) => c.date === t && c.status === "planned");
    const parts: string[] = [
      `【开始今天的课·页面触发】今天是 ${t}。`,
      `今天待学的课（信息已经附在下面，不要再去读 schedule.json 或资料文件）：`,
      todays.length
        ? todays
            .map((c) => {
              const bits = [`- ${c.timeStart ? `${c.timeStart}${c.timeEnd ? `-${c.timeEnd}` : ""} ` : ""}${c.title}`];
              if (c.estMin) bits.push(`（预计 ${c.estMin} 分钟）`);
              if (c.note) bits.push(`备注：${c.note}`);
              const mats = (c.materialIds ?? []).map((id) => s.materials.find((m) => m.id === id)).filter(Boolean);
              if (mats.length) {
                // 勾了「带资料」才给路径，否则只给名字（她想读也读不到，省上下文）
                bits.push(
                  ctx.materials
                    ? `资料：${mats.map((m) => `${m!.name}（原文可读 ${materialAbs(m!)}）`).join("、")}`
                    : `资料：${mats.map((m) => m!.name).join("、")}`,
                );
              }
              if (c.kind === "review" && c.reviewOf) bits.push("（这是复习课）");
              return bits.join(" ");
            })
            .join("\n")
        : "（今天没有待学的课。如实说一句，别编课。）",
    ];
    if (ctx.schedule) {
      const lines = [...s.courses]
        .sort((a, b) => a.date.localeCompare(b.date) || (a.timeStart ?? "").localeCompare(b.timeStart ?? ""))
        .map((c) => `- ${c.date}${c.timeStart ? ` ${c.timeStart}` : ""} ${c.title}${c.status === "done" ? "（已学完）" : ""}`);
      parts.push(`课程表全貌（供参考）：\n${lines.join("\n")}`);
      parts.push(`连续打卡：${s.streak.days} 天（最好 ${s.streak.best}）`);
    }
    if (ctx.mistakes) {
      const open = s.mistakes.filter((m) => !m.resolvedAt);
      parts.push(
        open.length
          ? `未解决错题（讲课时顺带照顾一下）：\n${open.slice(-20).map((m) => `- ${m.courseTitle}：${m.q.slice(0, 120)}`).join("\n")}`
          : "错题本：没有未解决的错题。",
      );
    }
    if (ctx.reports && s.reports.length) {
      const latest = [...s.reports].sort((a, b) => b.at - a.at)[0];
      parts.push(`最近周报（${latest.title}）：${latest.text.slice(0, 600)}`);
    }
    if (ctx.contract && s.contract?.text) parts.push(`学习契约：${s.contract.text}`);
    parts.push(
      [
        "要求：按你平时的风格开场带这节课（话少、直接），把今天的课讲起来。",
        "这轮不需要改任何文件，也不要调用排课工具。",
      ].join("\n"),
    );
    return parts.join("\n");
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

  /** 给她的现状摘要：未来 14 天课密度 + 逾期/打卡 + 资料库（拆解大方向时"结合他的情况"用） */
  const goalContext = (s: StudySchedule) => {
    const t = todayStr();
    const load: string[] = [];
    for (let i = 0; i < 14; i++) {
      const d = addDays(t, i);
      const n = s.courses.filter((c) => c.date === d && c.status === "planned").length;
      if (n) load.push(`${d}=${n}节`);
    }
    const overdue = s.courses.filter((c) => c.status === "planned" && c.date < t).length;
    return [
      `今天日期：${t}`,
      `未来 14 天已有课：${load.length ? load.join("、") : "全空"}`,
      `逾期未完成：${overdue} 节；连续打卡：${s.streak.days} 天（最佳 ${s.streak.best}）`,
      `进行中的计划：${s.plans.map((p) => p.name).join("、") || "无"}`,
      `资料库（可用 read 工具读的绝对路径）：\n${matLines(s)}`,
    ].join("\n");
  };

  /** 大方向拆解消息：她只出方案不改表，写入由页面确认后走 /goals/push */
  const goalParseMessage = (goal: StudyGoal) =>
    [
      "【待办拆解·页面触发】用户在待办页面写下了一个大方向学习目标，点了「让Rana拆解」。",
      `大方向原文：${goal.text}`,
      `他的现状：\n${goalContext(readSchedule())}`,
      "按 study-goal skill 拆解：结合他的现状把大方向拆成具体课程方案（只出方案，绝不改 schedule.json/goals.json）。",
      '回复的最后必须是一个 ```json 代码块：{"analysis":"两三句话：学什么、为什么这么拆、结合他现状的考虑","summary":"一句话方案","courses":[{"title":"具体课名","date":"YYYY-MM-DD","timeStart":"HH:MM","timeEnd":"HH:MM","estMin":60,"note":"这节课要掌握什么"}]}（timeStart/timeEnd/estMin/note 可选）。失败则 {"ok":false,"summary":"原因"}。',
    ].join("\n\n");

  /** 校验她拆解出的方案：标题+真实日期必须，字段收窄限长 */
  const cleanGoalPlan = (data: Record<string, unknown> | undefined): { analysis: string; summary: string; courses: GoalPlanCourse[] } => {
    if (!data) throw new Error("没解析到方案 JSON");
    const coursesRaw = Array.isArray(data.courses) ? data.courses : [];
    if (!coursesRaw.length) throw new Error(String(data.summary ?? "她说没法拆").slice(0, 200));
    if (coursesRaw.length > 60) throw new Error("一次拆超过 60 节，超出上限");
    const courses = coursesRaw.map((raw, i) => {
      const c = raw as Partial<GoalPlanCourse>;
      const title = String(c?.title ?? "").trim();
      const date = String(c?.date ?? "");
      if (!title || !DATE_RE.test(date)) throw new Error(`第 ${i + 1} 节课缺标题，或日期不是 YYYY-MM-DD`);
      return {
        title: title.slice(0, 120),
        date,
        ...(typeof c?.timeStart === "string" && TIME_RE.test(c.timeStart) ? { timeStart: c.timeStart } : {}),
        ...(typeof c?.timeEnd === "string" && TIME_RE.test(c.timeEnd) ? { timeEnd: c.timeEnd } : {}),
        ...(typeof c?.estMin === "number" && c.estMin > 0 ? { estMin: Math.round(c.estMin) } : {}),
        ...(typeof c?.note === "string" && c.note.trim() ? { note: c.note.trim().slice(0, 300) } : {}),
      };
    });
    return {
      analysis: String(data.analysis ?? "").slice(0, 1000),
      summary: String(data.summary ?? "").slice(0, 200),
      courses,
    };
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
    if (req.method === "GET" && route === "/goals") {
      json(res, 200, readGoals());
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

    // ---- 待办（大方向学习目标）：goals.json 独立存档；parse 走她出方案，push 才写课程表 ----
    if (req.method === "POST" && route === "/goals") {
      readBody(req).then((body) => {
        try {
          const { text } = JSON.parse(body || "{}") as { text?: string };
          const t = String(text ?? "").trim();
          if (!t) throw new Error("写点什么再记");
          if (t.length > 500) throw new Error("大方向 500 字以内就行，细节让她拆的时候聊");
          const g = readGoals();
          if (g.goals.length >= 50) throw new Error("待办太多啦（上限 50），先清清已排的");
          const goal: StudyGoal = {
            id: `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            text: t,
            createdAt: Date.now(),
            status: "open",
            plan: null,
            pushedCourseIds: [],
          };
          g.goals.unshift(goal);
          writeGoals(g);
          json(res, 200, { ok: true, goal, updatedAt: g.updatedAt });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/goals") {
      const id = u.searchParams.get("id") ?? "";
      try {
        const g = readGoals();
        const hit = g.goals.find((x) => x.id === id);
        if (!hit) throw new Error(`待办不存在：${id || "(空id)"}`);
        g.goals = g.goals.filter((x) => x.id !== id);
        writeGoals(g);
        json(res, 200, { ok: true, deleted: id });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return;
    }

    if (req.method === "POST" && route === "/goals/parse") {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as { goalId?: string; model?: string };
          const g = readGoals();
          const goal = g.goals.find((x) => x.id === parsed.goalId);
          if (!goal) {
            json(res, 400, { error: `待办不存在：${parsed.goalId || "(空id)"}` });
            return;
          }
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
          const r = await runAgent(goalParseMessage(goal), model);
          try {
            goal.plan = cleanGoalPlan(r.data);
            goal.status = "open";
            writeGoals(g);
            json(res, 200, { ok: true, goal, updatedAt: g.updatedAt });
          } catch (e) {
            json(res, 500, {
              ok: false,
              error: "她没按契约拆：" + ((e as Error).message || r.error || (r.reply ?? "").slice(0, 200)),
            });
          }
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    if (req.method === "POST" && route === "/goals/push") {
      readBody(req).then((body) => {
        try {
          const { goalId } = JSON.parse(body || "{}") as { goalId?: string };
          const g = readGoals();
          const goal = g.goals.find((x) => x.id === goalId);
          if (!goal) throw new Error(`待办不存在：${goalId || "(空id)"}`);
          if (!goal.plan?.courses.length) throw new Error("这条待办还没有拆解方案，先「让Rana拆解」");
          const s = readSchedule();
          const t = todayStr();
          let shifted = 0;
          const added: StudyCourse[] = goal.plan.courses.map((c) => {
            let date = c.date;
            let note = c.note;
            if (date < t) {
              // 拆完放了几天日期过期了：挪到明天起第一个没课的日子，note 里留痕
              date = nextFreeDay(s, t);
              shifted++;
              note = [note, `（原定 ${c.date}，排入时已过期自动顺延）`].filter(Boolean).join(" ");
            }
            const course: StudyCourse = {
              id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              title: c.title,
              date,
              status: "planned",
              kind: "lesson",
              planId: DEFAULT_PLAN_ID,
              ...(c.timeStart ? { timeStart: c.timeStart } : {}),
              ...(c.timeEnd ? { timeEnd: c.timeEnd } : {}),
              ...(c.estMin && c.estMin > 0 ? { estMin: c.estMin } : {}),
              ...(note ? { note } : {}),
              postponedCount: 0,
              quiz: { status: "none" },
            };
            s.courses.push(course);
            return course;
          });
          writeSchedule(s);
          goal.status = "planned";
          goal.pushedCourseIds = added.map((c) => c.id);
          goal.pushedAt = Date.now();
          writeGoals(g);
          json(res, 200, { ok: true, added: added.length, shifted, goals: g, updatedAt: s.updatedAt });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/lesson-start") {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as { context?: Partial<LessonCtx>; model?: string };
          const c = parsed.context ?? {};
          const ctx: LessonCtx = {
            history: c.history === "none" || c.history === "all" ? c.history : "tail5",
            schedule: c.schedule !== false, // 默认带课表
            materials: c.materials === true, // 默认不带资料路径
            mistakes: c.mistakes === true,
            reports: c.reports === true,
            contract: c.contract === true,
          };
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
          const message = lessonMessage(ctx, readSchedule());
          // 历史选项：none=一次性干净会话（用完即删）；tail5=一次性会话+摘常驻会话最近5轮；all=常驻会话（全量历史）
          const opts =
            ctx.history === "all"
              ? undefined
              : {
                  sessionKey: `agent:main:study-lesson-${Date.now().toString(36)}`,
                  ephemeral: true,
                  ...(ctx.history === "tail5" ? { tail: 5 } : {}),
                };
          const r = await runAgent(message, model, opts);
          json(res, r.ok ? 200 : 500, r.ok ? { ok: true, reply: r.reply ?? "" } : { ok: false, error: r.error ?? "她没回话" });
        })
        .catch((e) => json(res, 400, { error: (e as Error).message }));
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
 * 全局日历端点（数据存本地 .life/events.json，不进公开仓库）：
 * - GET    /__rana/events           读全部事件（按日期+时段排序；课表课程不在这里，前端去 /__rana/study 镜像）
 * - POST   /__rana/events           新增 {title, type, date, timeStart?, timeEnd?, remindMin?, location?, note?}
 * - POST   /__rana/events/done      {id, done} 切换完成
 * - DELETE /__rana/events?id=       删除事件
 * 事件类型：interview 面试 / appointment 约会事务 / activity Live·漫展·出门 / game 游戏活动 / deadline 截止。
 * 课程（course）是 schedule.json 的镜像，由前端当日合并展示，不落本文件（不双写）。
 */
function ranaEventsMiddleware(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const lifeDir = path.join(here, ".life");
  const eventsFile = path.join(lifeDir, "events.json");

  type EventType = "interview" | "appointment" | "activity" | "game" | "deadline";
  interface CalEvent {
    id: string;
    title: string;
    type: EventType;
    date: string; // YYYY-MM-DD
    timeStart?: string; // HH:MM（deadline 可不设时段）
    timeEnd?: string;
    /** 提前多少分钟提醒，默认 30 */
    remindMin?: number;
    location?: string;
    note?: string;
    done?: boolean;
    createdAt: number;
  }
  interface EventsFile {
    version: number;
    events: CalEvent[];
    updatedAt: number;
  }

  const EVENT_TYPES: EventType[] = ["interview", "appointment", "activity", "game", "deadline"];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}$/;

  const emptyEvents = (): EventsFile => ({ version: 1, events: [], updatedAt: 0 });
  const readEvents = (): EventsFile => {
    try {
      const j = JSON.parse(fs.readFileSync(eventsFile, "utf8")) as EventsFile;
      if (!Array.isArray(j.events)) j.events = [];
      j.version = 1;
      return j;
    } catch {
      return emptyEvents();
    }
  };
  const writeEvents = (f: EventsFile) => {
    fs.mkdirSync(lifeDir, { recursive: true });
    try {
      fs.copyFileSync(eventsFile, eventsFile + ".bak");
    } catch {
      // 首次写入没有旧文件
    }
    f.updatedAt = Date.now();
    fs.writeFileSync(eventsFile, JSON.stringify(f, null, 2), "utf8");
  };
  const sortedEvents = (f: EventsFile): EventsFile => ({
    ...f,
    events: [...f.events].sort(
      (a, b) => a.date.localeCompare(b.date) || (a.timeStart ?? "99:99").localeCompare(b.timeStart ?? "99:99"),
    ),
  });

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
      json(res, 200, sortedEvents(readEvents()));
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }

    if (req.method === "POST" && route === "/") {
      readBody(req).then((body) => {
        try {
          const p = JSON.parse(body || "{}") as Record<string, unknown>;
          const title = String(p.title ?? "").trim().slice(0, 80);
          const type = String(p.type ?? "") as EventType;
          const date = String(p.date ?? "").trim();
          if (!title) {
            json(res, 400, { error: "标题不能为空" });
            return;
          }
          if (!EVENT_TYPES.includes(type)) {
            json(res, 400, { error: `type 只能是 ${EVENT_TYPES.join(" / ")}` });
            return;
          }
          if (!DATE_RE.test(date)) {
            json(res, 400, { error: "date 要是 YYYY-MM-DD" });
            return;
          }
          const timeStart = String(p.timeStart ?? "").trim();
          const timeEnd = String(p.timeEnd ?? "").trim();
          if (timeStart && !TIME_RE.test(timeStart)) {
            json(res, 400, { error: "timeStart 要是 HH:MM" });
            return;
          }
          if (timeEnd && !TIME_RE.test(timeEnd)) {
            json(res, 400, { error: "timeEnd 要是 HH:MM" });
            return;
          }
          let remindMin = 30;
          if (p.remindMin !== undefined && p.remindMin !== null && String(p.remindMin) !== "") {
            remindMin = Math.max(0, Math.min(1440, Number(p.remindMin) || 0));
          }
          const f = readEvents();
          const ev: CalEvent = {
            id: `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            title,
            type,
            date,
            ...(timeStart ? { timeStart } : {}),
            ...(timeEnd ? { timeEnd } : {}),
            remindMin,
            ...(String(p.location ?? "").trim() ? { location: String(p.location).trim().slice(0, 200) } : {}),
            ...(String(p.note ?? "").trim() ? { note: String(p.note).trim().slice(0, 500) } : {}),
            done: false,
            createdAt: Date.now(),
          };
          f.events.push(ev);
          writeEvents(f);
          json(res, 200, { ok: true, event: ev, ...sortedEvents(f) });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/done") {
      readBody(req).then((body) => {
        try {
          const p = JSON.parse(body || "{}") as { id?: string; done?: boolean };
          const f = readEvents();
          const ev = f.events.find((x) => x.id === p.id);
          if (!ev) {
            json(res, 404, { error: "没有这个事件" });
            return;
          }
          ev.done = Boolean(p.done);
          writeEvents(f);
          json(res, 200, { ok: true, ...sortedEvents(f) });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/") {
      const id = u.searchParams.get("id") ?? "";
      const f = readEvents();
      if (!f.events.some((x) => x.id === id)) {
        json(res, 404, { error: "没有这个事件" });
        return;
      }
      f.events = f.events.filter((x) => x.id !== id);
      writeEvents(f);
      json(res, 200, { ok: true, ...sortedEvents(f) });
      return;
    }

    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-events",
    configureServer(server) {
      server.middlewares.use("/__rana/events", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/events", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 追番端点（Bangumi api.bgm.tv 代理 + 本地追番清单，数据存 .bangumi/ 不进公开仓库）：
 * - GET    /__rana/bangumi/calendar            今日放送（服务端 curl 经 Clash 抓 api.bgm.tv，60 分钟缓存）
 * - GET    /__rana/bangumi/search?q=           条目搜索（旧版搜索 API，同链路；供「加进追番」前找条目）
 * - GET    /__rana/bangumi/cover?u=            封面图转发（仅白名单 lain.bgm.tv；浏览器直连不到 CDN，服务端代取）
 * - GET    /__rana/bangumi/collection          我的追番清单（.bangumi/collection.json，本地维护不依赖 access token）
 * - POST   /__rana/bangumi/collection          {subjectId, name, nameCn?, cover?, eps?, airDate?, status?} 加入/更新
 *                                            （status: watching 在追标进度 / done 看过进展馆；airDate 供年份分组）
 * - POST   /__rana/bangumi/collection/update   {subjectId, progress?, status?} 改进度/改状态
 * - DELETE /__rana/bangumi/collection?subjectId= 移出追番
 * 这台机器 bgm.tv 直连不通（实测），所有出站走 curl -x http://127.0.0.1:7897（Clash，与状态页探测同款）。
 */
function ranaBangumiMiddleware(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bgmDir = path.join(here, ".bangumi");
  const collectionFile = path.join(bgmDir, "collection.json");
  const PROXY = "http://127.0.0.1:7897";
  const UA = "OpenClaw-RanaWeb/1.0 (personal assistant; contact via OpenClaw gateway)";
  const CALENDAR_TTL_MS = 60 * 60 * 1000;

  interface BgmItem {
    id: number;
    name: string;
    name_cn?: string;
    eps?: number;
    air_date?: string;
    images?: { large?: string; common?: string; medium?: string };
  }
  interface CollectionEntry {
    subjectId: number;
    name: string;
    nameCn?: string;
    cover?: string;
    eps?: number;
    /** 放送开始日（YYYY-MM-DD；展馆按它取年份分组） */
    airDate?: string;
    /** watching=在追（标进度）/ done=看过（进展馆） */
    status: "watching" | "done";
    /** 看到第几话（0=还没开看；仅 watching 用） */
    progress: number;
    addedAt: number;
  }
  interface CollectionFile {
    version: number;
    items: CollectionEntry[];
    updatedAt: number;
  }

  /** curl 抓 bgm.tv（数组参数不经 shell；JSON 解析失败/超时都抛错给路由兜底） */
  const bgmCurlJson = async (urlPath: string) => {
    const { stdout } = await execFileP(
      "curl",
      ["-s", "--max-time", "12", "-x", PROXY, "-A", UA, "https://api.bgm.tv" + urlPath],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    return JSON.parse(stdout) as unknown;
  };

  const emptyCollection = (): CollectionFile => ({ version: 1, items: [], updatedAt: 0 });
  const readCollection = (): CollectionFile => {
    try {
      const j = JSON.parse(fs.readFileSync(collectionFile, "utf8")) as CollectionFile;
      if (!Array.isArray(j.items)) j.items = [];
      // 旧条目补默认值（无 status 的按在追；airDate 缺着由前端归「未分组」）
      for (const it of j.items) {
        if (it.status !== "watching" && it.status !== "done") it.status = "watching";
        if (typeof it.progress !== "number") it.progress = 0;
      }
      j.version = 1;
      return j;
    } catch {
      return emptyCollection();
    }
  };
  const writeCollection = (f: CollectionFile) => {
    fs.mkdirSync(bgmDir, { recursive: true });
    try {
      fs.copyFileSync(collectionFile, collectionFile + ".bak");
    } catch {
      // 首次写入没有旧文件
    }
    f.updatedAt = Date.now();
    fs.writeFileSync(collectionFile, JSON.stringify(f, null, 2), "utf8");
  };
  const sortedCollection = (f: CollectionFile): CollectionFile => ({
    ...f,
    items: [...f.items].sort((a, b) => b.addedAt - a.addedAt),
  });

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

  // 今日放送缓存
  let calCache: { at: number; data: unknown } | null = null;
  const WEEK_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const fetchCalendar = async () => {
    if (calCache && Date.now() - calCache.at < CALENDAR_TTL_MS) return calCache.data;
    const data = (await bgmCurlJson("/calendar")) as Array<{ weekday?: { id?: number }; items?: BgmItem[] }>;
    if (!Array.isArray(data)) throw new Error("bgm.tv /calendar 返回格式不对");
    const todayId = ((new Date().getDay() + 6) % 7) + 1; // bgm weekday.id：1=周一…7=周日
    const today = data.find((d) => d?.weekday?.id === todayId);
    const items = (today?.items ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      nameCn: s.name_cn || "",
      cover: s.images?.large ?? s.images?.common ?? "",
      eps: s.eps ?? 0,
      airDate: s.air_date ?? "",
    }));
    const out = { weekday: WEEK_CN[new Date().getDay()], count: items.length, items };
    calCache = { at: Date.now(), data: out };
    return out;
  };

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

    const fail = (e: unknown) =>
      json(res, 502, {
        error: `bgm.tv 拉取失败：${(e as Error).message}（Clash 代理在 7897，挂了就连不上）`,
      });

    if (req.method === "GET" && route === "/calendar") {
      fetchCalendar()
        .then((d) => json(res, 200, d))
        .catch(fail);
      return;
    }

    if (req.method === "GET" && route === "/search") {
      const q = (u.searchParams.get("q") ?? "").trim();
      if (!q) {
        json(res, 400, { error: "q 不能为空" });
        return;
      }
      bgmCurlJson(`/search/subject/${encodeURIComponent(q)}?type=2&max_results=8`)
        .then((raw) => {
          const list = (raw as { list?: BgmItem[] }).list ?? [];
          json(
            res,
            200,
            list.map((s) => ({
              id: s.id,
              name: s.name,
              nameCn: s.name_cn || "",
              cover: s.images?.large ?? "",
              airDate: s.air_date ?? "",
            })),
          );
        })
        .catch(fail);
      return;
    }

    if (req.method === "GET" && route === "/cover") {
      const raw = u.searchParams.get("u") ?? "";
      // 旧接口给的封面是 http://，出站统一按 https 取（同一 CDN）
      const target = raw.replace(/^http:\/\/lain\.bgm\.tv\//, "https://lain.bgm.tv/");
      if (!/^https:\/\/lain\.bgm\.tv\/pic\//.test(target)) {
        json(res, 403, { error: "只转发 lain.bgm.tv 的图" });
        return;
      }
      execFileP("curl", ["-s", "--max-time", "10", "-x", PROXY, "-A", UA, target], {
        timeout: 13000,
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: 8 * 1024 * 1024,
      })
        .then(({ stdout }) => {
          res.setHeader("content-type", "image/jpeg");
          res.setHeader("cache-control", "public, max-age=86400");
          res.statusCode = 200;
          res.end(stdout);
        })
        .catch(() => {
          res.statusCode = 502;
          res.end("");
        });
      return;
    }

    if (req.method === "GET" && route === "/collection") {
      json(res, 200, sortedCollection(readCollection()));
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }

    if (req.method === "POST" && route === "/collection") {
      readBody(req).then(async (body) => {
        try {
          const p = JSON.parse(body || "{}") as Record<string, unknown>;
          const subjectId = Number(p.subjectId);
          const name = String(p.name ?? "").trim().slice(0, 120);
          if (!Number.isInteger(subjectId) || subjectId <= 0 || !name) {
            json(res, 400, { error: "subjectId 和 name 必填" });
            return;
          }
          const status = p.status === "done" ? "done" : "watching";
          const f = readCollection();
          const exists = f.items.find((x) => x.subjectId === subjectId);
          // 旧搜索接口不给 air_date（展馆按年份分组要它）——缺了就查一次条目详情补上，查不到归「其他」
          let airDate = p.airDate !== undefined ? String(p.airDate).slice(0, 10) : undefined;
          const needAirDate = (exists && !exists.airDate) || (!exists && !airDate);
          if (needAirDate) {
            try {
              const det = (await bgmCurlJson(`/v0/subjects/${subjectId}`)) as { date?: string };
              if (det?.date) airDate = det.date;
            } catch {
              // 详情接口抖动就算了，展示归「其他」
            }
          }
          if (exists) {
            exists.name = name;
            if (p.nameCn !== undefined) exists.nameCn = String(p.nameCn).slice(0, 120);
            if (p.cover !== undefined) exists.cover = String(p.cover).slice(0, 300);
            if (p.eps !== undefined) exists.eps = Math.max(0, Number(p.eps) || 0);
            if (airDate !== undefined) exists.airDate = airDate;
            if (p.status !== undefined) exists.status = status;
          } else {
            f.items.push({
              subjectId,
              name,
              nameCn: p.nameCn !== undefined ? String(p.nameCn).slice(0, 120) : undefined,
              cover: p.cover !== undefined ? String(p.cover).slice(0, 300) : undefined,
              eps: p.eps !== undefined ? Math.max(0, Number(p.eps) || 0) : undefined,
              airDate,
              status,
              progress: 0,
              addedAt: Date.now(),
            });
          }
          writeCollection(f);
          json(res, 200, { ok: true, ...sortedCollection(f) });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/collection/update") {
      readBody(req).then((body) => {
        try {
          const p = JSON.parse(body || "{}") as { subjectId?: number; progress?: number; status?: string };
          const f = readCollection();
          const it = f.items.find((x) => x.subjectId === Number(p.subjectId));
          if (!it) {
            json(res, 404, { error: "追番清单里没有这部" });
            return;
          }
          if (p.progress !== undefined) it.progress = Math.max(0, Math.min(9999, Number(p.progress) || 0));
          if (p.status === "done" || p.status === "watching") it.status = p.status;
          writeCollection(f);
          json(res, 200, { ok: true, ...sortedCollection(f) });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/collection") {
      const subjectId = Number(u.searchParams.get("subjectId"));
      const f = readCollection();
      if (!f.items.some((x) => x.subjectId === subjectId)) {
        json(res, 404, { error: "追番清单里没有这部" });
        return;
      }
      f.items = f.items.filter((x) => x.subjectId !== subjectId);
      writeCollection(f);
      json(res, 200, { ok: true, ...sortedCollection(f) });
      return;
    }

    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-bangumi",
    configureServer(server) {
      server.middlewares.use("/__rana/bangumi", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/bangumi", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 人生规划端点（数据存本地 .life/ 目录，已进 .gitignore 不入公开仓库）：
 * - GET    /__rana/life                    读 life.json（人生目标 + 月度里程碑）
 * - POST   /__rana/life/goals              新建人生目标 {title, why?, horizon?}
 * - DELETE /__rana/life/goals?id=          删除目标（已转出的待办、已排的课不受影响）
 * - POST   /__rana/life/goals/status       {goalId, status} 目标达成/归档/重启
 * - POST   /__rana/life/goals/parse        拆解月度里程碑（Rana 按 life-planning skill 只出方案，校验后写回）
 * - POST   /__rana/life/milestones/todo    里程碑转待办（写 .study/goals.json，带 lifeGoalId/milestoneId，
 *                                          之后照旧走待办页的「让Rana拆解→排进课程表」流程）
 * - POST   /__rana/life/milestones/status  {goalId, milestoneId, status} 里程碑完成/重开
 * - GET    /__rana/life/library            读内容库 library.json
 * - POST   /__rana/life/library/collect    {topic} 联网搜集（Rana 用 web_search 搜真材实料，返回候选不落盘）
 * - POST   /__rana/life/library/feed       {url|text, note?} 投喂：URL 由服务端直抓网页转文本（bocha 只有
 *                                          搜索摘要没整页），交她提炼成草稿（不落盘），页面确认后另存
 * - POST   /__rana/life/library            {entry|entries, addedBy} 页面确认后落盘
 * - DELETE /__rana/life/library?id=        删除条目
 */
function ranaLifeMiddleware(): Plugin {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const lifeDir = path.join(here, ".life");
  const lifeFile = path.join(lifeDir, "life.json");
  const libraryFile = path.join(lifeDir, "library.json");
  const scheduleFile = path.join(here, ".study", "schedule.json");
  const studyGoalsFile = path.join(here, ".study", "goals.json");
  let agentBusy = false;

  interface LifeMilestone {
    id: string;
    month: string; // YYYY-MM
    title: string;
    detail?: string;
    status: "planned" | "done";
    createdAt: number;
    /** 已转成待办（.study/goals.json）时记录，防重复转 */
    todoGoalId?: string;
  }
  interface LifeGoal {
    id: string;
    title: string;
    why?: string;
    horizon?: string;
    status: "active" | "done" | "archived";
    milestones: LifeMilestone[];
    /** 她最近一次拆解的说明（方案本体就是 milestones） */
    analysis?: string;
    summary?: string;
    parsedAt?: number;
    createdAt: number;
    updatedAt?: number;
  }
  interface LifeFile {
    version: 1;
    goals: LifeGoal[];
    updatedAt: number;
  }
  interface LibraryEntry {
    id: string;
    title: string;
    summary: string;
    takeaway?: string;
    source?: string;
    tags?: string[];
    addedBy: "rana" | "owner";
    goalId?: string;
    createdAt: number;
    /** 已消化成学习讲义（存进 .study/materials）时记录，页面标「已成讲义」 */
    digestedAt?: number;
    digestMaterialId?: string;
    digestCourseId?: string;
  }
  interface LibraryFile {
    version: 1;
    entries: LibraryEntry[];
    updatedAt: number;
  }
  /** 待办（.study/goals.json）的形状；ranaStudyMiddleware 读写时未知字段原样保留，lifeGoalId 等能存活 */
  interface TodoGoalLike {
    id: string;
    text: string;
    createdAt: number;
    status: string;
    [k: string]: unknown;
  }

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayStr = () => localDate(new Date());
  const curMonth = () => todayStr().slice(0, 7);
  const addDays = (ds: string, n: number) => {
    const [y, m, d] = ds.split("-").map(Number);
    return localDate(new Date(y, m - 1, d + n));
  };
  const MONTH_RE = /^\d{4}-\d{2}$/;
  const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const readJsonAny = (file: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const writeJsonBak = (file: string, data: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.copyFileSync(file, file + ".bak");
    } catch {
      // 首次写入没有旧文件
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  };

  const readLife = (): LifeFile => {
    const raw = readJsonAny(lifeFile) as LifeFile | null;
    if (!raw || !Array.isArray(raw.goals)) return { version: 1, goals: [], updatedAt: 0 };
    raw.goals = raw.goals.filter((g) => g && g.id && g.title && Array.isArray(g.milestones));
    return raw;
  };

  const readLibrary = (): LibraryFile => {
    const raw = readJsonAny(libraryFile) as LibraryFile | null;
    if (!raw || !Array.isArray(raw.entries)) return { version: 1, entries: [], updatedAt: 0 };
    return raw;
  };

  /** 唤醒 Rana：子进程跑 life-agent.mjs；搜集场景联网搜索链长，waitMs 放宽（中间件超时 = waitMs+15s） */
  const spawnLifeAgent = async (
    message: string,
    model?: string,
    waitMs = 165000,
  ): Promise<{ ok: boolean; reply?: string; data?: Record<string, unknown>; error?: string }> => {
    const args = [path.join(here, "life-agent.mjs"), "--message", message, "--wait-ms", String(waitMs)];
    if (model) args.push("--model", model);
    const { stdout } = await execFileP(process.execPath, args, {
      encoding: "utf8",
      timeout: waitMs + 15000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  };

  const runLifeAgent = async (message: string, model?: string, waitMs?: number) => {
    if (agentBusy) throw new Error("她正忙着上一个请求，等一下再试");
    agentBusy = true;
    try {
      return await spawnLifeAgent(message, model, waitMs);
    } finally {
      agentBusy = false;
    }
  };

  /** 现状摘要：课程表 + 待办（拆解人生目标、搜集资料时"结合他的情况"用） */
  const lifeContext = () => {
    const t = todayStr();
    const lines = [`今天日期：${t}`];
    const s = readJsonAny(scheduleFile) as
      | { courses?: Array<{ date?: string; status?: string }>; streak?: { days?: number; best?: number }; plans?: Array<{ name?: string }> }
      | null;
    if (s && Array.isArray(s.courses)) {
      const planned = s.courses.filter((c) => c.status === "planned" && typeof c.date === "string");
      const load: string[] = [];
      for (let i = 0; i < 30; i++) {
        const d = addDays(t, i);
        const n = planned.filter((c) => c.date === d).length;
        if (n) load.push(`${d}=${n}节`);
      }
      const overdue = planned.filter((c) => (c.date ?? "") < t).length;
      lines.push(`未来 30 天已有课：${load.length ? load.join("、") : "全空"}`);
      lines.push(`逾期未完成：${overdue} 节；连续打卡：${s.streak?.days ?? 0} 天（最佳 ${s.streak?.best ?? 0}）`);
      const plans = (s.plans ?? []).map((p) => p.name).filter(Boolean);
      lines.push(`进行中的学习计划：${plans.join("、") || "无"}`);
    } else {
      lines.push("（课程表还是空的）");
    }
    const g = readJsonAny(studyGoalsFile) as { goals?: Array<{ text?: string; status?: string }> } | null;
    const open = (g?.goals ?? []).filter((x) => x.status === "open" && x.text);
    lines.push(
      open.length
        ? `待办（未拆解的大方向）：${open.length} 条，例如：${open.slice(0, 5).map((x) => `「${(x.text ?? "").slice(0, 30)}」`).join("；")}`
        : "待办：没有未拆解的",
    );
    return lines.join("\n");
  };

  /** 内容库摘要（拆解时引用用） */
  const libraryContext = () => {
    const lib = readLibrary();
    if (!lib.entries.length) return "（内容库还是空的，没有可引用的材料）";
    return lib.entries
      .slice(0, 20)
      .map((e) => `- 《${e.title}》${e.tags?.length ? `（${e.tags.join("/")}）` : ""}：${e.summary.slice(0, 80)}`)
      .join("\n");
  };

  const lifeGoalsContext = () => {
    const act = readLife().goals.filter((g) => g.status === "active");
    if (!act.length) return "（还没建人生目标）";
    return act.map((g) => `- ${g.title}${g.horizon ? `（${g.horizon}）` : ""}`).join("\n");
  };

  const lifeParseMessage = (goal: LifeGoal) =>
    [
      "【人生目标拆解·页面触发】用户在规划页写下了一个人生目标，点了「让Rana拆解」。",
      `目标：${goal.title}`,
      ...(goal.why ? [`为什么想达成：${goal.why}`] : []),
      ...(goal.horizon ? [`时间跨度：${goal.horizon}`] : []),
      `他的现状：\n${lifeContext()}`,
      `规划内容库（别人踩过的坑、真材实料；拆解时相关的要引用，说清用哪条、怎么用）：\n${libraryContext()}`,
      "按 life-planning skill 把目标拆成月度里程碑（只出方案，绝不改任何文件）。里程碑要具体、可检验（拿到什么 / 做完什么 / 达到什么水平），别写「继续努力」这种空话。",
      `回复的最后必须是一个 \`\`\`json 代码块：{"analysis":"两三句话：这条路怎么走、为什么这么拆、结合他现状与内容库的考虑","summary":"一句话总纲","milestones":[{"month":"YYYY-MM","title":"这个月的里程碑","detail":"达成标准与关键动作"}]}。里程碑 3~12 个，month 必须是不早于 ${curMonth()} 的真实未来月份。失败则 {"ok":false,"summary":"原因"}。`,
    ].join("\n\n");

  const collectMessage = (topic: string) => {
    const lib = readLibrary();
    const known = lib.entries.map((e) => e.source).filter((s) => s && /^https?:\/\//i.test(s)) as string[];
    return [
      "【内容库搜集·页面触发】用户在规划页的内容库点了「让Rana去搜集」。",
      `主题：${topic}`,
      `他的人生目标（搜集方向尽量贴着这些来）：\n${lifeGoalsContext()}`,
      known.length
        ? `内容库里已有的网址（这些已经搜集过、记住了，别重复推荐相同出处；同站不同文章可以推）：\n${[...new Set(known)].slice(0, 40).join("\n")}`
        : "（内容库还空着，没有已记录的网址）",
      "按 life-planning skill 的搜集场景：用 web_search 搜 3~5 组关键词（主题 + 方法论 / 经验 / 复盘 / 避坑 等变体），挑 3~6 条真材实料。",
      "要求：有干货、有出处（有名字的人的总结、经典方法论、深度复盘都算）；营销软文、AI 水文、标题党、纯鸡汤不要，宁缺毋滥。**每条的 source 必须是你真实搜到的完整网址（http(s):// 开头），不许省略、不许编**——这是主人的硬要求，网址要留档记住。",
      "**搜完立刻输出结果，别再点开更多搜索。**回复的最后必须是一个 ```json 代码块：{\"candidates\":[{\"title\":\"材料名（人名+方法名优先）\",\"summary\":\"150 字内讲清这份材料到底说了什么\",\"takeaway\":\"对他的规划具体有什么用\",\"source\":\"https://… 完整真实网址\",\"tags\":[\"职业\",\"方法论\"]}]}。没有合适的就 {\"candidates\":[]}。",
    ].join("\n\n");
  };

  const feedMessage = (content: string, source: string, note: string) =>
    [
      "【内容库提炼·页面触发】用户找来一份材料，投喂给规划内容库。",
      `材料来源：${source}`,
      ...(note ? [`用户的备注：${note}`] : []),
      `材料原文（可能截断）：\n${content}`,
      "按 life-planning skill 的提炼场景：把这份材料提炼成一条内容库条目（只出方案，绝不改任何文件）。summary 提干货别复述套话，takeaway 写对他的规划有什么用。",
      '回复的最后必须是一个 ```json 代码块：{"title":"材料名","summary":"200 字内讲清核心干货","takeaway":"对他的规划具体有什么用","tags":["…"]}。失败则 {"ok":false,"summary":"原因"}。',
    ].join("\n\n");

  /** 校验她拆出的月度里程碑：YYYY-MM 且不早于当前月，标题必填限长 */
  const cleanMilestones = (data: Record<string, unknown> | undefined) => {
    if (!data) throw new Error("没解析到方案 JSON");
    const arr = Array.isArray(data.milestones) ? data.milestones : [];
    if (!arr.length) throw new Error(String(data.summary ?? "她说没法拆").slice(0, 200));
    if (arr.length > 24) throw new Error("一次拆超过 24 个月里程碑，超出上限");
    const cm = curMonth();
    const milestones: LifeMilestone[] = arr.map((raw, i) => {
      const m = raw as Partial<LifeMilestone>;
      const month = String(m?.month ?? "");
      const title = String(m?.title ?? "").trim();
      if (!MONTH_RE.test(month) || month < cm) throw new Error(`第 ${i + 1} 个月里程碑的 month 不是 YYYY-MM，或早于当前月（${cm}）`);
      if (!title) throw new Error(`第 ${i + 1} 个月里程碑缺标题`);
      return {
        id: newId("ms"),
        month,
        title: title.slice(0, 80),
        ...(typeof m?.detail === "string" && m.detail.trim() ? { detail: m.detail.trim().slice(0, 300) } : {}),
        status: "planned",
        createdAt: Date.now(),
      };
    });
    milestones.sort((a, b) => a.month.localeCompare(b.month));
    return {
      analysis: String(data.analysis ?? "").slice(0, 1000),
      summary: String(data.summary ?? "").slice(0, 200),
      milestones,
    };
  };

  /** 条目主体校验（搜集候选 / 投喂草稿 / 落盘共用）：标题+总结必填，字段收窄限长 */
  const entryCore = (raw: unknown): Omit<LibraryEntry, "id" | "addedBy" | "goalId" | "createdAt"> => {
    const c = (raw ?? {}) as Partial<LibraryEntry>;
    const title = String(c.title ?? "").trim();
    const summary = String(c.summary ?? "").trim();
    if (!title || !summary) throw new Error("条目缺标题或总结");
    return {
      title: title.slice(0, 120),
      summary: summary.slice(0, 800),
      ...(String(c.takeaway ?? "").trim() ? { takeaway: String(c.takeaway).trim().slice(0, 300) } : {}),
      ...(String(c.source ?? "").trim() ? { source: String(c.source).trim().slice(0, 300) } : {}),
      ...(Array.isArray(c.tags) && c.tags.length
        ? { tags: c.tags.map((t) => String(t).slice(0, 16)).filter(Boolean).slice(0, 6) }
        : {}),
    };
  };

  /** 搜集候选校验（比投喂草稿严）：source 必须是真实 http(s) 网址（主人要求网址留档），没网址的候选拒收 */
  const cleanCandidates = (data: Record<string, unknown> | undefined) => {
    if (!data) throw new Error("没解析到结果 JSON");
    const arr = Array.isArray(data.candidates) ? data.candidates : [];
    if (!arr.length) throw new Error("这次没搜到值得入库的真材实料（宁缺毋滥，换个主题试试）");
    const kept = arr
      .slice(0, 8)
      .map((raw) => entryCore(raw))
      .filter((c) => /^https?:\/\//i.test(c.source ?? ""));
    if (!kept.length) throw new Error("候选全都没带真实网址（http(s)://），不收——换个主题重搜，或手动投喂");
    return kept;
  };

  /** Windows 文件名安全化（与 study 中间件同款规则）：去非法字符与前导点，限长 */
  const safeFilename = (name: string): string => {
    const cut = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").trim().slice(0, 80);
    return cut || "digest";
  };

  /** 从明天起找第一个没有任何课的日期（讲义课的默认落位，与课表页顺延规则一致） */
  const nextFreeDayLife = (courses: Array<{ date?: string }>) => {
    const taken = new Set(courses.map((c) => c.date).filter(Boolean));
    let d = addDays(todayStr(), 1);
    for (let i = 0; i < 400; i++) {
      if (!taken.has(d)) return d;
      d = addDays(d, 1);
    }
    return d;
  };

  /** 讲义生成消息：条目 + （可能的）来源原文 + 他的人生目标与现状 */
  const digestMessage = (entry: LibraryEntry, rawContent: string) =>
    [
      "【讲义生成·页面触发】用户在规划页的内容库点「让她写成讲义」。",
      `材料条目：《${entry.title}》${entry.tags?.length ? `（标签：${entry.tags.join("/")}）` : ""}`,
      `条目摘要：${entry.summary}`,
      ...(entry.takeaway ? [`当初记下的用处：${entry.takeaway}`] : []),
      `他的人生目标：\n${lifeGoalsContext()}`,
      `他的现状：\n${lifeContext()}`,
      rawContent
        ? `材料来源原文（可能截断）：\n${rawContent}`
        : "（没有原文可给——条目只有摘要。用 web_search 补 2~3 组关键词查这份材料的细节和最新进展，别凭空编。）",
      "按 life-planning skill 的讲义场景写成给他学的讲义：总结开头 + 分点干货（有名字、有数字、有反直觉的亮点细节必须原样保留，不许泛化成空话）+ 结合他目标现状的「对你意味着什么」+ 2~3 个自检问题。800~2000 字 markdown。",
      '回复的最后必须是一个 ```json 代码块：{"title":"讲义标题（不带书名号）","digest":"markdown 正文"}。失败则 {"ok":false,"summary":"原因"}。',
    ].join("\n\n");

  /** 校验她写的讲义：标题 + 正文必填，正文要有实质内容 */
  const cleanDigest = (data: Record<string, unknown> | undefined) => {
    if (!data) throw new Error("没解析到讲义 JSON");
    const title = String(data.title ?? "").trim();
    const digest = String(data.digest ?? "").trim();
    const fail = String(data.summary ?? "").slice(0, 200);
    if (!title || digest.length < 200) throw new Error(fail || "讲义缺标题，或正文不足 200 字");
    return { title: title.slice(0, 80), digest: digest.slice(0, 12000) };
  };

  /** 抓取 URL 的安全闸：仅 http/https，host 拒绝 localhost、环回、私网、链路本地等内网地址（防 SSRF 探内网） */
  const assertPublicHttpUrl = (url: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("URL 格式不对");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("URL 需为 http(s)://");
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
      throw new Error("不给抓本机/内网域名");
    }
    if (net.isIP(host)) {
      const bad =
        host === "::1" ||
        host === "0.0.0.0" ||
        host.startsWith("127.") ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        host.startsWith("169.254.") ||
        host.startsWith("fd") || // IPv6 ULA fc00::/7
        host.startsWith("fe80"); // IPv6 链路本地
      if (host.includes(".")) {
        const seg = host.split(".").map(Number);
        if (seg[0] === 172 && seg[1] >= 16 && seg[1] <= 31) throw new Error("不给抓内网地址");
      }
      if (bad) throw new Error("不给抓内网地址");
    }
  };

  /** 服务端直抓网页转正文文本（bocha 只有搜索摘要，整页要自己抓；学 news-report.mjs 的做法） */
  const httpText = async (url: string): Promise<string> => {
    if (!/^https?:\/\//i.test(url)) throw new Error("URL 需以 http(s):// 开头");
    assertPublicHttpUrl(url); // 安全闸：内网/环回一律拒绝
    const r = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) rana-web/1.0",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.6",
      },
    });
    if (!r.ok) throw new Error(`网页返回 HTTP ${r.status}`);
    const raw = (await r.text()).slice(0, 2 * 1024 * 1024);
    // 轻量 HTML→文本：去脚本样式、块级标签换行、实体解码、空白收敛
    let t = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    const named: Record<string, string> = {
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…",
      mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
    };
    t = t
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
        try {
          return String.fromCodePoint(parseInt(h, 16));
        } catch {
          return " ";
        }
      })
      .replace(/&#(\d+);/g, (_, d: string) => {
        try {
          return String.fromCodePoint(Number(d));
        } catch {
          return " ";
        }
      })
      .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
    return t.replace(/[ \t\u00a0]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
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
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string | Buffer) => void },
  ) => {
    const u = new URL(req.url ?? "/", "http://x");
    const route = u.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && route === "/") {
      json(res, 200, readLife());
      return;
    }
    if (req.method === "GET" && route === "/library") {
      json(res, 200, readLibrary());
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }

    // ---- 人生目标 ----
    if (req.method === "POST" && route === "/goals") {
      readBody(req).then((body) => {
        try {
          const { title, why, horizon } = JSON.parse(body || "{}") as { title?: string; why?: string; horizon?: string };
          const t = String(title ?? "").trim();
          if (!t) throw new Error("给目标起个名");
          if (t.length > 120) throw new Error("目标名 120 字以内");
          const life = readLife();
          if (life.goals.filter((g) => g.status === "active").length >= 20) throw new Error("进行中的目标太多啦（上限 20），先完结几个");
          const goal: LifeGoal = {
            id: newId("lg"),
            title: t,
            ...(String(why ?? "").trim() ? { why: String(why).trim().slice(0, 500) } : {}),
            ...(String(horizon ?? "").trim() ? { horizon: String(horizon).trim().slice(0, 40) } : {}),
            status: "active",
            milestones: [],
            createdAt: Date.now(),
          };
          life.goals.unshift(goal);
          writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
          json(res, 200, { ok: true, life });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/goals") {
      const id = u.searchParams.get("id") ?? "";
      try {
        const life = readLife();
        if (!life.goals.some((g) => g.id === id)) throw new Error(`目标不存在：${id || "(空id)"}`);
        life.goals = life.goals.filter((g) => g.id !== id);
        writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
        json(res, 200, { ok: true, deleted: id });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return;
    }

    if (req.method === "POST" && route === "/goals/status") {
      readBody(req).then((body) => {
        try {
          const { goalId, status } = JSON.parse(body || "{}") as { goalId?: string; status?: string };
          const life = readLife();
          const goal = life.goals.find((g) => g.id === goalId);
          if (!goal) throw new Error(`目标不存在：${goalId || "(空id)"}`);
          if (status !== "active" && status !== "done" && status !== "archived") throw new Error("status 需为 active/done/archived");
          goal.status = status;
          goal.updatedAt = Date.now();
          writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
          json(res, 200, { ok: true, life });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/goals/parse") {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as { goalId?: string; model?: string };
          const life = readLife();
          const goal = life.goals.find((g) => g.id === parsed.goalId);
          if (!goal) {
            json(res, 400, { error: `目标不存在：${parsed.goalId || "(空id)"}` });
            return;
          }
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
          const r = await runLifeAgent(lifeParseMessage(goal), model);
          try {
            const plan = cleanMilestones(r.data);
            goal.milestones = plan.milestones;
            goal.analysis = plan.analysis;
            goal.summary = plan.summary;
            goal.parsedAt = Date.now();
            goal.updatedAt = Date.now();
            writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
            json(res, 200, { ok: true, life });
          } catch (e) {
            json(res, 500, {
              ok: false,
              error: "她没按契约拆：" + ((e as Error).message || r.error || (r.reply ?? "").slice(0, 200)),
            });
          }
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    // ---- 里程碑 ----
    if (req.method === "POST" && route === "/milestones/todo") {
      readBody(req).then((body) => {
        try {
          const { goalId, milestoneId } = JSON.parse(body || "{}") as { goalId?: string; milestoneId?: string };
          const life = readLife();
          const goal = life.goals.find((g) => g.id === goalId);
          if (!goal) throw new Error(`目标不存在：${goalId || "(空id)"}`);
          const ms = goal.milestones.find((m) => m.id === milestoneId);
          if (!ms) throw new Error(`里程碑不存在：${milestoneId || "(空id)"}`);
          if (ms.todoGoalId) throw new Error("这条里程碑已经转过待办了");
          // 写 .study/goals.json（形状兼容 ranaStudyMiddleware 的 StudyGoal，多余字段原样保留）
          const gf = (readJsonAny(studyGoalsFile) ?? { version: 1, goals: [], updatedAt: 0 }) as {
            version?: number;
            goals?: TodoGoalLike[];
            updatedAt?: number;
          };
          const goals = Array.isArray(gf.goals) ? gf.goals : [];
          if (goals.length >= 50) throw new Error("待办满了（上限 50），先清清已排的");
          const text = `${ms.title}（${ms.month} 里程碑，人生目标「${goal.title}」${ms.detail ? "：" + ms.detail : ""}）`.slice(0, 480);
          const todo: TodoGoalLike = {
            id: newId("g"),
            text,
            createdAt: Date.now(),
            status: "open",
            plan: null,
            pushedCourseIds: [],
            lifeGoalId: goal.id,
            milestoneId: ms.id,
          };
          goals.unshift(todo);
          writeJsonBak(studyGoalsFile, { version: 1, goals, updatedAt: Date.now() });
          ms.todoGoalId = todo.id;
          goal.updatedAt = Date.now();
          writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
          json(res, 200, { ok: true, todo, life });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/milestones/status") {
      readBody(req).then((body) => {
        try {
          const { goalId, milestoneId, status } = JSON.parse(body || "{}") as { goalId?: string; milestoneId?: string; status?: string };
          const life = readLife();
          const goal = life.goals.find((g) => g.id === goalId);
          if (!goal) throw new Error(`目标不存在：${goalId || "(空id)"}`);
          const ms = goal.milestones.find((m) => m.id === milestoneId);
          if (!ms) throw new Error(`里程碑不存在：${milestoneId || "(空id)"}`);
          if (status !== "done" && status !== "planned") throw new Error("status 需为 done/planned");
          ms.status = status;
          goal.updatedAt = Date.now();
          writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
          json(res, 200, { ok: true, life });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    // ---- 内容库 ----
    if (req.method === "POST" && route === "/library/collect") {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as { topic?: string; model?: string };
          const topic = String(parsed.topic ?? "").trim();
          if (!topic || topic.length < 2) throw new Error("想让她搜集什么主题？写两个字以上");
          if (topic.length > 80) throw new Error("主题 80 字以内");
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
          // 联网搜索链长：等 285s（中间件超时 300s）
          const r = await runLifeAgent(collectMessage(topic), model, 285000);
          try {
            const candidates = cleanCandidates(r.data);
            // 网址记忆：库里已有的出处打标，页面默认不勾（同站不同文章仍可收）
            const known = new Set(
              readLibrary().entries.map((e) => (e.source ?? "").replace(/\/+$/, "")).filter(Boolean),
            );
            const marked = candidates.map((c) => ({
              ...c,
              alreadyIn: Boolean(c.source && known.has(c.source.replace(/\/+$/, ""))),
            }));
            json(res, 200, { ok: true, candidates: marked });
          } catch (e) {
            json(res, 500, {
              ok: false,
              error: "她没按契约交货：" + ((e as Error).message || r.error || (r.reply ?? "").slice(0, 200)),
            });
          }
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    if (req.method === "POST" && route === "/library/feed") {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as { url?: string; text?: string; note?: string; model?: string };
          const url = String(parsed.url ?? "").trim();
          const rawText = String(parsed.text ?? "").trim();
          const note = String(parsed.note ?? "").trim().slice(0, 200);
          if (!url && !rawText) throw new Error("投喂点内容：贴 URL 或直接粘原文");
          let content = rawText;
          let source = "用户投喂的文字材料";
          if (url) {
            content = await httpText(url);
            source = url;
          }
          if (content.length < 40) throw new Error("内容太短了（URL 可能是动态页抓不到正文，试试直接粘文字）");
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
          const r = await runLifeAgent(feedMessage(content.slice(0, 12000), source, note), model);
          try {
            const draft = entryCore(r.data);
            json(res, 200, { ok: true, draft: { ...draft, ...(draft.source ? {} : { source }) } });
          } catch (e) {
            json(res, 500, {
              ok: false,
              error: "她没按契约提炼：" + ((e as Error).message || r.error || (r.reply ?? "").slice(0, 200)),
            });
          }
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    if (req.method === "POST" && route === "/library/digest") {
      readBody(req)
        .then(async (body) => {
          try {
            const parsed = JSON.parse(body || "{}") as { entryId?: string; model?: string };
            const lib = readLibrary();
            const entry = lib.entries.find((e) => e.id === parsed.entryId);
            if (!entry) throw new Error(`条目不存在：${parsed.entryId || "(空id)"}`);
            // 有 http(s) 来源就服务端直抓原文（抓不到就让她自己 web_search 补料）
            let raw = "";
            if (entry.source && /^https?:\/\//i.test(entry.source)) {
              try {
                raw = await httpText(entry.source);
              } catch {
                // 原文抓不到：靠她联网补
              }
            }
            const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
            // 讲义要联网补料，链长放宽（同搜集：等 285s）
            const r = await runLifeAgent(digestMessage(entry, raw.slice(0, 12000)), model, 285000);
            try {
              const d = cleanDigest(r.data);
              json(res, 200, { ok: true, ...d });
            } catch (e) {
              json(res, 500, {
                ok: false,
                error: "她没按契约写讲义：" + ((e as Error).message || r.error || (r.reply ?? "").slice(0, 200)),
              });
            }
          } catch (e) {
            json(res, 400, { error: (e as Error).message });
          }
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    if (req.method === "POST" && route === "/library/digest/save") {
      readBody(req).then((body) => {
        try {
          const parsed = JSON.parse(body || "{}") as {
            entryId?: string;
            title?: string;
            digest?: string;
            schedule?: boolean;
          };
          const lib = readLibrary();
          const entry = lib.entries.find((e) => e.id === parsed.entryId);
          const d = cleanDigest({ title: parsed.title, digest: parsed.digest });
          // 1) 讲义存成学习资料（.study/materials，形状与上传资料一致，课表页资料库直接可见）
          const mid = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const name = `${safeFilename(d.title)}.md`;
          const fileName = `${mid}-${name}`;
          const materialsDir = path.join(here, ".study", "materials");
          fs.mkdirSync(materialsDir, { recursive: true });
          const content = [
            `# ${d.title}`,
            "",
            `> 来源：内容库《${entry?.title ?? d.title}》${entry?.source ? ` · ${entry.source}` : ""} · ${todayStr()} 她消化成讲义`,
            "",
            d.digest,
            "",
          ].join("\n");
          fs.writeFileSync(path.join(materialsDir, fileName), content, "utf8");
          // 2) 登记 schedule.json：资料必挂；默认再排一节「读讲义」的课（明天起第一个空白天）
          const s = (readJsonAny(scheduleFile) ?? {}) as Record<string, unknown> & {
            materials?: Array<Record<string, unknown>>;
            courses?: Array<Record<string, unknown>>;
          };
          if (!Array.isArray(s.materials)) s.materials = [];
          if (!Array.isArray(s.courses)) s.courses = [];
          s.materials.push({ id: mid, name, file: fileName, size: Buffer.byteLength(content, "utf8"), addedAt: Date.now() });
          let courseId: string | null = null;
          if (parsed.schedule !== false) {
            courseId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            s.courses.push({
              id: courseId,
              title: `读讲义：${d.title}`.slice(0, 120),
              date: nextFreeDayLife(s.courses as Array<{ date?: string }>),
              status: "planned",
              kind: "lesson",
              planId: "p-default",
              estMin: 40,
              materialIds: [mid],
              note: `内容库《${entry?.title ?? d.title}》消化成的讲义`,
              postponedCount: 0,
              quiz: { status: "none" },
            });
          }
          s.updatedAt = Date.now();
          writeJsonBak(scheduleFile, s);
          // 3) 条目标记已消化（内容库一眼看清哪些还没学）
          if (entry) {
            entry.digestedAt = Date.now();
            entry.digestMaterialId = mid;
            if (courseId) entry.digestCourseId = courseId;
            writeJsonBak(libraryFile, { ...lib, updatedAt: Date.now() });
          }
          json(res, 200, { ok: true, materialId: mid, courseId, materialName: name, library: readLibrary() });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/library") {
      readBody(req).then((body) => {
        try {
          const parsed = JSON.parse(body || "{}") as {
            entry?: unknown;
            entries?: unknown[];
            addedBy?: string;
            goalId?: string;
          };
          const by: "rana" | "owner" = parsed.addedBy === "rana" ? "rana" : "owner";
          const incoming = Array.isArray(parsed.entries) ? parsed.entries : parsed.entry ? [parsed.entry] : [];
          if (!incoming.length) throw new Error("没有要存的条目");
          if (incoming.length > 8) throw new Error("一次最多入库 8 条");
          const lib = readLibrary();
          if (lib.entries.length >= 500) throw new Error("内容库满了（上限 500），清清旧的");
          const life = readLife();
          let goalId = "";
          if (parsed.goalId) {
            if (!life.goals.some((g) => g.id === parsed.goalId)) throw new Error("goalId 不存在");
            goalId = parsed.goalId;
          }
          for (const raw of incoming) {
            const core = entryCore(raw);
            lib.entries.unshift({
              id: newId("kb"),
              ...core,
              addedBy: by,
              ...(goalId ? { goalId } : {}),
              createdAt: Date.now(),
            });
          }
          writeJsonBak(libraryFile, { ...lib, updatedAt: Date.now() });
          json(res, 200, { ok: true, library: lib });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/library") {
      const id = u.searchParams.get("id") ?? "";
      try {
        const lib = readLibrary();
        if (!lib.entries.some((e) => e.id === id)) throw new Error(`条目不存在：${id || "(空id)"}`);
        lib.entries = lib.entries.filter((e) => e.id !== id);
        writeJsonBak(libraryFile, { ...lib, updatedAt: Date.now() });
        json(res, 200, { ok: true, deleted: id });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return;
    }

    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-life",
    configureServer(server) {
      server.middlewares.use("/__rana/life", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/life", handler as Parameters<typeof server.middlewares.use>[1]);
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

  /** 解卦提示词：档案（服务端补，可能没有）+ 前端按勾选带来的材料；没勾的整段省略 */
  const askMessage = (
    payload: {
      domain?: string;
      question?: string;
      hexagram?: Record<string, unknown> | null;
      almanac?: Record<string, unknown>;
      bazi?: Record<string, unknown> | null;
      ziwei?: Record<string, unknown> | null;
    },
    profile: FateProfile | null,
  ) => {
    const dom = String(payload.domain ?? "");
    const q = String(payload.question ?? "").trim();
    const parts: string[] = [
      payload.hexagram ? "【问卦·页面触发】用户摇了一卦，请你解卦。" : "【命理咨询·页面触发】用户想问你命理问题。",
      `问题域：${dom || "综合"}${q ? `；他自己的问题：「${q}」` : ""}`,
    ];
    if (profile) {
      parts.push(
        `他的档案：${[
          profile.nick ? `昵称${profile.nick}` : "",
          `性别${profile.gender}`,
          `阳历生日${profile.birthday}`,
          profile.birthTime ? `出生时间${profile.birthTime}` : "出生时间未知",
          profile.birthplace ? `出生地${profile.birthplace}` : "",
        ]
          .filter(Boolean)
          .join("，")}`,
      );
    }
    if (payload.bazi) parts.push(`八字（前端排好）：${JSON.stringify(payload.bazi)}`);
    if (payload.ziwei) parts.push(`紫微要点（前端排好，含当前大限/流年）：${JSON.stringify(payload.ziwei)}`);
    if (payload.almanac) parts.push(`今日黄历（前端排好）：${JSON.stringify(payload.almanac)}`);
    if (payload.hexagram) parts.push(`卦象（前端排好，六爻从初爻到上爻）：${JSON.stringify(payload.hexagram)}`);
    parts.push(
      [
        "回答要求：",
        "1) 材料有什么用什么：结合命盘（八字五行、紫微命宫大限流年）和/或卦象（本卦变卦、动爻、卦辞，动爻爻辞凭你掌握的《周易》原文引用）回答他的问题；没给的材料别硬编；",
        "2) 保持你平时的说话风格，话少、直接，别迷信吓唬人，也别灌鸡汤；",
        payload.hexagram
          ? "3) 分三段：卦象说了什么 / 对他这个人的命盘意味着什么 / 落到这件事上一句可执行的建议；"
          : "3) 分两段：命盘怎么说 / 落到这件事上一句可执行的建议；",
        "4) 直接输出给用户看的 markdown 正文，不要输出 ```json 契约块。",
      ].join("\n"),
    );
    return parts.join("\n\n");
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
          const prof = "empty" in store ? null : store.list.find((p) => p.id === store.active) ?? store.list[0];
          // 没档案也放行——只问卦象（不排命盘）是合法用法；但带了八字/紫微就必须有档案
          if (!prof && (payload.bazi || payload.ziwei)) {
            json(res, 400, { error: "还没填生辰档案——先在「我的档案」里存一份" });
            return;
          }
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
  const testOne = async (providerId: string, model: string) => {
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
    // 思考型模型要把 512 token 推理跑完、本地大模型冷加载也要几十秒，手动测试按钮宁可多等
    const TEST_TIMEOUT_MS = 75_000;
    const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const r = await fetch(p.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "连通测试：请只回复两个字：好的" }], max_tokens: 512, stream: false }),
        signal: ctrl.signal,
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        const body = (await r.text()).slice(0, 200);
        // 429/403 多是额度问题，key 其实有效——翻译成人话，避免误判成「key 被藏坏了」
        const hint =
          r.status === 429 ? "额度用完/限流（key 有效，等重置或充值）"
          : r.status === 401 ? "key 无效或没权限"
          : r.status === 403 && body.includes("Free quota") ? "免费额度用完（key 有效，充值或关「仅免费」模式）"
          : r.status === 403 ? "没权限（key 受限或免费额度用完）"
          : "";
        throw new Error(`${hint ? hint + " ｜ " : ""}HTTP ${r.status}${body ? "：" + body : ""}`);
      }
      const j = (await r.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = j.choices?.[0]?.message?.content;
      const reply = typeof content === "string" ? content.slice(0, 40) : Array.isArray(content) ? String(content[0]?.text ?? "").slice(0, 40) : "";
      // 思考型模型可能把 512 也花光在推理上：链路是通的，回复为空要说明白
      return { ok: true as const, ms, reply, ...(reply ? {} : { note: "链路通；回复为空——思考型模型把输出额度花在推理上了" }) };
    } finally {
      clearTimeout(timer);
    }
  };

  // 前端下拉发的是「裸模型名 + providerId」（gateway 目录的 id 不带 provider 前缀）；也兼容手写完整 provider/model。
  // 裸名在多家接口都有（如 qwen3.8-max 三家都配了）且没带 providerId 时，挨个试，谁先通算谁。
  const testModel = async (modelId: string, providerHint?: string) => {
    const provs = readFullConfig().models?.providers ?? {};
    let candidates: Array<{ providerId: string; model: string }>;
    if (modelId.includes("/")) {
      candidates = [{ providerId: modelId.split("/")[0] ?? "", model: modelId.split("/").slice(1).join("/") || modelId }];
    } else if (providerHint && provs[providerHint]) {
      candidates = [{ providerId: providerHint, model: modelId }];
    } else {
      candidates = Object.entries(provs)
        .filter(([, p]) => (p.models ?? []).some((mm) => mm.id === modelId))
        .map(([providerId]) => ({ providerId, model: modelId }));
    }
    if (!candidates.length) throw new Error(`找不到模型：${modelId}（没有任何接口配置过它）`);
    const errs: string[] = [];
    for (const c of candidates) {
      try {
        return { ...(await testOne(c.providerId, c.model)), providerId: c.providerId };
      } catch (e) {
        errs.push(`${c.providerId || "(?)"}：${(e as Error).message.slice(0, 120)}`);
      }
    }
    throw new Error(errs.join(" ｜ ").slice(0, 300));
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
      let providerId = "";
      try {
        const b = JSON.parse(body || "{}") as { modelId?: string; providerId?: string };
        modelId = String(b.modelId ?? "");
        providerId = String(b.providerId ?? "");
      } catch { /* 坏 body 按空处理 */ }
      if (!modelId) {
        json(res, 400, { error: "缺 modelId" });
        return;
      }
      testModel(modelId, providerId || undefined)
        .then((out) => json(res, 200, out))
        .catch((e: Error) => json(res, 200, { ok: false, error: e.message.includes("aborted") ? "75 秒超时（本地冷加载或思考型慢生成都算）" : e.message.slice(0, 200) }));
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
        env: { ...process.env, OPENCLAW_STATE_DIR: STATE_HOME },
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

/**
 * 群画像端点（纯只读展示）：GET /__rana/qq-profile
 * 读公共号工作区 memory/ 下的群画像/群友画像/周报 md + 群别名表（shared-memory/qq-bridge.json）。
 * 画像文件由 rana-qq-public 自己写（group-analyst skill），这里零写入；总结模型的切换走网关 WS RPC cron.update，不经过这里。
 */
function ranaQqProfileMiddleware(): Plugin {
  const HOME = "K:/openclaw/.openclaw/.openclaw";
  const memDir = `${HOME}/workspace-rana-qq-public/memory`;
  const aliasFile = `${HOME}/shared-memory/qq-bridge.json`;

  const json = (res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void }, code: number, out: unknown) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = code;
    res.end(JSON.stringify(out));
  };

  const aliases = (): Record<string, string> => {
    try {
      return (JSON.parse(fs.readFileSync(aliasFile, "utf8")) as { groups?: Record<string, string> }).groups ?? {};
    } catch {
      return {};
    }
  };

  interface MdFile {
    key: string;
    title: string;
    updated: string;
    names?: string;
    mtime: number;
    md: string;
  }
  const listMd = (prefix: string): MdFile[] => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(memDir).filter((f) => f.startsWith(prefix) && f.endsWith(".md"));
    } catch {
      return [];
    }
    return files
      .map((f) => {
        const md = fs.readFileSync(path.join(memDir, f), "utf8");
        const key = f.slice(prefix.length, -3);
        return {
          key,
          title: (md.match(/^#\s+(.+)$/m) ?? [])[1] ?? key,
          updated: (md.match(/^已整理至:\s*(.+)$/m) ?? [])[1] ?? "",
          names: (md.match(/^名片名:\s*(.+)$/m) ?? [])[1],
          mtime: fs.statSync(path.join(memDir, f)).mtimeMs,
          md,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  };

  const handler = (
    req: { method?: string; url?: string },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    const u = new URL(req.url ?? "/", "http://x");
    const route = u.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && route === "/") {
      const al = aliases();
      json(res, 200, {
        groups: listMd("group-").map((g) => ({ ...g, alias: al[g.key] ?? "" })),
        members: listMd("member-"),
        reports: listMd("report-"),
        generatedAt: Date.now(),
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-qq-profile",
    configureServer(server) {
      server.middlewares.use("/__rana/qq-profile", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/qq-profile", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * DSH 模型清单端点（纯只读）：GET /__rana/dsh-models
 * 读 WSL 里 DSH 的 settings.yaml（deepseek/百炼路线 + 自定义 pi-ai 路线），供派活页下拉。
 * 路径与派活页个人预设都放在 gitignored 的 local-config.json（模板 local-config.example.json）；
 * 文件缺失/未配置时返回空清单与空预设，前端退回内置默认与自由填写。改配置需重启 vite。
 */
function ranaDshModelsMiddleware(): Plugin {
  // 本机个人路径（含 WSL 用户名）不入公开仓库：启动时从 local-config.json 读一次
  let dshSettingsPath = "";
  let dshPresets: Array<{ name: string; cwd: string }> = [];
  try {
    const local = JSON.parse(
      fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "local-config.json"), "utf8"),
    ) as { dshSettingsPath?: string; dshPresets?: Array<{ name: string; cwd: string }> };
    if (typeof local.dshSettingsPath === "string") dshSettingsPath = local.dshSettingsPath;
    if (Array.isArray(local.dshPresets)) dshPresets = local.dshPresets;
  } catch {
    // 没配 local-config.json：模型清单走空、预设由前端内置默认兜底
  }

  const parseModels = (): Array<{ provider: string; full: string; name?: string }> => {
    let raw = "";
    if (!dshSettingsPath) return [];
    try {
      raw = fs.readFileSync(dshSettingsPath, "utf8");
    } catch {
      return [];
    }
    const out: Array<{ provider: string; full: string; name?: string }> = [];
    const lines = raw.split("\n");
    let current = "";
    const bodyBySection = new Map<string, string[]>();
    for (const ln of lines) {
      const top = ln.match(/^(\S+):\s*$/);
      if (top) {
        current = top[1];
        if (!bodyBySection.has(current)) bodyBySection.set(current, []);
        continue;
      }
      if (current && (ln.startsWith("  ") || ln.trim() === "")) bodyBySection.get(current)!.push(ln);
    }
    for (const [name, body] of bodyBySection) {      if (name === "llm-deepseek") {
        for (const ln of body) {
          const id = ln.match(/^\s{4}- id:\s*(\S+)/);
          if (id) out.push({ provider: "deepseek-official", full: `deepseek-official/${id[1]}`, name: undefined });
          const nm = ln.match(/^\s+name:\s*(.+)/);
          if (nm && out.length) out[out.length - 1].name = nm[1].trim();
        }
      } else if (name === "llm-pi-ai") {
        // providers: <key>: 下缩进的 models 列表
        let prov = "";
        for (const ln of body) {
          const pk = ln.match(/^\s{4}(\S+):\s*$/);
          if (pk) {
            prov = pk[1];
            continue;
          }
          const id = ln.match(/^\s{8}- id:\s*(\S+)/);
          if (id && prov) out.push({ provider: prov, full: `${prov}/${id[1]}`, name: undefined });
          const nm = ln.match(/^\s{10}name:\s*(.+)/);
          if (nm && out.length) out[out.length - 1].name = nm[1].trim();
        }
      }
    }
    return out;
  };

  const handler = (
    req: { method?: string; url?: string },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method === "GET") {
      const models = parseModels();
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ models, presets: dshPresets, updatedAt: Date.now() }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "method not allowed" }));
  };

  return {
    name: "rana-dsh-models",
    configureServer(server) {
      server.middlewares.use("/__rana/dsh-models", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/dsh-models", handler as Parameters<typeof server.middlewares.use>[1]);
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

/**
 * agents 清单端点：GET /__rana/agents → { agents: [{id, name}] }
 * 读 openclaw.json 的 agents.entries——前端按「配置里实际存在的智能体」决定显隐
 * （例：发行版单 Rana 时侧栏不出现 RP 入口；本机多智能体时照常显示）。
 * 只回 id/name，其余字段（模型、workspace 路径等）不外传。
 */
function ranaAgentsMiddleware(): Plugin {
  const handler = (
    _req: unknown,
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    res.setHeader("content-type", "application/json");
    try {
      const cfg = readFullConfig() as { agents?: { entries?: Record<string, { name?: string }> } };
      const agents = Object.entries(cfg.agents?.entries ?? {}).map(([id, e]) => ({ id, name: String(e.name ?? id) }));
      res.end(JSON.stringify({ agents }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  };
  return {
    name: "rana-agents",
    configureServer(server) {
      server.middlewares.use("/__rana/agents", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/agents", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 系统会话清理端点：GET /__rana/sessions-cleanup 读进度，POST 启动 cron-session-cleanup.mjs。
 * 手术全在脚本里做（停网关→备份→清 placement 残留→重启→CLI 删 cron 父会话），中间件只负责拉起与查询；
 * 进度落盘 %TEMP%\openclaw\cron-session-cleanup.json（脚本每步更新 + 10s 保活，
 * updatedAt 超过 2 分钟视为陈旧锁，允许发起新任务）。脚本 detach 启动，vite 重启不影响手术进行。
 */
function ranaSessionsCleanupMiddleware(): Plugin {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "cron-session-cleanup.mjs");
  const statusFile = path.join(os.tmpdir(), "openclaw", "cron-session-cleanup.json");
  const STALE_MS = 2 * 60 * 1000;

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
  const readStatus = (): Record<string, unknown> => {
    try {
      const raw = JSON.parse(fs.readFileSync(statusFile, "utf8")) as Record<string, unknown>;
      if (raw && typeof raw === "object") return { exists: true, ...raw };
    } catch {
      // 没跑过或读失败：按不存在处理
    }
    return { exists: false };
  };

  const handler = (
    req: { method?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string }; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method === "GET") {
      json(res, 200, readStatus());
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }
    if (req.method === "POST") {
      const chunks: string[] = [];
      req.on("data", (c?: string) => chunks.push(c ?? ""));
      req.on("end", () => {
        let dryRun = false;
        try {
          dryRun = Boolean((JSON.parse(chunks.join("") || "{}") as { dryRun?: boolean }).dryRun);
        } catch {
          // 空 Body 当正式清理
        }
        const st = readStatus();
        const fresh = typeof st.updatedAt === "number" && Date.now() - st.updatedAt < STALE_MS;
        if (st.exists && st.running === true && fresh) {
          json(res, 409, { error: "已有清理任务在进行中" });
          return;
        }
        const child = spawn(
          process.execPath,
          dryRun ? [script, "--dry-run"] : [script],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.unref();
        json(res, 200, { started: true, dryRun });
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-sessions-cleanup",
    configureServer(server) {
      server.middlewares.use("/__rana/sessions-cleanup", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/sessions-cleanup", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/**
 * 上下文体检端点：GET /__rana/context（仅本机）
 * 服务端直连 gateway（operator 设备签名），开一次性 main 会话执行 /context list 拿官方账单
 * （底稿注入 / 技能清单 / 工具 schema），补读主会话才注入的 USER/MEMORY/当日日记体积，
 * 再带主会话实时单轮输入。临时会话跑完即删，不进聊天流、不烧模型 token。
 * 每次点击都新建+删除一个临时会话，所以留给按钮手动触发，不做轮询。
 */
function ranaContextMiddleware(): Plugin {
  const handler = async (
    req: { method?: string; url?: string; socket?: { remoteAddress?: string } },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const ra = req.socket?.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "仅本机可查询" }));
      return;
    }
    const token = readGatewayToken();
    if (!token) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "拿不到 gateway token（openclaw.json）" }));
      return;
    }
    // ?sessionKey= 指定要体检的会话（账单按该会话所属 agent 装配计算）；缺省测 main 主会话
    const u = new URL(req.url ?? "/", "http://localhost");
    const sessionKey = u.searchParams.get("sessionKey") ?? "";
    try {
      const report = await probeGatewayContext(token, sessionKey || undefined);
      res.end(JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), ...report }));
    } catch (e) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  };
  return {
    name: "rana-context",
    configureServer(server) {
      server.middlewares.use("/__rana/context", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/context", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

/** 解析 /context list 输出（run 或 estimate 口径都认）：正文数字带千分位逗号 */
const parseContextReport = (text: string) => {
  const num = (s: string) => Number(s.replace(/,/g, ""));
  const sysM = text.match(/System prompt \((?:run|estimate)\): ([\d,]+) chars \(~([\d,]+) tok\)(?: \(Project Context [\d,]+ chars \(~([\d,]+) tok\)\))?/);
  const skillsM = text.match(/Skills list \(system prompt text\): ([\d,]+) chars \(~([\d,]+) tok\) \((\d+) skills\)/);
  const schemaM = text.match(/Tool schemas \(JSON\): ([\d,]+) chars \(~([\d,]+) tok\)/);
  const files: Array<{ name: string; chars: number; tok: number }> = [];
  const fileRe = /^- ([\w.]+\.md): (?:OK|MISSING)[^|]*\| raw ([\d,]+) chars \(~([\d,]+) tok\)/gm;
  for (const m of text.matchAll(fileRe)) files.push({ name: m[1], chars: num(m[2]), tok: num(m[3]) });
  return {
    sysTok: sysM ? num(sysM[2]) : 0,
    projectTok: sysM?.[3] ? num(sysM[3]) : 0,
    skillsTok: skillsM ? num(skillsM[2]) : 0,
    skillsCount: skillsM ? Number(skillsM[3]) : 0,
    schemasTok: schemaM ? num(schemaM[2]) : 0,
    files,
  };
};

/** agentId → 工作区目录（openclaw.json 显式配置优先，缺省按约定路径推） */
const resolveAgentWorkspace = (agentId: string): string => {
  try {
    const cfg = JSON.parse(fs.readFileSync("K:\\openclaw\\.openclaw\\.openclaw\\openclaw.json", "utf8")) as {
      agents?: { entries?: Record<string, { workspace?: string }> };
    };
    const ws = cfg.agents?.entries?.[agentId]?.workspace;
    if (ws) return ws;
  } catch {
    /* 配置读不到走约定路径 */
  }
  return `K:\\openclaw\\.openclaw\\.openclaw\\workspace-${agentId}`;
};

/** 该 agent 会话注入、但 /context 临时会话估算不到的底稿文件（中文按 chars/4 粗算，与官方口径一致）。
 *  exclude 传注入列表里已有的文件名（大写比较），避免同文件重复计数（RP 等装配会把 USER/MEMORY 直接列进注入）。 */
const contextExtraFiles = (workspaceDir: string, exclude?: Set<string>) => {
  const out: Array<{ name: string; chars: number; tok: number }> = [];
  for (const name of ["USER.md", "MEMORY.md"]) {
    if (exclude?.has(name.toUpperCase())) continue;
    try {
      const chars = fs.readFileSync(path.join(workspaceDir, name), "utf8").length;
      out.push({ name, chars, tok: Math.round(chars / 4) });
    } catch {
      /* 该工作区没有此文件就跳过 */
    }
  }
  try {
    const memDir = path.join(workspaceDir, "memory");
    const latest = fs.readdirSync(memDir).filter((f) => /^20\d\d-/.test(f)).sort().pop();
    if (latest) {
      const chars = fs.readFileSync(path.join(memDir, latest), "utf8").length;
      out.push({ name: `日记 ${latest}`, chars, tok: Math.round(chars / 4) });
    }
  } catch {
    /* 无日记 */
  }
  return out;
};

/** 连 gateway 收集上下文账单：临时会话跑 /context list + 目标会话实时用量；临时会话即删 */
async function probeGatewayContext(token: string, sessionKey?: string): Promise<{
  session: { key: string; agentId?: string; inputTokens?: number; contextWindow?: number };
  baseline: { sysTok: number; projectTok: number; skillsTok: number; skillsCount: number; schemasTok: number; files: Array<{ name: string; chars: number; tok: number }> };
  extra: Array<{ name: string; chars: number; tok: number }>;
}> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyRaw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");

  const ws = new WebSocket("ws://127.0.0.1:18789", { origin: "http://localhost:5173" });
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = String(++seq);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const withTimeout = <T,>(p: Promise<T>, ms: number, label: string) =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("超时: " + label)), ms))]);

  let hello: Record<string, unknown> | null = null;
  let finalText = "";

  ws.on("message", (data: Buffer) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame.type === "event" && frame.event === "connect.challenge") {
      const { ts, nonce } = (frame.payload ?? {}) as { ts?: number; nonce?: string };
      const payload = buildDeviceAuthPayloadV3({
        deviceId, clientId: "webchat-ui", clientMode: "webchat", role: "operator",
        scopes: ["operator.read", "operator.write"], signedAtMs: ts ?? Date.now(), token, nonce: nonce ?? "", platform: "browser",
      });
      request("connect", {
        minProtocol: 4, maxProtocol: 4,
        client: { id: "webchat-ui", version: "0.1.0", platform: "browser", mode: "webchat" },
        role: "operator", scopes: ["operator.read", "operator.write"],
        device: {
          id: deviceId, publicKey: publicKeyRaw.toString("base64url"),
          signature: cryptoSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url"),
          signedAt: ts ?? Date.now(), nonce: nonce ?? "",
        },
        auth: { token }, locale: "zh-CN",
      }).then((p) => {
        hello = p;
      }).catch(() => {});
      return;
    }
    if (frame.type === "res") {
      const p = pending.get(String(frame.id));
      if (!p) return;
      pending.delete(String(frame.id));
      if (frame.ok) p.resolve(frame.payload ?? {});
      else p.reject(new Error(String((frame.error as { message?: string })?.message ?? "gateway 拒绝")));
      return;
    }
    if (frame.type === "event" && frame.event === "chat") {
      const p = (frame.payload ?? {}) as { state?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
      if (p.state === "final") {
        finalText = (p.message?.content ?? []).filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("");
      }
    }
  });

  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }), 8000, "连接 gateway");

    await withTimeout(new Promise<void>((r) => {
      const t = setInterval(() => { if (hello) { clearInterval(t); r(); } }, 100);
    }), 12000, "网关握手");
    const snapshot = ((hello ?? {}) as { snapshot?: { sessionDefaults?: { mainSessionKey?: string } } }).snapshot;
    const mainKey = snapshot?.sessionDefaults?.mainSessionKey ?? "agent:main:main";

    const list = (await withTimeout(request("sessions.list", {}), 8000, "sessions.list")) as { sessions?: Array<Record<string, unknown>> };
    const rows = list.sessions ?? [];
    // 指定会话就测它（账单按该会话所属 agent 的装配算）；没指定回退主会话
    const targetRow = (sessionKey ? rows.find((s) => s.key === sessionKey) : undefined) ?? rows.find((s) => s.key === mainKey);
    if (!targetRow) throw new Error(sessionKey ? "会话不存在（可能已删除或归档）" : "找不到主会话");
    const targetKey = String(targetRow.key);
    const agentId = String(targetRow.agentId ?? "main");

    const created = (await withTimeout(request("sessions.create", { agentId }), 10000, "临时会话创建")) as Record<string, unknown>;
    const row = (created.session ?? created) as Record<string, unknown>;
    const tmpKey = String(row.key ?? created.key ?? "");
    try {
      finalText = "";
      await withTimeout(request("chat.send", { sessionKey: tmpKey, message: "/context list", idempotencyKey: randomUUID() }), 12000, "发送命令");
      await withTimeout(new Promise<void>((r) => {
        const t = setInterval(() => { if (finalText) { clearInterval(t); r(); } }, 150);
      }), 45000, "/context 回复");
      const baseline = parseContextReport(finalText);
      const injected = new Set(baseline.files.map((f) => f.name.toUpperCase()));
      return {
        session: {
          key: targetKey,
          agentId,
          inputTokens: typeof targetRow.inputTokens === "number" ? (targetRow.inputTokens as number) : undefined,
          contextWindow: typeof targetRow.contextTokens === "number" ? (targetRow.contextTokens as number) : undefined,
        },
        baseline,
        extra: contextExtraFiles(resolveAgentWorkspace(agentId), injected),
      };
    } finally {
      // 临时会话清理（尽力而为；失败只留一个空会话，可在会话页手动删）
      try {
        await withTimeout(request("sessions.patch", { key: tmpKey, archived: true, expectedSessionId: row.sessionId }), 8000, "归档临时会话");
        await withTimeout(request("sessions.delete", { key: tmpKey, archivedOnly: true, deleteTranscript: true }), 15000, "删除临时会话");
      } catch {
        /* 忽略 */
      }
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 审批端点：GET /__rana/approvals（快照）、POST /__rana/approvals（批准/拒绝）。
 * 快照直读 state 库：operator_approvals 表（未决 = resolved_at_ms 为空；历史 = 已决最近 60 条）
 * + exec_approvals_config 的 raw_json（只回 allowlist 条目，socket/token 一律剥掉不外发）。
 * POST 经官方 CLI（approvals resolve <id> allow-once|deny）——resolve 有闸门语义，不直接写库。
 * ?withGrants=1 时额外跑一次 CLI approvals grants list（子进程 1~3s，仅页面打开/手动刷新用，
 * 轮询角标别带）。仅本机可访问。
 */
function ranaApprovalsMiddleware(): Plugin {
  const DB_FILE = path.join(STATE_HOME, "state", "openclaw.sqlite");
  const HISTORY_LIMIT = 60;

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

  type Row = Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
  const pickPresentation = (raw: unknown): { commandText?: string; warningText?: string } => {
    try {
      const p = JSON.parse(String(raw ?? "{}")) as { commandText?: string; warningText?: string };
      return { commandText: p.commandText, warningText: p.warningText };
    } catch {
      return {};
    }
  };
  const toApproval = (r: Row) => ({
    id: String(r.approval_id ?? ""),
    kind: String(r.kind ?? ""),
    commandText: pickPresentation(r.presentation_json).commandText ?? "",
    warningText: pickPresentation(r.presentation_json).warningText ?? "",
    sessionKey: String(r.source_session_key ?? ""),
    agentId: String(r.source_agent_id ?? ""),
    createdAtMs: num(r.created_at_ms),
    expiresAtMs: num(r.expires_at_ms),
    resolvedAtMs: r.resolved_at_ms === null || r.resolved_at_ms === undefined ? null : num(r.resolved_at_ms),
    decision: r.decision === null || r.decision === undefined ? null : String(r.decision),
    terminalReason: r.terminal_reason === null || r.terminal_reason === undefined ? null : String(r.terminal_reason),
    resolverId: r.resolver_id === null || r.resolver_id === undefined ? null : String(r.resolver_id),
    status: String(r.status ?? ""),
  });

  const readSnapshot = async () => {
    // 每次请求新开只读连接：库被网关 WAL 占用，只读打开安全（cron-session-cleanup 先例）
    const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const pending = db
        .prepare("SELECT * FROM operator_approvals WHERE resolved_at_ms IS NULL ORDER BY created_at_ms DESC")
        .all()
        .map(toApproval);
      const history = db
        .prepare(`SELECT * FROM operator_approvals WHERE resolved_at_ms IS NOT NULL ORDER BY resolved_at_ms DESC LIMIT ${HISTORY_LIMIT}`)
        .all()
        .map(toApproval);
      let allowlist: Array<{ pattern: string; lastUsedAtMs?: number }> = [];
      try {
        const cfg = db.prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key='current'").get() as Row | undefined;
        const parsed = JSON.parse(String(cfg?.raw_json ?? "{}")) as {
          agents?: Record<string, { allowlist?: Array<{ pattern?: string; lastUsedAt?: number }> }>;
        };
        for (const agent of Object.values(parsed.agents ?? {})) {
          for (const item of agent.allowlist ?? []) {
            if (item?.pattern) allowlist.push({ pattern: item.pattern, lastUsedAtMs: item.lastUsedAt });
          }
        }
      } catch {
        // allowlist 解析失败不影响主数据
      }
      return { pending, history, allowlist };
    } finally {
      db.close();
    }
  };

  const runCli = async (args: string[]) => {
    const { stdout, stderr } = await execFileP(process.execPath, [resolveOpenclawMjs(), ...args], {
      timeout: 25_000,
      windowsHide: true,
      env: { ...process.env, OPENCLAW_STATE_DIR: STATE_HOME },
    });
    return `${stdout}${stderr}`.trim();
  };

  const handler = async (
    req: {
      method?: string;
      url?: string;
      headers?: Record<string, unknown>;
      socket?: { remoteAddress?: string };
      on: (ev: string, cb: (c?: string) => void) => void;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可访问" });
      return;
    }
    const u = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET") {
      try {
        const snap = await readSnapshot();
        let grants = "";
        if (u.searchParams.get("withGrants") === "1") {
          try {
            grants = await runCli(["approvals", "grants", "list"]);
          } catch (e) {
            grants = `读取失败：${(e as Error).message}`;
          }
        }
        json(res, 200, { ...snap, grants });
      } catch (e) {
        json(res, 500, { error: `读审批数据失败：${(e as Error).message}` });
      }
      return;
    }
    if (req.method === "POST") {
      const chunks: string[] = [];
      req.on("data", (c?: string) => chunks.push(c ?? ""));
      req.on("end", () => {
        void (async () => {
          let body: { id?: string; decision?: string } = {};
          try {
            body = JSON.parse(chunks.join("") || "{}") as typeof body;
          } catch {
            /* 空 Body */
          }
          const id = String(body.id ?? "");
          const decision = String(body.decision ?? "");
          if (!id || !["allow-once", "deny"].includes(decision)) {
            json(res, 400, { error: "参数不对（id + decision=allow-once|deny）" });
            return;
          }
          try {
            const out = await runCli(["approvals", "resolve", id, decision]);
            json(res, 200, { ok: true, output: out.slice(0, 2000) });
          } catch (e) {
            json(res, 502, { error: `处理失败：${(e as Error).message}` });
          }
        })();
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-approvals",
    configureServer(server) {
      server.middlewares.use("/__rana/approvals", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/approvals", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}

export default defineConfig({
  plugins: [react(), ranaDevConfig(), ranaAgentsMiddleware(), ranaProviderConfigMiddleware(), ranaSysStatusMiddleware(), ranaAvatarMiddleware(), ranaNewsMiddleware(), ranaStudyMiddleware(), ranaEventsMiddleware(), ranaBangumiMiddleware(), ranaLifeMiddleware(), ranaFateMiddleware(), ranaAgentInfoMiddleware(), ranaQqProfileMiddleware(), ranaDshModelsMiddleware(), ranaModelTestMiddleware(), ranaModelParamsMiddleware(), ranaSessionsCleanupMiddleware(), ranaApprovalsMiddleware(), ranaContextMiddleware()],
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
