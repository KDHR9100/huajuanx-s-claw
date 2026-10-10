import fs from "node:fs";
import path from "node:path";
import { execFileP } from "../lib/exec";
import { RANA_WEB } from "../lib/paths";
import type { Plugin } from "vite";

/**
 * 早报数据端点：GET /__rana/news 读本地 .news/report.json（由 news-report.mjs 每天 08:00 生成）。
 * 无文件/读失败返回 {empty:true}，前端展示引导文案。
 */
export function ranaNewsMiddleware(): Plugin {
  const here = RANA_WEB;
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
