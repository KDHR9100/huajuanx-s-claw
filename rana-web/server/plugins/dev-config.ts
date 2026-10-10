import { readGatewayToken } from "../lib/paths";
import type { Plugin } from "vite";

export function ranaDevConfig(): Plugin {
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
