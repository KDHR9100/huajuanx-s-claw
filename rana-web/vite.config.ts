import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { buildServerPlugins } from "./server/index";

// 自建前端 + Vite 中间件充当零部署本地后端：22 组 /__rana 端点已拆到 server/ 目录，
// 这里只剩装配（react 前置，其余按域分模块）。
// 路径/配置/HTTP 小工具见 server/lib/*，各端点实现见 server/plugins/*。
// 形态区分：家里 Windows(默认)保留本地模型面板/本机操作卡;云端以 RANA_HOST_PLATFORM=linux 启动时隐藏(见 src/lib/platform.ts)。
export default defineConfig({
  // RANA_ 前缀环境变量暴露给 import.meta.env(云端部署用 RANA_HOST_PLATFORM=linux 区分形态;
  // define 注入方案在 dev 模式实测不生效导致白屏,故改走 env 通道)
  envPrefix: ["RANA_", "VITE_"],
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
