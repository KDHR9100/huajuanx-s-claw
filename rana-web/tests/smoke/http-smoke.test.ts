// HTTP 冬烟测试（2026-11-14 架构体检卡3）：Vite 编程式 createServer 起真服务 + fetch 打 /__rana/*。
// 覆盖：①25 组中间件注册不炸（起服务即验证）②只读端点 200+JSON 形状（全部无外部依赖：
// 不 spawn CLI、不碰模型、不出网）③未知路径 404 / 错方法 405 ④卡2 守卫坏数据→留痕+降级。
// 密闭：RANA_WEB/OPENCLAW_STATE_DIR 指向临时目录、OPENCLAW_MJS 哑值（防 paths.ts 装载时
// npm root -g 探测）——无外网、无模型、无 CLI spawn；CI(ubuntu) 可跑，Windows 路径全走 path 模块。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";

const RANA_WEB_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let root = ""; // 临时 RANA_WEB（契约文件与守卫台账落这里）
let state = ""; // 临时 OPENCLAW_STATE_DIR
let baseUrl = "";
let server: ViteDevServer | null = null;

const GOOD_NEWS = {
  date: "2026-11-14", generatedAt: 1731500000000, xwlbDay: "2026-11-14",
  xwlb: [{ title: "a" }], sections: [{ id: "s", name: "n", items: [] }],
  summary: "ok", summaryError: "", queries: 1,
};

const req = async (p: string, init?: RequestInit) => {
  const res = await fetch(baseUrl + p, init);
  return { status: res.status, ct: res.headers.get("content-type") ?? "", text: await res.text() };
};
const reqJson = async (p: string, init?: RequestInit) => {
  const r = await req(p, init);
  return { ...r, body: JSON.parse(r.text) as Record<string, unknown> };
};

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "rana-smoke-web-"));
  state = mkdtempSync(path.join(tmpdir(), "rana-smoke-state-"));
  process.env.RANA_WEB = root;
  process.env.OPENCLAW_STATE_DIR = state;
  process.env.OPENCLAW_MJS = "smoke-dummy-no-cli"; // 防 paths.ts 装载时 npm root -g 探测（保持密闭）
  // fixtures：好早报（守卫通过→原文透传）+ 最小 openclaw.json（/__rana/agents 形状）
  mkdirSync(path.join(root, ".news"), { recursive: true });
  writeFileSync(path.join(root, ".news", "report.json"), JSON.stringify(GOOD_NEWS, null, 1), "utf8");
  writeFileSync(path.join(state, "openclaw.json"), JSON.stringify({ agents: { entries: { main: { name: "Rana" } } } }), "utf8");
  const { createServer } = await import("vite");
  server = await createServer({
    configFile: path.join(RANA_WEB_REPO, "vite.config.ts"), // 真装配：25 组 /__rana 中间件全注册
    root, // vite 根指临时目录（不碰真实前端文件；插件路径已由 RANA_WEB/OPENCLAW_STATE_DIR 隔离）
    server: { host: "127.0.0.1", port: 0, strictPort: true, watch: { ignored: ["**/*"] } },
    logLevel: "error",
  });
  await server.listen();
  const addr = server.httpServer?.address();
  if (!addr || typeof addr === "string") throw new Error("dev server 未监听 TCP 端口");
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60000);

afterAll(async () => {
  if (server) await server.close();
  server = null;
  try {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟释放：临时目录留给系统清，不影响断言 */
  }
});

describe("①插件注册", () => {
  it("25 组 /__rana 中间件全部注册（起服务不炸=注册成功；rana-* 计数=25）", () => {
    const rana = (server!.config.plugins).filter((p) => p.name?.startsWith("rana-"));
    expect(rana).toHaveLength(25);
  });
});

