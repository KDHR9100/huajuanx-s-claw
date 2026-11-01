// 人物·事件图谱端点：GET /__rana/person-graph（结构化节点+最后核对）· GET /__rana/person-graph/source（graph.md 原文）。
// 安全模型同 memory.ts：路径在服务端写死，绝不接受前端传路径；只放行 graph.md 一个文件，
// personal/ 下其余文件（heart/querents 等）一个字节不出。
import fs from "node:fs";
import path from "node:path";
import { STATE_HOME } from "../lib/paths";
import { json, isLoopback } from "../lib/http";
import type { Plugin } from "vite";
import { parsePersonGraph } from "../lib/person-graph-parse";

export function ranaPersonGraphMiddleware(): Plugin {
  const GRAPH_MD = path.join(STATE_HOME, "workspace-main", "personal", "graph.md");

  const handler = (
    req: {
      method?: string;
      url?: string;
      on: (ev: string, cb: (c?: string) => void) => void;
      removeAllListeners: (ev?: string) => unknown;
      socket?: { remoteAddress?: string };
      headers?: Record<string, unknown>;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    const route = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "") || "/";
    if (req.method === "GET" && route === "/") {
      try {
        const md = fs.readFileSync(GRAPH_MD, "utf8");
        json(res, 200, parsePersonGraph(md));
      } catch {
        json(res, 200, { error: "graph.md 不存在或不可读", lastChecked: null, people: [], events: [] });
      }
      return;
    }
    if (req.method === "GET" && route === "/source") {
      try {
        json(res, 200, { content: fs.readFileSync(GRAPH_MD, "utf8") });
      } catch {
        json(res, 200, { content: "", error: "graph.md 不存在或不可读" });
      }
      return;
    }
    if (req.method === "POST" && route === "/save") {
      if (!isLoopback(req)) {
        json(res, 403, { error: "仅本机可操作" });
        return;
      }
      let body = "";
      req.on("data", (c?: string) => {
        body += c ?? "";
        if (body.length > 2 * 1024 * 1024) {
          json(res, 413, { error: "内容超过 2MB 上限" });
          req.removeAllListeners("data");
          req.removeAllListeners("end");
        }
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { content?: string };
          const content = String(parsed.content ?? "");
          if (content.length > 2 * 1024 * 1024) {
            json(res, 413, { error: "内容超过 2MB 上限" });
            return;
          }
          try {
            fs.copyFileSync(GRAPH_MD, GRAPH_MD + ".bak");
          } catch {
            // 首次保存无旧文件，没有 .bak 也继续
          }
          fs.writeFileSync(GRAPH_MD, content, "utf8");
          json(res, 200, { ok: true, bak: true });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-person-graph",
    configureServer(server) {
      server.middlewares.use("/__rana/person-graph", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/person-graph", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
