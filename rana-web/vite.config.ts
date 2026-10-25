import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { buildServerPlugins } from "./server/index";

// 自建前端 + Vite 中间件充当零部署本地后端：22 组 /__rana 端点已拆到 server/ 目录，
// 这里只剩装配（react 前置，其余按域分模块）。
// 路径/配置/HTTP 小工具见 server/lib/*，各端点实现见 server/plugins/*。
// __RANA_HOST_PLATFORM__：把「宿主平台」编译进前端——家里 Windows 构建=win32（显示本地模型面板/本机操作卡），
// 云端 Linux 构建=linux（隐藏 LM Studio 入口）。dev/preview 都取跑 vite 的那台机器。
export default defineConfig({
  define: {
    __RANA_HOST_PLATFORM__: JSON.stringify(process.platform),
  },
  plugins: [react(), ...buildServerPlugins()],
  server: {
    port: 5173,
    proxy: {
      "/gateway": {
        target: "http://127.0.0.1:18789",
        ws: true,
        rewriteWsOrigin: true,
      },
      // LM Studio 本地 REST（127.0.0.1:1234）未开 CORS，
      // 走同源代理供前端面板调用（加载/卸载本地模型）
      "/lmstudio": {
        target: "http://127.0.0.1:1234",
        rewrite: (p) => p.replace(/^\/lmstudio/, ""),
      },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      "/gateway": {
        target: "http://127.0.0.1:18789",
        ws: true,
        rewriteWsOrigin: true,
      },
      "/lmstudio": {
        target: "http://127.0.0.1:1234",
        rewrite: (p) => p.replace(/^\/lmstudio/, ""),
      },
    },
  },
});
