import fs from "node:fs";
import path from "node:path";
import { STATE_HOME } from "../lib/paths";
import { json, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 记忆浏览端点：GET /__rana/memory（文件树）· GET /__rana/memory/read?key= · POST /__rana/memory/save
 * 读/改 Rana 的记忆与人设文件（workspace-main / workspace-rana-rp / private-memory 三组）。
 * 安全模型是白名单制：前端只传 key，key→绝对路径映射在服务端每次请求时重建，绝不接受前端传路径；
 * 写操作仅限 loopback + editable 文件，写前自动留 .bak，内容上限 2MB。
 * 只读组是机器维护文件（MEMORY.md/DREAMS.md/共享纪要/巡检状态等）——手改会被桥和 dreaming 覆盖。
 * 私密组（SOUL.private.md、private-memory/*.md）仅本地 UI 展示，本端点绝不把内容发往任何远端。
 */
export function ranaMemoryMiddleware(): Plugin {
  const MAIN = path.join(STATE_HOME, "workspace-main");
  const RP = path.join(STATE_HOME, "workspace-rana-rp");
  const PRIV = path.join(STATE_HOME, "private-memory");



  const statOf = (abs: string): { size: number; mtime: number } => {
    try {
      const st = fs.statSync(abs);
      return { size: st.size, mtime: st.mtimeMs };
    } catch {
      return { size: 0, mtime: 0 };
    }
  };
  const listDir = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
    } catch {
      return [];
    }
  };
  const EDITABLE_TOP = new Set(["SOUL.md", "IDENTITY.md", "USER.md"]);
  const READONLY_TOP = new Set(["MEMORY.md", "DREAMS.md"]);
  // 记忆目录里：日记/手写笔记/交接文档可编辑；共享纪要、巡检、画像、周报等机器维护文件只读
  const EDITABLE_MEM_RE = /^(2026-\d{2}-\d{2}\.md|ops-notes\.md|handoff-.+\.md)$/;

  interface MemFile {
    key: string;
    name: string;
    editable: boolean;
    deletable: boolean;
    danger: boolean;
    size: number;
    mtime: number;
  }
  interface MemGroup {
    id: string;
    label: string;
    danger: boolean;
    files: MemFile[];
  }

  const buildIndex = (): { groups: MemGroup[]; map: Map<string, { abs: string; editable: boolean; deletable: boolean; danger: boolean }> } => {
    const map = new Map<string, { abs: string; editable: boolean; deletable: boolean; danger: boolean }>();
    const groups: MemGroup[] = [];

    const addGroup = (id: string, label: string, danger: boolean, fill: (push: (f: string, dir: string, sub: string | null, editable: boolean, danger: boolean, deletable: boolean) => void) => void) => {
      const files: MemFile[] = [];
      const push = (f: string, dir: string, sub: string | null, editable: boolean, danger: boolean, deletable: boolean) => {
        const key = sub ? `${id}:${sub}:${f}` : `${id}:${f}`;
        const abs = path.join(dir, f);
        const { size, mtime } = statOf(abs);
        map.set(key, { abs, editable, deletable, danger });
        files.push({ key, name: f, editable, deletable, danger, size, mtime });
      };
      fill(push);
      // 日期命名的文件（日记/月度纪要）最新的排最前，其余保持字母序
      const dateRe = /^\d{4}-\d{2}/;
      files.sort((a, b) => {
        if (dateRe.test(a.name) && dateRe.test(b.name)) return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
        if (dateRe.test(a.name)) return -1;
        if (dateRe.test(b.name)) return 1;
        return 0;
      });
      groups.push({ id, label, danger, files });
    };

    // 工作体（workspace-main）
    addGroup("main", "工作体 · workspace-main", false, (push) => {
      for (const f of listDir(MAIN)) {
        if (EDITABLE_TOP.has(f)) push(f, MAIN, null, true, false, false);
        else if (READONLY_TOP.has(f)) push(f, MAIN, null, false, false, false);
      }
      for (const f of listDir(path.join(MAIN, "memory"))) {
        const editable = EDITABLE_MEM_RE.test(f);
        push(f, path.join(MAIN, "memory"), "memory", editable, false, editable);
      }
      for (const f of listDir(path.join(MAIN, "projects"))) {
        push(f, path.join(MAIN, "projects"), "projects", true, false, true);
      }
    });
    // RP 体（workspace-rana-rp）
    addGroup("rp", "RP 体 · workspace-rana-rp", false, (push) => {
      for (const f of listDir(RP)) {
        // SOUL.private.md 只能编辑内容不能删（删掉=里人格消失，太危险）
        if (f === "SOUL.private.md") push(f, RP, null, true, true, false);
        else if (EDITABLE_TOP.has(f)) push(f, RP, null, true, false, false);
        else if (READONLY_TOP.has(f)) push(f, RP, null, false, false, false);
      }
      for (const f of listDir(path.join(RP, "memory"))) {
        const editable = EDITABLE_MEM_RE.test(f);
        push(f, path.join(RP, "memory"), "memory", editable, false, editable);
      }
    });
    // 私密层（private-memory 母本；acts/ledger 等 json 账本不进页面）
    // 可删：删掉等于"重置这段记忆"——桥下一轮提炼会重建空文件重新开始记
    addGroup("private", "私密层 · private-memory", true, (push) => {
      for (const f of listDir(PRIV)) {
        if (/^\d{4}-\d{2}\.md$/.test(f)) push(f, PRIV, null, true, true, true);
      }
    });

    return { groups, map };
  };

  const handler = (
    req: { method?: string; url?: string; socket?: { remoteAddress?: string }; headers?: Record<string, unknown>; on: (ev: string, cb: (c?: string) => void) => void },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    const u = new URL(req.url ?? "/", "http://x");
    const route = u.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && route === "/") {
      const { groups } = buildIndex();
      json(res, 200, { groups, generatedAt: Date.now() });
      return;
    }
    if (req.method === "GET" && route === "/read") {
      const key = u.searchParams.get("key") ?? "";
      const { map } = buildIndex();
      const hit = map.get(key);
      if (!hit) {
        json(res, 404, { error: "未知文件（不在白名单）" });
        return;
      }
      try {
        json(res, 200, { key, content: fs.readFileSync(hit.abs, "utf8"), editable: hit.editable, danger: hit.danger });
      } catch {
        json(res, 200, { key, empty: true, editable: hit.editable, danger: hit.danger });
      }
      return;
    }
    if (req.method === "POST" && route === "/save") {
      if (!isLoopback(req)) {
        json(res, 403, { error: "仅本机可操作" });
        return;
      }
      let body = "";
      let tooBig = false;
      req.on("data", (c?: string) => {
        if (tooBig) return;
        body += c ?? "";
        if (body.length > 2 * 1024 * 1024) {
          tooBig = true;
          json(res, 413, { error: "内容超过 2MB 上限" });
        }
      });
      req.on("end", () => {
        if (tooBig) return;
        try {
          const parsed = JSON.parse(body) as { key?: string; content?: string };
          const key = String(parsed.key ?? "");
          const content = String(parsed.content ?? "");
          if (content.length > 2 * 1024 * 1024) {
            json(res, 413, { error: "内容超过 2MB 上限" });
            return;
          }
          const { map } = buildIndex();
          const hit = map.get(key);
          if (!hit) {
            json(res, 404, { error: "未知文件（不在白名单）" });
            return;
          }
          if (!hit.editable) {
            json(res, 400, { error: "该文件由系统维护（只读），手改会被覆盖" });
            return;
          }
          try {
            fs.copyFileSync(hit.abs, hit.abs + ".bak");
          } catch {
            // 首次保存无旧文件，没有 .bak 也继续
          }
          fs.writeFileSync(hit.abs, content, "utf8");
          json(res, 200, { ok: true, bak: true });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }
    if (req.method === "POST" && route === "/delete") {
      if (!isLoopback(req)) {
        json(res, 403, { error: "仅本机可操作" });
        return;
      }
      let body = "";
      let tooBig = false;
      req.on("data", (c?: string) => {
        if (tooBig) return;
        body += c ?? "";
        if (body.length > 64 * 1024) {
          tooBig = true;
          json(res, 413, { error: "请求体过大" });
        }
      });
      req.on("end", () => {
        if (tooBig) return;
        try {
          const parsed = JSON.parse(body) as { key?: string };
          const key = String(parsed.key ?? "");
          const { map } = buildIndex();
          const hit = map.get(key);
          if (!hit) {
            json(res, 404, { error: "未知文件（不在白名单）" });
            return;
          }
          if (!hit.deletable) {
            json(res, 400, { error: "该文件不允许删除（人设与系统维护文件受保护）" });
            return;
          }
          // 删除=移入回收区（STATE_HOME/.memory-trash/，带时间戳防重名），不真删
          const trashDir = path.join(STATE_HOME, ".memory-trash");
          fs.mkdirSync(trashDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const trashPath = path.join(trashDir, `${path.basename(hit.abs)}.deleted-${stamp}`);
          fs.renameSync(hit.abs, trashPath);
          json(res, 200, { ok: true, trash: path.basename(trashPath) });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-memory",
    configureServer(server) {
      server.middlewares.use("/__rana/memory", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/memory", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
