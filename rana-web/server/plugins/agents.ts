import { readFullConfig } from "../lib/config";
import type { Plugin } from "vite";

/**
 * agents 清单端点：GET /__rana/agents → { agents: [{id, name}] }
 * 读 openclaw.json 的 agents.entries——前端按「配置里实际存在的智能体」决定显隐
 * （例：发行版单 Rana 时侧栏不出现 RP 入口；本机多智能体时照常显示）。
 * 只回 id/name，其余字段（模型、workspace 路径等）不外传。
 */
export function ranaAgentsMiddleware(): Plugin {
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
