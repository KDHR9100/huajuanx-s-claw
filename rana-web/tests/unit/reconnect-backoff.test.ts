// src/lib/reconnectBackoff.ts 的退避计划测试（批次 D：断线重连加固）。
// 抽成零依赖叶模块的原因：gateway.ts 顶层牵动 zustand store（localStorage），
// node 测试环境直接 import 会炸；退避计划本身是纯函数，独立成模块两边共用。
// 口径：首试 ~1s、每次 ×2、封顶 30s、不放弃——旧行为是 6 次（约 45s）后彻底放弃需手动刷新，
// 而网关重启是本项目日常运维动作。
import { describe, it, expect } from "vitest";
import { reconnectBackoffMs } from "../../src/lib/reconnectBackoff";

describe("reconnectBackoffMs", () => {
  it("指数退避序列：1s → 2s → 4s → 8s → 16s", () => {
    expect(reconnectBackoffMs(0)).toBe(1000);
    expect(reconnectBackoffMs(1)).toBe(2000);
    expect(reconnectBackoffMs(2)).toBe(4000);
    expect(reconnectBackoffMs(3)).toBe(8000);
    expect(reconnectBackoffMs(4)).toBe(16000);
  });

  it("第 5 次起封顶 30s（2^5=32s 超出封顶值）", () => {
    expect(reconnectBackoffMs(5)).toBe(30_000);
    expect(reconnectBackoffMs(6)).toBe(30_000);
    expect(reconnectBackoffMs(100)).toBe(30_000);
  });

  it("负数/异常输入按 0 次处理（防御性下界）", () => {
    expect(reconnectBackoffMs(-1)).toBe(1000);
    expect(reconnectBackoffMs(-100)).toBe(1000);
  });

  it("序列性质：单调不减、始终 ≥1s 且 ≤30s", () => {
    let prev = 0;
    for (let attempt = 0; attempt <= 50; attempt++) {
      const d = reconnectBackoffMs(attempt);
      expect(d, `attempt=${attempt}`).toBeGreaterThanOrEqual(prev);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(30_000);
      prev = d;
    }
  });
});
