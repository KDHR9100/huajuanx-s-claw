import type { Plugin } from "vite";
import type { PreviewServer, ViteDevServer } from "vite";
import { isLoopback, json } from "./http";

/**
 * defineRanaPlugin —— /__rana 中间件插件工厂（2026-11-15 架构卡 5 收拢）。
 *
 * 收拢什么：26 组 server/plugins/*.ts 中间件里逐字重复的「双注册样板」——
 * configureServer 与 configurePreviewServer 各写一遍 `server.middlewares.use(path, handler)`。
 * 工厂把它们收成一个 routes 对象，两个 hook 按同一顺序注册同一批 handler。
 *
 * 采用规则（什么形状该迁移 / 什么形状保留手写）：
 * - 两个 hook 的 body 除 hook 名外逐字节等价、且都只是 use(path, handler) 调用 → 迁移到本工厂；
 * - 任何一边有额外逻辑（缓存初始化、条件注册、不同的 handler 等）→ 保留手写，不硬套工厂。
 *
 * 行为纪律：
 * - 路由注册顺序 = routes 对象字面量键序（Object.entries 保证）；
 * - 不加 try/catch 包裹、不改写 handler 业务——注册动作与手写逐字节等价；
 * - preview=false 时不注册 configurePreviewServer（对应原插件只写 configureServer 的形状，如 rana-dev-config）。
 *
 * 统一鉴权时序（2026-11-17 主人拍板「工厂统一守卫」）：分发前先跑 isLoopback，
 * 失败统一 403 {"error":"仅本机可操作"}。各插件 handler 内的历史自查保留（双保险），
 * 原先 4 个无自查端点（agents/agent-info/provider-config/qq-profile）由此补上防线。
 */

/** /__rana 路由 handler：接受任意形状的 (req, res) 处理函数（never 参数逆变放行一切，工厂内部再 cast 给 connect）。 */
export type RanaHandler = (...args: never[]) => unknown;

export interface RanaPluginOptions {
  /** 插件名（原样透传给 vite，须保持 rana-* 前缀——冒烟测试按此计数 26）。 */
  name: string;
  /** 路由表：path → handler，按对象字面量键序注册。 */
  routes: Record<string, RanaHandler>;
  /** 是否同步注册 configurePreviewServer（默认 true；仅 dev 挂载的端点传 false）。 */
  preview?: boolean;
}

export function defineRanaPlugin(options: RanaPluginOptions): Plugin {
  const { name, routes, preview = true } = options;
  // dev 与 preview 两种 server 的 middlewares 类型一致（connect Server），一套循环通用
  const register = (server: ViteDevServer | PreviewServer) => {
    for (const [path, handler] of Object.entries(routes)) {
      const guarded: RanaHandler = (req, res, next) => {
        // 统一鉴权时序：任何业务前先查 loopback（isLoopback 纯内存计算，双查无害）
        if (!isLoopback(req as { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> })) {
          json(
            res as { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
            403,
            { error: "仅本机可操作" },
          );
          return;
        }
        (handler as (r: unknown, s: unknown, n?: unknown) => unknown)(req, res, next);
      };
      server.middlewares.use(path, guarded as Parameters<typeof server.middlewares.use>[1]);
    }
  };
  const plugin: Plugin = {
    name,
    configureServer(server) {
      register(server);
    },
  };
  if (preview) {
    plugin.configurePreviewServer = (server) => {
      register(server);
    };
  }
  return plugin;
}
