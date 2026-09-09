import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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
      models: (p.models ?? []).map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
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
  plugins: [react(), ranaDevConfig(), ranaProviderConfigMiddleware()],
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
