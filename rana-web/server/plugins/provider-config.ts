import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileP } from "../lib/exec";
import { STATE_HOME, OPENCLAW_CONFIG, OPENCLAW_MJS } from "../lib/paths";
import { readFullConfig, maskKey, isLocalProvider, providerReferences, type ProviderEntry } from "../lib/config";
import type { Plugin } from "vite";

/**
 * 云端模型多 provider 配置端点：
 * - GET  读全部 provider（key 打码，附模型列表与 local 标记）
 * - POST {id, baseUrl, apiKey?, models?} 新增/更新一个 provider（models 保留既有条目的 params 等扩展字段）
 * - DELETE ?id= 删除 provider（本地 provider 与仍被引用的拒删）
 * 写 openclaw.json 后由 gateway 文件监听热重载。
 * 另有 POST /__rana/provider-models {baseUrl, apiKey?} 服务端代理拉取 /models 列表（规避浏览器 CORS）。
 */
export function ranaProviderConfigMiddleware(): Plugin {
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
          // name 兜底：id 是旧的沿用表单名（=旧条目名）；id 是新的（把过期行直接改成新模型）一律归位成 id——
          // 表单不显示也不让改名字，新 id 身上的"名字"只能是旧行残留，跟着存进去顶栏就会挂错名
          name: oldById.has(m.id.trim()) ? (m.name && m.name.trim()) || m.id.trim() : m.id.trim(),
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
