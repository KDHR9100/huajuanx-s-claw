// lib/single-instance.mjs 测试：单实例端口锁的等价承诺锚（2026-11-15 抽取自 qq-sidecar 的 acquireLock）。
// 只用系统临时分配的端口（port:0 起手），不碰 47612 等固定端口，零会话副作用。
import { describe, it, expect } from "vitest";
import { acquirePortLock } from "../../lib/single-instance.mjs";

describe("acquirePortLock", () => {
  it("抢锁成功：句柄含实际端口/持锁方标识/net server，且端口真的在听", async () => {
    const lock = await acquirePortLock(0, "test-a");
    try {
      expect(lock.port).toBeGreaterThan(0);
      expect(lock.name).toBe("test-a");
      expect(lock.server.listening).toBe(true);
    } finally {
      await new Promise((r) => lock.server.close(r));
    }
  });

  it("防双开：同端口再抢抛 EADDRINUSE（原始错误带 .code，qq-sidecar 话术分流靠它）", async () => {
    const lock = await acquirePortLock(0, "test-b");
    try {
      await expect(acquirePortLock(lock.port, "test-b2")).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise((r) => lock.server.close(r));
    }
  });

  it("释放后可复用：server.close() 后同端口再抢成功（关闭方式与 qq-sidecar shutdown 同款）", async () => {
    const lock = await acquirePortLock(0, "test-c");
    const realPort = lock.port;
    await new Promise((r) => lock.server.close(r));
    const again = await acquirePortLock(realPort, "test-c2");
    expect(again.server.listening).toBe(true);
    await new Promise((r) => again.server.close(r));
  });
});
