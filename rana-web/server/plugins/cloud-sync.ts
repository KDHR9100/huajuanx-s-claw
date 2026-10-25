import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileP } from "../lib/exec";
import { RANA_WEB, STATE_HOME } from "../lib/paths";
import { json, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 云→家同步桥（2026-10-25 迁移批1；方案 MIGRATION-PLAN §6——记忆正本在家里，云端运行副本每日被家里拉走）：
 * - GET  /__rana/cloud-snapshot   【数据面，跑在云端】家里 cloud-sync.mjs 来拉：tar.gz 流式打包状态目录的数据部分，
 *   X-Home-Token 校验（与探针共用 rana-web/.env 的 HOME_REPORT_TOKEN）；成功下载记账（云端记忆页显示「家里最后拉取」）。
 * - GET  /__rana/cloud-sync       状态：本地=上次拉取+manifest；云端=最近被拉取+最近 manifest。
 * - POST /__rana/cloud-sync/pull  【本地 Windows】启动一轮拉取（spawn tools/cloud-sync.mjs），进度轮询同 bridge-sync 模式。
 * 不含 tmp/（插件构建缓存）、npm/（插件可重装）——这两块是 8G 备份里的大头，数据快照用不上。
 */
export function cloudSyncMiddleware(): Plugin {
  const IS_WIN = process.platform === "win32";
  const HERE = RANA_WEB;
  const LOCAL_STATE_FILE = path.join(HERE, ".health", "home-sync-state.json"); // 家里:上次拉取记录
  const CLOUD_STATE_FILE = path.join(HERE, ".health", "cloud-sync-state.json"); // 云端:最近被拉取记录
  const STATUS = { pulling: false, startedAt: 0, updatedAt: 0, log: [] as string[], error: null as string | null };

  const readHomeToken = (): string => {
    try {
      const env = fs.readFileSync(path.join(HERE, ".env"), "utf8");
      return (env.match(/^HOME_REPORT_TOKEN=(.+)$/m)?.[1] ?? "").trim();
    } catch {
      return "";
    }
  };

  /** 快照收录清单：状态目录里的「数据」部分（会话库/人格/记忆/凭据/钩子/技能），不含 tmp 与 npm */
  const SNAPSHOT_PARTS = [
    "openclaw.json",
    "config-journal-fingerprint.key",
    "state",
    "agents",
    "workspace-main",
    "workspace-rana-rp",
    "workspace-rana-qq-public",
    "shared-memory",
    "private-memory",
    "openclaw-weixin",
    "hooks",
    "extensions",
    "extensions-local",
    "mcp-servers",
    "media",
  ];

  /** 顶层统计（给 manifest：每部分文件数/字节数；走不动就标 0，不阻塞打包） */
  const countPart = (name: string): { name: string; files: number; bytes: number } => {
    const p = path.join(STATE_HOME, name);
    let files = 0;
    let bytes = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 12) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else {
          files += 1;
          try {
            bytes += fs.statSync(full).size;
          } catch {
            /* 文件正被删，跳过 */
          }
        }
      }
    };
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, 0);
      else {
        files = 1;
        bytes = st.size;
      }
    } catch {
      /* 不存在的部分不计 */
    }
    return { name, files, bytes };
  };

  const readJsonSafe = (p: string) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };

  /** 数据面：tar.gz 流式下载（云端跑）。bsdtar(Windows System32) 与 gnu tar(Linux) 都吃这套参数。 */
  const snapshotHandler = (
    req: { method?: string; headers?: Record<string, unknown> },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; flushHeaders?: () => void; write: (c: Buffer | string) => void; end: (s?: string) => void; on: (ev: string, cb: () => void) => void },
  ) => {
    if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const token = readHomeToken();
    if (!token || String(req.headers?.["x-home-token"] ?? "") !== token) {
      json(res, 403, { error: "同步 token 不对或未配置" });
      return;
    }
    const parts = SNAPSHOT_PARTS.filter((n) => fs.existsSync(path.join(STATE_HOME, n)));
    const manifest = { generatedAt: Date.now(), parts: parts.map(countPart) };
    res.setHeader("content-type", "application/gzip");
    res.setHeader("content-disposition", 'attachment; filename="cloud-snapshot.tar.gz"');
    res.setHeader("x-rana-manifest", Buffer.from(JSON.stringify(manifest)).toString("base64"));
    res.flushHeaders?.();
    const child = spawn("tar", ["-czf", "-", "-C", STATE_HOME, ...parts], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c: Buffer) => res.write(c));
    child.stderr.on("data", (c: Buffer) => STATUS.log.push(`tar: ${c.toString().trim().slice(0, 200)}`));
    child.on("error", (e: Error) => {
      res.statusCode = 500;
      res.end(`tar 起不来：${e.message}`);
    });
    child.on("close", (code: number | null) => {
      res.end();
      if (code === 0) {
        const totalBytes = manifest.parts.reduce((a, p) => a + p.bytes, 0);
        fs.mkdirSync(path.dirname(CLOUD_STATE_FILE), { recursive: true });
        fs.writeFileSync(CLOUD_STATE_FILE, JSON.stringify({ lastPullAt: Date.now(), totalBytes, manifest }, null, 2));
      }
      if (STATUS.log.length > 200) STATUS.log = STATUS.log.slice(-100);
    });
    // 客户端断开时别让 tar 僵着
    res.on("close", () => child.kill());
  };

  /** 本地拉取（家里 Windows）：spawn tools/cloud-sync.mjs，日志/状态走内存+轮询 */
  const startPull = async () => {
    if (STATUS.pulling) throw new Error("上一轮拉取还在跑");
    STATUS.pulling = true;
    STATUS.startedAt = Date.now();
    STATUS.updatedAt = Date.now();
    STATUS.error = null;
    STATUS.log = ["[" + new Date().toISOString().slice(11, 19) + "] 拉取开始…"];
    try {
      const r = await execFileP(process.execPath, [path.resolve(HERE, "..", "tools", "cloud-sync.mjs")], {
        cwd: HERE,
        timeout: 30 * 60_000,
        windowsHide: true,
      });
      STATUS.log.push(...`${r.stdout ?? ""}`.trim().split("\n").slice(-20).map((l) => `  ${l}`));
      STATUS.log.push("[完成] 拉取结束");
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      STATUS.log.push(...`${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().split("\n").slice(-10).map((l) => `  ${l}`));
      STATUS.error = err.message ?? "拉取失败";
    } finally {
      STATUS.pulling = false;
      STATUS.updatedAt = Date.now();
    }
  };

  const handler = (
    req: { method?: string; headers?: Record<string, unknown>; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method === "GET") {
      json(res, 200, {
        platform: IS_WIN ? "win32" : "linux",
        pulling: STATUS.pulling,
        updatedAt: STATUS.updatedAt,
        error: STATUS.error,
        log: STATUS.log.slice(-30),
        // 本地(家里):自己上次拉了什么;云端:家里上次什么时候来拉过
        local: readJsonSafe(LOCAL_STATE_FILE),
        cloud: readJsonSafe(CLOUD_STATE_FILE),
      });
      return;
    }
    if (req.method === "POST") {
      if (!IS_WIN) {
        json(res, 400, { error: "拉取在家里电脑上发起（云端是被动提供快照的一方）" });
        return;
      }
      if (!isLoopback(req)) {
        json(res, 403, { error: "仅可信设备可操作" });
        return;
      }
      void startPull();
      json(res, 200, { ok: true, started: true });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-cloud-sync",
    configureServer(server) {
      server.middlewares.use("/__rana/cloud-snapshot", snapshotHandler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/cloud-sync", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/cloud-snapshot", snapshotHandler as Parameters<typeof server.middlewares.use>[1]);
      server.middlewares.use("/__rana/cloud-sync", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
