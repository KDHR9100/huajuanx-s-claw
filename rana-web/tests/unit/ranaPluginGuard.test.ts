// rana-plugin.ts 工厂统一守卫用例（2026-11-17 卡5 鉴权时序统一拍板件）。
// 方法：假 vite server 抓注册的 guarded handler，直调验证守卫行为——
// loopback 放行、外源 403「仅本机可操作」、handler 不被调用、注册顺序保持键序。
// 零顶层 I/O（11-15 CI 案教训）；isLoopback 的 TRUSTED_IPS/ORIGINS 为模块级 env 常量，测试不设即空。
import { describe, it, expect, vi } from "vitest";
import { defineRanaPlugin } from "../../server/lib/rana-plugin";

/** 假 vite server：记录 use(path, handler) 调用序 */
function fakeServer() {
  const registered: Array<{ path: string; handler: (req: unknown, res: unknown, next?: unknown) => unknown }> = [];
  return {
    registered,
    middlewares: {
      use: (path: string, handler: (req: unknown, res: unknown, next?: unknown) => unknown) => {
        registered.push({ path, handler });
      },
    },
  };
}

/** 假 res：statusCode 就是 res 本体的属性（json() 直接赋值），ct/body 经闭包抓取 */
function fakeRes() {
  const calls = { ct: [] as string[], bodies: [] as (string | undefined)[] };
  const res = {
    setHeader: (k: string, v: string) => {
      calls.ct.push(`${k}=${v}`);
    },
    statusCode: 0,
    end: (s?: string) => {
      calls.bodies.push(s);
    },
  };
  return { res, calls };
}

/** 假 req：IP + 可选 headers */
const reqWith = (ip: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: ip }, headers });

function registerTwoRoutes() {
  const a = vi.fn();
  const b = vi.fn();
  const plugin = defineRanaPlugin({
    name: "rana-guard-test",
    routes: { "/__rana/a": a, "/__rana/b": b },
  });
  const server = fakeServer();
  plugin.configureServer?.(server as never);
  return { a, b, registered: server.registered };
}

describe("defineRanaPlugin 统一守卫（2026-11-17 卡5 拍板）", () => {
  it("loopback 请求（127.0.0.1）放行，handler 收到原参数", () => {
    const { a, registered } = registerTwoRoutes();
    const { res, calls } = fakeRes();
    const req = reqWith("127.0.0.1");
    const next = vi.fn();
    registered[0].handler(req, res, next);
    expect(a).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toBe(req);
    expect(a.mock.calls[0][1]).toBe(res);
    expect(res.statusCode).toBe(0); // 守卫没碰 res
  });

  it("loopback（::1）放行", () => {
    const { a, registered } = registerTwoRoutes();
    const { res } = fakeRes();
    registered[0].handler(reqWith("::1"), res, undefined);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("非 loopback（8.8.8.8）→ 403 仅本机可操作，handler 未被调用", () => {
    const { a, registered } = registerTwoRoutes();
    const { res, calls } = fakeRes();
    registered[0].handler(reqWith("8.8.8.8"), res, undefined);
    expect(a).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(String(calls.bodies[0]))).toEqual({ error: "仅本机可操作" });
    expect(calls.ct.join(";")).toContain("content-type=application/json");
  });

  it("回环 IP + 外站 Origin → 403（Origin 校验同 isLoopback 现行口径）", () => {
    const { a, registered } = registerTwoRoutes();
    const { res, calls } = fakeRes();
    registered[0].handler(reqWith("127.0.0.1", { origin: "https://evil.example" }), res, undefined);
    expect(a).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(String(calls.bodies[0]))).toEqual({ error: "仅本机可操作" });
  });

  it("回环 IP + localhost Origin → 放行", () => {
    const { a, registered } = registerTwoRoutes();
    const { res } = fakeRes();
    registered[0].handler(reqWith("127.0.0.1", { origin: "http://localhost:5173" }), res, undefined);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("守卫不改注册顺序（routes 键序 = use 序）", () => {
    const { a, b, registered } = registerTwoRoutes();
    expect(registered.map((r) => r.path)).toEqual(["/__rana/a", "/__rana/b"]);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });
});
