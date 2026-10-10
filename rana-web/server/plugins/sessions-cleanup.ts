import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { json, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 系统会话清理端点：GET /__rana/sessions-cleanup 读进度，POST 启动 cron-session-cleanup.mjs。
 * 手术全在脚本里做（停网关→备份→清 placement 残留→重启→CLI 删 cron 父会话），中间件只负责拉起与查询；
 * 进度落盘 %TEMP%\openclaw\cron-session-cleanup.json（脚本每步更新 + 10s 保活，
 * updatedAt 超过 2 分钟视为陈旧锁，允许发起新任务）。脚本 detach 启动，vite 重启不影响手术进行。
 */
export function ranaSessionsCleanupMiddleware(): Plugin {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "cron-session-cleanup.mjs");
  const statusFile = path.join(os.tmpdir(), "openclaw", "cron-session-cleanup.json");
  const STALE_MS = 2 * 60 * 1000;



  const readStatus = (): Record<string, unknown> => {
    try {
      const raw = JSON.parse(fs.readFileSync(statusFile, "utf8")) as Record<string, unknown>;
      if (raw && typeof raw === "object") return { exists: true, ...raw };
    } catch {
      // 没跑过或读失败：按不存在处理
    }
    return { exists: false };
  };

  const handler = (
    req: { method?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string }; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method === "GET") {
      json(res, 200, readStatus());
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }
    if (req.method === "POST") {
      const chunks: string[] = [];
      req.on("data", (c?: string) => chunks.push(c ?? ""));
      req.on("end", () => {
        let dryRun = false;
        try {
          dryRun = Boolean((JSON.parse(chunks.join("") || "{}") as { dryRun?: boolean }).dryRun);
        } catch {
          // 空 Body 当正式清理
        }
        const st = readStatus();
        const fresh = typeof st.updatedAt === "number" && Date.now() - st.updatedAt < STALE_MS;
        if (st.exists && st.running === true && fresh) {
          json(res, 409, { error: "已有清理任务在进行中" });
          return;
        }
        const child = spawn(
          process.execPath,
          dryRun ? [script, "--dry-run"] : [script],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.unref();
        json(res, 200, { started: true, dryRun });
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-sessions-cleanup",
    configureServer(server) {
      server.middlewares.use("/__rana/sessions-cleanup", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/sessions-cleanup", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
