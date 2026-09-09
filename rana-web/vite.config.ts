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
const CLOUD_PROVIDER = "aliyun-maas";

function readCloudProvider() {
  const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf8")) as {
    models?: { providers?: Record<string, { baseUrl?: string; apiKey?: string }> };
  };
  const prov = cfg.models?.providers?.[CLOUD_PROVIDER] ?? {};
  return { baseUrl: prov.baseUrl ?? "", apiKey: prov.apiKey ?? "" };
}

/** 云端模型配置端点：GET 读（key 打码），POST 写 openclaw.json 并触发 gateway 热重载 */
function ranaProviderConfigMiddleware(): Plugin {
  const handler = (
    req: { method?: string; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    res.setHeader("content-type", "application/json");
    try {
      if (req.method === "GET") {
        const cur = readCloudProvider();
        res.end(JSON.stringify({
          baseUrl: cur.baseUrl,
          apiKeyMasked: cur.apiKey ? cur.apiKey.slice(0, 5) + "…" + cur.apiKey.slice(-4) : "",
          hasKey: Boolean(cur.apiKey),
        }));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c?: string) => { body += c ?? ""; });
        req.on("end", () => {
          try {
            const { baseUrl, apiKey } = JSON.parse(body) as { baseUrl?: string; apiKey?: string };
            if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "baseUrl 必须以 http(s):// 开头" }));
              return;
            }
            const cur = readCloudProvider();
            if (!apiKey && !cur.apiKey) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "当前无 key，必须填写 apiKey" }));
              return;
            }
            fs.copyFileSync(OPENCLAW_CONFIG, OPENCLAW_CONFIG + ".bak-cloud");
            const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf8")) as Record<string, unknown> & {
              models: { providers: Record<string, { baseUrl?: string; apiKey?: string }> };
            };
            cfg.models.providers[CLOUD_PROVIDER] = {
              ...cfg.models.providers[CLOUD_PROVIDER],
              baseUrl: baseUrl.replace(/\/+$/, ""),
              apiKey: apiKey || cur.apiKey,
            };
            fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(cfg, null, 2), "utf8");
            res.end(JSON.stringify({ ok: true, saved: { baseUrl } }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: (e as Error).message }));
          }
        });
        return;
      }
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method not allowed" }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  };
  return {
    name: "rana-provider-config",
    configureServer(server) {
      server.middlewares.use("/__rana/provider-config", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/provider-config", handler as Parameters<typeof server.middlewares.use>[1]);
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