describe("②只读端点 200+JSON 形状（无外部依赖端点）", () => {
  it("GET /__rana/agents → 配置里的 agent 清单", async () => {
    const r = await reqJson("/__rana/agents");
    expect(r.status).toBe(200);
    expect(r.ct).toContain("application/json");
    expect(r.body).toEqual({ agents: [{ id: "main", name: "Rana" }] });
  });

  it("GET /__rana/news → 好数据原文逐字节透传（卡2 守卫通过=行为不变）", async () => {
    const r = await req("/__rana/news");
    expect(r.status).toBe(200);
    expect(r.text).toBe(JSON.stringify(GOOD_NEWS, null, 1));
  });

  it("GET /__rana/qq-profile → 空态形状（groups/members/reports 数组+generatedAt）", async () => {
    const r = await reqJson("/__rana/qq-profile");
    expect(r.status).toBe(200);
    expect(r.ct).toContain("application/json");
    expect(r.body.groups).toEqual([]);
    expect(r.body.members).toEqual([]);
    expect(r.body.reports).toEqual([]);
    expect(typeof r.body.generatedAt).toBe("number");
  });

  it("GET /__rana/memory → 三组记忆白名单形状（空态）", async () => {
    const r = await reqJson("/__rana/memory");
    expect(r.status).toBe(200);
    expect(r.ct).toContain("application/json");
    expect(Array.isArray(r.body.groups)).toBe(true);
    expect((r.body.groups as unknown[]).length).toBe(3);
    expect(typeof r.body.generatedAt).toBe("number");
  });

  it("GET /__rana/cloud-sync → 状态形状（无记账文件时 local/cloud=null，拉取空闲）", async () => {
    const r = await reqJson("/__rana/cloud-sync");
    expect(r.status).toBe(200);
    expect(r.ct).toContain("application/json");
    expect(r.body.pulling).toBe(false);
    expect(r.body.error).toBe(null);
    expect(Array.isArray(r.body.log)).toBe(true);
    expect(r.body.local).toBe(null);
    expect(r.body.cloud).toBe(null);
    expect(["win32", "linux"]).toContain(r.body.platform);
  });

  it("GET /__rana/config → 网关连接信息形状（loopback 放行；fixture 无 token → 空串）", async () => {
    const r = await reqJson("/__rana/config");
    expect(r.status).toBe(200);
    expect(r.body.gatewayUrl).toBe("ws://127.0.0.1:18789");
    expect(r.body.token).toBe("");
  });

  it("GET /__rana/sessions-cleanup → 进度契约形状（本机可能有残留进度，宽松断言 exists 布尔）", async () => {
    const r = await reqJson("/__rana/sessions-cleanup");
    expect(r.status).toBe(200);
    expect(r.ct).toContain("application/json");
    expect(typeof r.body.exists).toBe("boolean");
  });
});

describe("③未知路径与错方法", () => {
  it("GET /__rana/definitely-missing → 404", async () => {
    const r = await req("/__rana/definitely-missing");
    expect(r.status).toBe(404);
  });

  it("DELETE /__rana/news → 405 JSON {error}", async () => {
    const r = await reqJson("/__rana/news", { method: "DELETE" });
    expect(r.status).toBe(405);
    expect(r.ct).toContain("application/json");
    expect(r.body.error).toBe("method not allowed");
  });

  it("POST /__rana/qq-profile → 405 JSON {error}（只读端点无副作用）", async () => {
    const r = await reqJson("/__rana/qq-profile", { method: "POST", body: "{}" });
    expect(r.status).toBe(405);
    expect(r.body.error).toBe("method not allowed");
  });
});

describe("④卡2 守卫：坏数据→留痕+降级（临时坏 fixture 驱动，走真 HTTP）", () => {
  const newsFile = () => path.join(root, ".news", "report.json");
  const ledgerFile = () => path.join(root, ".health", "contract-guards.json");

  it("坏 JSON：GET /__rana/news → 200 {empty:true} 降级 + console 留痕 + 台账记录", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(newsFile(), "{bad", "utf8");
    const r = await reqJson("/__rana/news");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ empty: true });
    expect(errSpy.mock.calls.some((a) => String(a[0]).includes("contract news/report"))).toBe(true);
    errSpy.mockRestore();
    const ledger = JSON.parse(readFileSync(ledgerFile(), "utf8")) as { total: number; recent: Array<{ contract: string }> };
    expect(ledger.total).toBeGreaterThanOrEqual(1);
    expect(ledger.recent.some((e) => e.contract === "news/report")).toBe(true);
  });

  it("合法 JSON 但关键字段坏型：同降级+留痕", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(newsFile(), JSON.stringify({ date: 123, generatedAt: 1, xwlb: [], sections: [], summary: "" }), "utf8");
    const r = await reqJson("/__rana/news");
    expect(r.body).toEqual({ empty: true });
    expect(errSpy.mock.calls.some((a) => String(a[0]).includes("date"))).toBe(true);
    errSpy.mockRestore();
    expect(existsSync(ledgerFile())).toBe(true);
  });

  it("修好数据后自动恢复透传（守卫无粘性状态）", async () => {
    writeFileSync(newsFile(), JSON.stringify(GOOD_NEWS, null, 1), "utf8");
    const r = await req("/__rana/news");
    expect(r.status).toBe(200);
    expect(r.text).toBe(JSON.stringify(GOOD_NEWS, null, 1));
  });
});
