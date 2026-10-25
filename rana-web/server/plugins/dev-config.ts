import { readGatewayToken } from "../lib/paths";
import { isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 开发模式给前端发网关连接信息（仅 dev 挂载，preview/静态构建不暴露）。
 * 2026-10-25 迁移批1 加固：token 只发给「可信来源」（回环，或云端注入的 RANA_TRUSTED_IPS）
 * ——此前无任何校验地明文下发网关 token，本机回环时代没人够得着所以无害，上云即钥匙挂门上。
 */
export function ranaDevConfig(): Plugin {
  return {
    name: "rana-dev-config",
    configureServer(server) {
      server.middlewares.use("/__rana/config", ((
        req: { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> },
        res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
      ) => {
        res.setHeader("content-type", "application/json");
        if (!isLoopback(req)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ gatewayUrl: "ws://127.0.0.1:18789", token: null, error: "仅可信设备可取 token（设置面板手动填）" }));
          return;
        }
        res.end(JSON.stringify({ gatewayUrl: "ws://127.0.0.1:18789", token: readGatewayToken() }));
      }) as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
