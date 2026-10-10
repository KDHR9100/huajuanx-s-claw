import path from "node:path";
import net from "node:net";
import { execFileP } from "../lib/exec";
import { RANA_WEB } from "../lib/paths";
import type { Plugin } from "vite";

/**
 * 记忆桥手动同步端点（2026-10-06）：RP 上云后本地 LM Studio 平时无模型，桥的 RP 腿每班必败。
 * 本端点是 RP 页「🔗记忆同步」按钮的后端：一键「起服务→按需加载 14B→跑共享桥+私密桥→卸载模型」。
 * 显存红线：只有用户按下按钮才会碰模型；两个桥的定时班没模型只会静默失败等下一班，绝不自动加载。
 * - GET  /__rana/bridge-sync  当前同步状态（running/step/log/result/error）
 * - POST /__rana/bridge-sync  启动一轮同步（仅本机回环；上一轮没跑完时拒绝重复启动）
 */
export function bridgeSyncMiddleware(): Plugin {
  const LMS = "C:\\Users\\Administrator\\.lmstudio\\bin\\lms.exe";
  const STATUS = {
    running: false, startedAt: 0, updatedAt: 0, step: "",
    log: [] as string[], result: null as Record<string, string> | null, error: null as string | null,
  };
  const mark = (step: string, msg?: string) => {
    STATUS.step = step;
    STATUS.updatedAt = Date.now();
    if (msg) STATUS.log.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  };
  const portOpen = (port: number, timeoutMs = 2000) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host: "127.0.0.1" });
      const done = (ok: boolean) => { s.destroy(); resolve(ok); };
      s.setTimeout(timeoutMs, () => done(false));
      s.on("connect", () => done(true));
      s.on("error", () => done(false));
    });
  const loadedLlmIds = async () => {
    const r = await fetch("http://127.0.0.1:1234/v1/models", { signal: AbortSignal.timeout(5000) });
    return (((await r.json()) as { data?: Array<{ id?: string }> }).data ?? [])
      .map((m) => m.id ?? "").filter((id) => id && !/embed/i.test(id));
  };

  async function runSync() {
    let loadedByUs = false;
    const results: Record<string, string> = {};
    try {
      // 1) LM Studio 服务：没起就 lms server start，轮询等端口
      mark("lmstudio", "检查 LM Studio 服务…");
      if (!(await portOpen(1234))) {
        mark("lmstudio", "服务没起，lms server start…");
        await execFileP(LMS, ["server", "start"], { timeout: 60000, windowsHide: true });
        for (let i = 0; i < 15 && !(await portOpen(1234)); i++) await new Promise((r) => setTimeout(r, 2000));
        if (!(await portOpen(1234))) throw new Error("LM Studio 服务启动失败（端口 1234 未监听）");
      }
      // 2) 模型：优先用已加载的（绝不 JIT 拉起），14B 优先于 7B（7B 提炼实测会主客颠倒/编造）；都没有才加载 14B
      mark("model", "检查已加载模型…");
      let ids = await loadedLlmIds().catch(() => [] as string[]);
      let model = ids.find((id) => id === "rana-rp-14b") ?? ids.find((id) => id === "rana-v4-7b") ?? ids[0] ?? "";
      if (!model) {
        mark("model", "本地无模型，加载 rana-rp-14b（约一分钟）…");
        await execFileP(LMS, ["load", "rana-rp-14b", "--context-length", "16384", "--ttl", "600", "-y"], { timeout: 300000, windowsHide: true });
        loadedByUs = true;
        ids = await loadedLlmIds();
        model = ids.find((id) => id === "rana-rp-14b") ?? ids.find((id) => id === "rana-v4-7b") ?? ids[0] ?? "";
        if (!model) throw new Error("模型加载后仍未就绪");
      }
      mark("model", `提炼用模型：${model}（${loadedByUs ? "本次新加载，跑完自动卸载" : "已在显存，不动它"}）`);
      // 3) 共享桥 + 4) 私密桥（互相独立，前者失败不影响后者跑）
      const runScript = async (label: string, script: string) => {
        mark(label, `运行 ${script}…`);
        try {
          const r = await execFileP(process.execPath, [path.join(RANA_WEB, script)], {
            cwd: RANA_WEB, timeout: 600000, windowsHide: true,
          });
          results[label] = `${script} ✓`;
          mark(label, `${script} 完成`);
          const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
          if (out) STATUS.log.push(...out.split("\n").slice(-12).map((l) => `  ${l}`));
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string; message?: string };
          const tail = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().split("\n").slice(-6).join(" | ");
          results[label] = `${script} ✗ ${tail || err.message}`;
          mark(label, `${script} 失败：${tail || err.message}`);
        }
      };
      await runScript("shared-bridge", "memory-bridge.mjs");
      await runScript("private-bridge", "private-memory-bridge.mjs");
      STATUS.result = results;
    } catch (e) {
      STATUS.error = (e as Error).message ?? String(e);
      mark("error", `失败：${STATUS.error}`);
    } finally {
      if (loadedByUs) {
        mark("unload", "卸载本轮加载的模型，把显存还回去…");
        await execFileP(LMS, ["unload", "rana-rp-14b"], { timeout: 60000, windowsHide: true }).catch(() => {});
      }
      STATUS.running = false;
      STATUS.step = STATUS.error ? "failed" : "done";
      STATUS.updatedAt = Date.now();
    }
  }

  const handler = (
    req: { method?: string; socket?: { remoteAddress?: string }; headers?: Record<string, unknown> },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    const json = (code: number, obj: unknown) => {
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.statusCode = code;
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET") { json(200, { ...STATUS, log: STATUS.log.slice(-40) }); return; }
    if (req.method !== "POST") { json(405, { error: "method not allowed" }); return; }
    const ra = req.socket?.remoteAddress ?? "";
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra);
    const origin = String(req.headers?.origin ?? "");
    if (!loopback || (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin))) {
      json(403, { error: "仅本机可操作" });
      return;
    }
    if (STATUS.running && Date.now() - STATUS.updatedAt < 10 * 60_000) {
      json(409, { ok: false, started: false, error: "上一轮同步还在跑，稍等" });
      return;
    }
    STATUS.running = true; STATUS.startedAt = Date.now(); STATUS.updatedAt = Date.now();
    STATUS.step = "start"; STATUS.log = []; STATUS.result = null; STATUS.error = null;
    mark("start", "手动同步开始");
    void runSync();
    json(200, { ok: true, started: true });
  };
  return {
    name: "rana-bridge-sync",
    configureServer(server) {
      server.middlewares.use("/__rana/bridge-sync", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/bridge-sync", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
