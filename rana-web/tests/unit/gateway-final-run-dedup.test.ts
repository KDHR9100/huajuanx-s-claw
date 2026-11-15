// gateway.ts 去重原语差分测试（体检卡4变形版：不碰 gateway.ts，只锁行为）。
// 差分方法：本文件内逐字复制 gateway.ts 现行实现作参照实现（见各 ref* 函数，
// 仅把 this.finalRunIds 参数化为 ids，其余一字未改），断言新模块
// src/lib/finalRunDedup.ts 的输出与参照一致，再钉死边界语义。
import { describe, it, expect } from "vitest";
import { FinalRunCache, isDuplicateOfRecentMessage } from "../../src/lib/finalRunDedup";

// ── 参照实现（逐字复制自 rana-web/src/lib/gateway.ts:546-553 rememberFinalRun，
//    仅 this.finalRunIds → ids 参数化）──
function refRememberFinalRun(ids: Set<string>, runId: string) {
  if (!runId) return;
  ids.add(runId);
  if (ids.size > 50) {
    const oldest = ids.values().next().value;
    if (oldest !== undefined) ids.delete(oldest);
  }
}

// ── 参照实现（逐字复制自 gateway.ts:512 片段：
//    `(p.runId !== undefined && this.finalRunIds.has(p.runId))`）──
function refFinalSeen(ids: Set<string>, runId: string | undefined) {
  return runId !== undefined && ids.has(runId);
}

// ── 参照实现（逐字复制自 gateway.ts:520 片段：
//    `list.slice(-8).some((m) => m.role === role && m.text === text
//      && (m.attachments?.length ?? 0) === (atts?.length ?? 0))`）──
function refRecentDup(
  list: Array<{ role: string; text: string; attachments?: unknown[] }>,
  role: string,
  text: string,
  atts?: Array<unknown> | null,
) {
  return list.slice(-8).some((m) => m.role === role && m.text === text && (m.attachments?.length ?? 0) === (atts?.length ?? 0));
}

describe("FinalRunCache 边界语义（钉死 gateway.ts:546-553/512 现行行为）", () => {
  it("空 runId 不入账（gateway:547 `if (!runId) return`）", () => {
    const c = new FinalRunCache();
    c.remember("");
    expect(c.size).toBe(0);
    const s = new Set<string>();
    refRememberFinalRun(s, "");
    expect(s.size).toBe(0);
  });

  it("remember 后 hasFinal 命中；命中即 onSessionMessage 跳过落库事件", () => {
    const c = new FinalRunCache();
    c.remember("run-1");
    expect(c.hasFinal("run-1")).toBe(true);
  });

  it("hasFinal(undefined) === false（gateway:512 `p.runId !== undefined &&`）", () => {
    const c = new FinalRunCache();
    expect(c.hasFinal(undefined)).toBe(false);
    c.remember("run-1");
    expect(c.hasFinal(undefined)).toBe(false);
  });

  it("hasFinal(\"\") === false：空串永不入账所以永不命中", () => {
    const c = new FinalRunCache();
    c.remember("");
    expect(c.hasFinal("")).toBe(false);
  });

  it("恰 50 条不淘汰（gateway:549 `size > 50` 严格大于）", () => {
    const c = new FinalRunCache();
    for (let i = 0; i < 50; i++) c.remember(`run-${i}`);
    expect(c.size).toBe(50);
    expect(c.snapshot()[0]).toBe("run-0");
    expect(c.snapshot()[49]).toBe("run-49");
  });

  it("第 51 条触发淘汰：删插入序最旧的 run-0，size 保持 50", () => {
    const c = new FinalRunCache();
    for (let i = 0; i < 51; i++) c.remember(`run-${i}`);
    expect(c.size).toBe(50);
    expect(c.hasFinal("run-0")).toBe(false);
    expect(c.hasFinal("run-1")).toBe(true);
    expect(c.snapshot()[0]).toBe("run-1");
  });

  it("重复 add 不刷新插入序：是首次插入序 FIFO，不是刷新式 LRU", () => {
    const c = new FinalRunCache();
    c.remember("a");
    c.remember("b");
    c.remember("a"); // a 已存在，Set.add 是 no-op、a 仍是最旧
    for (let i = 0; i < 48; i++) c.remember(`f-${i}`); // 凑满 50：a,b,f-0..f-47
    expect(c.size).toBe(50);
    c.remember("z"); // 第 51 条 → 淘汰 a（若为刷新式 LRU 会淘汰 b）
    expect(c.hasFinal("a")).toBe(false);
    expect(c.hasFinal("b")).toBe(true);
  });

  it("满载后每次 remember 只淘汰一条（50→51→淘汰→50 循环）", () => {
    const c = new FinalRunCache();
    for (let i = 0; i < 50; i++) c.remember(`run-${i}`);
    for (let i = 50; i < 60; i++) {
      c.remember(`run-${i}`);
      expect(c.size).toBe(50);
      expect(c.hasFinal(`run-${i - 50}`)).toBe(false); // 最旧者持续被挤出
    }
  });

  it("差分：随机 300 条 runId 序列，模块输出与参照实现逐步一致", () => {
    let seed = 20261114;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const c = new FinalRunCache();
    const ref = new Set<string>();
    for (let i = 0; i < 300; i++) {
      // 混合 60% 新 id、30% 旧 id 重复 add、10% 空串，覆盖 FIFO 不刷新语义
      const roll = rand();
      const runId = roll < 0.1 ? "" : roll < 0.4 && ref.size > 0 ? [...ref][Math.floor(rand() * ref.size)] : `r-${i}`;
      c.remember(runId);
      refRememberFinalRun(ref, runId);
      expect(c.size).toBe(ref.size);
      expect(c.snapshot()).toEqual([...ref]);
      const probe = rand() < 0.5 ? undefined : runId === "" ? "r-x" : runId;
      expect(c.hasFinal(probe)).toBe(refFinalSeen(ref, probe));
    }
  });
});

