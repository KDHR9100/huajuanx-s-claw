import fs from "node:fs";
import path from "node:path";
import { guardReadJson, CONTRACT_FIELDS } from "../lib/contract-guard";
import { json } from "../lib/http";
import { STATE_HOME } from "../lib/paths";
import type { Plugin } from "vite";

/**
 * 群画像端点（纯只读展示）：GET /__rana/qq-profile
 * 读公共号工作区 memory/ 下的群画像/群友画像/周报 md + 群别名表（shared-memory/qq-bridge.json）。
 * 画像文件由 rana-qq-public 自己写（group-analyst skill），这里零写入；总结模型的切换走网关 WS RPC cron.update，不经过这里。
 */
export function ranaQqProfileMiddleware(): Plugin {
  // 2026-10-25 迁移批1 修复:原硬编码小写 "K:/openclaw/..." 在 Windows 大小写不敏感下侥幸能用,Linux 必读不到。
  // 改走 STATE_HOME(env 优先、缺省相对仓库推导),本地/云端同一条路径。
  const HOME = STATE_HOME;
  const memDir = path.join(HOME, "workspace-rana-qq-public", "memory");
  const aliasFile = path.join(HOME, "shared-memory", "qq-bridge.json");



  const aliases = (): Record<string, string> => {
    // [2026-11-14 卡2] 契约守卫：坏 JSON/groups 坏型→留痕+空表降级（原逻辑 parse try/catch 静默吞）；
    // 守卫通过=原值透传（groups 缺失仍 ?? {}，与现状一致）。文件缺失静默不算违规。
    const { value } = guardReadJson<{ groups?: Record<string, string> } | null>({
      contract: "qq/qq-bridge",
      file: aliasFile,
      fields: CONTRACT_FIELDS["qq/qq-bridge"],
      fallback: null,
    });
    return value?.groups ?? {};
  };

  interface MdFile {
    key: string;
    title: string;
    updated: string;
    names?: string;
    mtime: number;
    md: string;
  }
  const listMd = (prefix: string): MdFile[] => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(memDir).filter((f) => f.startsWith(prefix) && f.endsWith(".md"));
    } catch {
      return [];
    }
    return files
      .map((f) => {
        const md = fs.readFileSync(path.join(memDir, f), "utf8");
        const key = f.slice(prefix.length, -3);
        return {
          key,
          title: (md.match(/^#\s+(.+)$/m) ?? [])[1] ?? key,
          updated: (md.match(/^已整理至:\s*(.+)$/m) ?? [])[1] ?? "",
          names: (md.match(/^名片名:\s*(.+)$/m) ?? [])[1],
          mtime: fs.statSync(path.join(memDir, f)).mtimeMs,
          md,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  };

  const handler = (
    req: { method?: string; url?: string },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    const u = new URL(req.url ?? "/", "http://x");
    const route = u.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && route === "/") {
      const al = aliases();
      json(res, 200, {
        groups: listMd("group-").map((g) => ({ ...g, alias: al[g.key] ?? "" })),
        members: listMd("member-"),
        reports: listMd("report-"),
        generatedAt: Date.now(),
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-qq-profile",
    configureServer(server) {
      server.middlewares.use("/__rana/qq-profile", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/qq-profile", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
