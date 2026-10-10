import { resolveApiKey } from "../../lib/rana-config.mjs";
import { readFullConfig } from "../lib/config";
import { json } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 模型连通测试端点：POST /__rana/model-test {modelId} —— 用该模型发一条最小消息（max_tokens 16），
 * 测能不能通、延迟多少。apiKey 只在运行时从 openclaw.json 读，不进日志不进前端。
 * 仅本机回环来源可调。
 */
export function ranaModelTestMiddleware(): Plugin {

  const testOne = async (providerId: string, model: string) => {
    const p = readFullConfig().models?.providers?.[providerId];
    if (!p?.baseUrl) throw new Error(`找不到 provider：${providerId || "(空)"}`);
    // apiKey 可能是明文串，也可能已是 SecretRef 对象（{source:"store",id}）——统一走共享解析（lib/rana-config.mjs）
    const apiKey = resolveApiKey((p as { apiKey?: unknown }).apiKey);
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