describe("isDuplicateOfRecentMessage 边界语义（钉死 gateway.ts:520 现行行为）", () => {
  const msg = (role: string, text: string, atts?: number) => ({
    role,
    text,
    ...(atts === undefined ? {} : { attachments: new Array(atts) }),
  });

  it("9 条列表最旧一条（窗外）重复 → 不算重复（8 条窗滑动）", () => {
    const list = [msg("user", "old-dup"), ...Array.from({ length: 8 }, (_, i) => msg("user", `m${i}`))];
    expect(isDuplicateOfRecentMessage(list, "user", "old-dup")).toBe(false);
    expect(refRecentDup(list, "user", "old-dup")).toBe(false);
  });

  it("第 8 条（窗沿，slice(-8) 含）重复 → 命中", () => {
    const list = [msg("user", "m0"), ...Array.from({ length: 7 }, (_, i) => msg("user", `m${i + 1}`))];
    // list 共 8 条，"m0" 是第 8 条窗口内最后一条
    expect(isDuplicateOfRecentMessage(list, "user", "m0")).toBe(true);
  });

  it("恰好 8 条且全同 → 命中", () => {
    const list = Array.from({ length: 8 }, () => msg("user", "same"));
    expect(isDuplicateOfRecentMessage(list, "user", "same")).toBe(true);
  });

  it("不足 8 条（3 条）窗口=全表 → 命中", () => {
    const list = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    expect(isDuplicateOfRecentMessage(list, "assistant", "b")).toBe(true);
  });

  it("role 不同 → 不命中（user 事件不撞 assistant 消息）", () => {
    const list = [msg("user", "x")];
    expect(isDuplicateOfRecentMessage(list, "assistant", "x")).toBe(false);
  });

  it("text 不同 → 不命中", () => {
    const list = [msg("user", "hello")];
    expect(isDuplicateOfRecentMessage(list, "user", "hello!")).toBe(false);
  });

  it("附件数不同（0 vs 1）→ 不命中", () => {
    const list = [msg("user", "pic", 0)];
    expect(isDuplicateOfRecentMessage(list, "user", "pic", [{}])).toBe(false);
  });

  it("双方都无附件按 0===0 命中（现行不特判空附件）", () => {
    const list = [msg("user", "plain")];
    expect(isDuplicateOfRecentMessage(list, "user", "plain", undefined)).toBe(true);
  });

  it("附件数相同（1===1）→ 命中，不管内容差异", () => {
    const list = [msg("user", "pic", 1)];
    expect(isDuplicateOfRecentMessage(list, "user", "pic", [{ name: "另一个文件" }])).toBe(true);
  });

  it("atts=null 与 undefined 等价（可选链 ?? 0 收敛）", () => {
    const list = [msg("user", "plain")];
    expect(isDuplicateOfRecentMessage(list, "user", "plain", null)).toBe(true);
  });

  it("空 text + 空 role 也照三元组规则命中（现行不做空值豁免）", () => {
    const list = [msg("", "")];
    expect(isDuplicateOfRecentMessage(list, "", "")).toBe(true);
  });

  it("差分：随机 60 组（列表/role/text/附件数）与参照实现一致", () => {
    let seed = 88;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let g = 0; g < 60; g++) {
      const len = Math.floor(rand() * 12); // 0..11 条，跨 8 条窗沿
      const list = Array.from({ length: len }, () =>
        msg(rand() < 0.5 ? "user" : "assistant", `t${Math.floor(rand() * 4)}`, rand() < 0.3 ? Math.floor(rand() * 2) : undefined),
      );
      const role = rand() < 0.5 ? "user" : "assistant";
      const text = `t${Math.floor(rand() * 4)}`;
      const atts = rand() < 0.4 ? [{}] : rand() < 0.5 ? undefined : null;
      expect(isDuplicateOfRecentMessage(list, role, text, atts)).toBe(refRecentDup(list, role, text, atts));
    }
  });
});
