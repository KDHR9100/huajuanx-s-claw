// gateway.ts 删除队列原语差分测试（体检卡4变形版：不碰 gateway.ts，只锁行为）。
// 差分方法：本文件内逐字复制 gateway.ts 现行链推进骨架作参照实现（RefDeleteChain），
// 断言 src/lib/deleteChain.ts 的 appendToDeleteChain 驱动出的队列行为与参照一致。
// 范围说明：gateway.ts:868-884 的重试/回滚编排（attempt/sessionStillActive/store）
// 是副作用注入点，留 gateway，不在本差分覆盖内。
import { describe, it, expect } from "vitest";
import { appendToDeleteChain } from "../../src/lib/deleteChain";

// ── 参照实现（逐字复制自 rana-web/src/lib/gateway.ts）──
// 行 121：`private deleteChain: Promise<void> = Promise.resolve();`
// 行 866：`const task = this.deleteChain.then(async () => { ... });`
//          （866-885 的 async 体 = 重试/回滚副作用，此处参数化为 work）
// 行 886-889：`this.deleteChain = task.then(() => undefined, () => undefined);`
class RefDeleteChain {
  private deleteChain: Promise<void> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const task = this.deleteChain.then(work);
    this.deleteChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}

// ── 被测消费方：用新模块复刻 gateway 的字段用法（this.deleteChain = nextChain）──
class ModuleDeleteChain {
  private chain: Promise<void> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const { task, nextChain } = appendToDeleteChain(this.chain, work);
    this.chain = nextChain;
    return task;
  }
}

interface TaskSpec {
  id: string;
  ok: boolean;
  delayMs: number;
}

// 双方用同一份任务脚本跑，收集事件流做差分
function makeWork(spec: TaskSpec, events: string[]): () => Promise<string> {
  return async () => {
    events.push(`start:${spec.id}`);
    await new Promise((r) => setTimeout(r, spec.delayMs));
    events.push(`end:${spec.id}:${spec.ok ? "ok" : "err"}`);
    if (!spec.ok) throw new Error(`fail-${spec.id}`);
    return `done-${spec.id}`;
  };
}

async function drain(results: Array<Promise<unknown>>) {
  await Promise.allSettled(results);
  await new Promise((r) => setTimeout(r, 0));
}

