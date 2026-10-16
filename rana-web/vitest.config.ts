import { defineConfig } from "vitest/config";

// 独立测试配置：不碰 vite.config.ts（那里装配 22 组服务端插件，与单测无关）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
