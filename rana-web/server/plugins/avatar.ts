import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { json, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 乐奈头像端点（图片只存本地 .avatars/ 目录，该目录已进 .gitignore 不入公开仓库）：
 * - GET    /__rana/avatar   当前头像（无则 404）
 * - POST   /__rana/avatar   上传（png/jpg/webp ≤4MB，raw body + content-type 判类型；仅本机回环）
 * - DELETE /__rana/avatar   恢复默认手绘脸（删除文件）
 */
export function ranaAvatarMiddleware(): Plugin {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".avatars");
  const EXT_BY_TYPE: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  const files = () => {
    try {
      return fs.readdirSync(dir).filter((f) => /\.(png|jpg|webp)$/.test(f));
    } catch {
      return [];
    }
  };
  const current = () => files().map((f) => path.join(dir, f))[0];




  const handler = (
    req: { method?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string }; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string | Buffer) => void },
  ) => {
    if (req.method === "GET") {
      const file = current();
      if (!file) {
        json(res, 404, { error: "no avatar" });
        return;
      }
      const ext = path.extname(file).slice(1);
      res.setHeader("content-type", ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "image/webp");
      res.setHeader("cache-control", "no-cache");
      res.end(fs.readFileSync(file));
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }
    if (req.method === "DELETE") {
      for (const f of files()) fs.rmSync(path.join(dir, f));
      json(res, 200, { ok: true, cleared: true });
      return;
    }
    if (req.method === "POST") {
      const ext = EXT_BY_TYPE[String(req.headers?.["content-type"] ?? "")] ?? "";
      if (!ext) {
        json(res, 400, { error: "只支持 png / jpg / webp" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c?: string) => {
        size += c?.length ?? 0;
        if (size > 4 * 1024 * 1024) {
          json(res, 413, { error: "图片太大（限 4MB）" });
          return;
        }
        chunks.push(Buffer.from(c ?? "", "binary"));
      });
      req.on("end", () => {
        try {
          fs.mkdirSync(dir, { recursive: true });
          for (const f of files()) fs.rmSync(path.join(dir, f)); // 单一头像：旧的清掉
          fs.writeFileSync(path.join(dir, `avatar.${ext}`), Buffer.concat(chunks));
          json(res, 200, { ok: true, url: `/__rana/avatar?t=${Date.now()}` });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-avatar",
    configureServer(server) {
      server.middlewares.use("/__rana/avatar", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/avatar", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