describe("deleteChain 边界语义（钉死 gateway.ts:121/866/886-889 现行行为）", () => {
  it("空链上首个任务立即执行，返回值透传（T 泛型）", async () => {
    const q = new ModuleDeleteChain();
    await expect(q.run(async () => 42)).resolves.toBe(42);
    await expect(q.run(async () => "str")).resolves.toBe("str");
  });

  it("work 抛错时 task reject 并透传错误（调用方 deleteSession 的 catch 靠它）", async () => {
    const q = new ModuleDeleteChain();
    await expect(q.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  it("两任务严格串行：t2 启动时刻 ≥ t1 结束时刻", async () => {
    const q = new ModuleDeleteChain();
    const ends: number[] = [];
    let t2Start = 0;
    const p1 = q.run(async () => { await new Promise((r) => setTimeout(r, 20)); ends.push(Date.now()); });
    const p2 = q.run(async () => { t2Start = Date.now(); });
    await Promise.all([p1, p2]);
    expect(t2Start).toBeGreaterThanOrEqual(ends[0]);
  });

  it("前一任务失败链不断：t2 照常执行（gateway:886-889 吞错影子）", async () => {
    const q = new ModuleDeleteChain();
    const events: string[] = [];
    const p1 = q.run(makeWork({ id: "w1", ok: false, delayMs: 0 }, events));
    const p2 = q.run(makeWork({ id: "w2", ok: true, delayMs: 0 }, events));
    await drain([p1, p2]);
    expect(events).toEqual(["start:w1", "end:w1:err", "start:w2", "end:w2:ok"]);
  });

  it("任务耗时乱序（20/0/5ms）但启动顺序 = 注册顺序", async () => {
    const q = new ModuleDeleteChain();
    const events: string[] = [];
    const ps = [
      q.run(makeWork({ id: "slow", ok: true, delayMs: 20 }, events)),
      q.run(makeWork({ id: "instant", ok: true, delayMs: 0 }, events)),
      q.run(makeWork({ id: "mid", ok: true, delayMs: 5 }, events)),
    ];
    await drain(ps);
    expect(events.filter((e) => e.startsWith("start:"))).toEqual(["start:slow", "start:instant", "start:mid"]);
    expect(events.filter((e) => e.startsWith("end:"))).toEqual(["end:slow:ok", "end:instant:ok", "end:mid:ok"]);
  });

  it("同步突发注册 5 个任务：注册顺序与执行顺序一致", async () => {
    const q = new ModuleDeleteChain();
    const events: string[] = [];
    const ps: Array<Promise<unknown>> = [];
    for (let i = 0; i < 5; i++) ps.push(q.run(makeWork({ id: `t${i}`, ok: i % 2 === 0, delayMs: i % 3 }, events)));
    await drain(ps);
    expect(events.filter((e) => e.startsWith("start:"))).toEqual(["start:t0", "start:t1", "start:t2", "start:t3", "start:t4"]);
  });

  it("链可连续推进 20 次（含交替成败）全部完成", async () => {
    const q = new ModuleDeleteChain();
    const ps: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) ps.push(q.run(async () => { if (i % 3 === 0) throw new Error(`x${i}`); return i; }));
    const settled = await Promise.allSettled(ps);
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    expect(ok).toBe(13); // i%3===0 的 7 个失败（0,3,6,9,12,15,18），不影响后续
  });

  it("task reject 后立刻注册新任务仍会执行（gateway 失败回滚后队列继续）", async () => {
    const q = new ModuleDeleteChain();
    const events: string[] = [];
    const p1 = q.run(makeWork({ id: "dead", ok: false, delayMs: 0 }, events));
    const p2 = q.run(makeWork({ id: "after", ok: true, delayMs: 0 }, events));
    await drain([p1, p2]);
    expect(events).toEqual(["start:dead", "end:dead:err", "start:after", "end:after:ok"]);
  });

  it("work 返回已决 promise（Promise.resolve/reject）与 async 体行为一致", async () => {
    const q = new ModuleDeleteChain();
    await expect(q.run(() => Promise.resolve("fast"))).resolves.toBe("fast");
    await expect(q.run(() => Promise.reject(new Error("fast-fail")))).rejects.toThrow("fast-fail");
    // 后续任务不受影响
    await expect(q.run(async () => "next")).resolves.toBe("next");
  });

  it("差分：随机 30 任务脚本（随机成败+0~8ms 延时），事件流与 task 结果逐项与参照一致", async () => {
    let seed = 1114;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const specs: TaskSpec[] = Array.from({ length: 30 }, (_, i) => ({
      id: `j${i}`,
      ok: rand() > 0.35,
      delayMs: Math.floor(rand() * 9),
    }));
    const refQ = new RefDeleteChain();
    const modQ = new ModuleDeleteChain();
    const refEvents: string[] = [];
    const modEvents: string[] = [];
    const refPs = specs.map((s) => refQ.run(makeWork(s, refEvents)));
    const modPs = specs.map((s) => modQ.run(makeWork(s, modEvents)));
    const refOut = await Promise.allSettled(refPs);
    const modOut = await Promise.allSettled(modPs);
    expect(modEvents).toEqual(refEvents);
    expect(modOut.map((s) => s.status)).toEqual(refOut.map((s) => s.status));
    for (let i = 0; i < 30; i++) {
      const a = modOut[i] as PromiseSettledResult<string>;
      const b = refOut[i] as PromiseSettledResult<string>;
      if (a.status === "fulfilled" && b.status === "fulfilled") expect(a.value).toBe(b.value);
      if (a.status === "rejected" && b.status === "rejected") expect(a.reason.message).toBe(b.reason.message);
    }
  });

  it("差分：随机多轮突发注册（每轮 1~5 个任务共 ~40 个），事件流与参照一致", async () => {
    let seed = 777;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const refQ = new RefDeleteChain();
    const modQ = new ModuleDeleteChain();
    const refEvents: string[] = [];
    const modEvents: string[] = [];
    let n = 0;
    while (n < 40) {
      const burst = 1 + Math.floor(rand() * 5);
      const ps: Array<Promise<unknown>> = [];
      for (let i = 0; i < burst && n < 40; i++, n++) {
        const spec: TaskSpec = { id: `b${n}`, ok: rand() > 0.3, delayMs: Math.floor(rand() * 6) };
        ps.push(refQ.run(makeWork(spec, refEvents)));
        ps.push(modQ.run(makeWork(spec, modEvents)));
      }
      await drain(ps); // 突发之间留出推进空隙
    }
    expect(modEvents).toEqual(refEvents);
  });

  it("链尾永远 fulfilled：无论任务成败多少次，deleteChain 字段不变成 rejected（否则队列坏死）", async () => {
    const q = new ModuleDeleteChain();
    for (let i = 0; i < 5; i++) await q.run(async () => { throw new Error(`e${i}`); }).catch(() => {});
    const tail = q.run(async () => "alive");
    await expect(tail).resolves.toBe("alive");
  });

  it("串行链的完成顺序也 = 注册顺序（并行队列可能乱序完成，串行链不可能）", async () => {
    const q = new ModuleDeleteChain();
    const events: string[] = [];
    const ps = [
      q.run(makeWork({ id: "a", ok: true, delayMs: 15 }, events)),
      q.run(makeWork({ id: "b", ok: true, delayMs: 1 }, events)),
      q.run(makeWork({ id: "c", ok: true, delayMs: 8 }, events)),
    ];
    await drain(ps);
    expect(events).toEqual(["start:a", "end:a:ok", "start:b", "end:b:ok", "start:c", "end:c:ok"]);
  });

  it("结构化返回值透传（模拟 deleteSession 的调用方感知）", async () => {
    const q = new ModuleDeleteChain();
    const out = await q.run(async () => ({ deleted: true, key: "s1" }));
    expect(out).toEqual({ deleted: true, key: "s1" });
  });

  it("立即 resolve 的任务穿插：不产生额外等待（微任务级推进）", async () => {
    const q = new ModuleDeleteChain();
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) await q.run(async () => i);
    expect(Date.now() - t0).toBeLessThan(50); // 10 个零耗时任务不该有计时器等待
  });
});
