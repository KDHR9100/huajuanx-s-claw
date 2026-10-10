import fs from "node:fs";
import { OPENCLAW_CONFIG } from "../lib/paths";
import { readFullConfig } from "../lib/config";
import { json } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 本地模型超参数端点（仅本地 provider 的模型；写入 openclaw.json 后网关文件监听热重载，真实生效）：
 * POST /__rana/model-params {providerId, modelId, params} —— params 只允许白名单数值键，合并进既有 params。
 * 仅本机回环来源可调。
 */
export function ranaModelParamsMiddleware(): Plugin {
  const ALLOWED_KEYS = ["temperature", "top_p", "repeat_penalty", "maxTokens"] as const;

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
