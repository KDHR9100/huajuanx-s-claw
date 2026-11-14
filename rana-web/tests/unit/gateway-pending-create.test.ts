// gateway.ts 临时 key 原语差分测试（体检卡4变形版：不碰 gateway.ts，只锁行为）。
// 差分方法：本文件内逐字复制 gateway.ts 现行分支作参照实现（见 ref* 函数，
// 仅把 this.pendingCreates 参数化为 map、静默 return 哨兵化为 null），
// 断言 src/lib/pendingCreateKeys.ts 的输出与参照一致，再钉死边界语义。
import { describe, it, expect } from "vitest";
import {
  isPendingCreateKey,
  makePendingCreateKey,
  resolvePendingCreateKeyForSend,
  resolvePendingCreateKeyForDelete,
  mergeSessionListWithPending,
  computeMigratedSessionFields,
} from "../../src/lib/pendingCreateKeys";

// ── 参照实现（逐字复制自 gateway.ts:675-683 sendChat 取 key 分支）──
async function refResolveForSend(map: Map<string, Promise<string>>, sessionKey: string): Promise<string | null> {
  let key = sessionKey;
  if (key.startsWith("pending-create:")) {
    const p = map.get(key);
    if (!p) return null; // gateway:677 `if (!p) return;`（创建已失败被清理 → 静默放弃）
    try {
      key = await p;
    } catch {
      return null; // gateway:682 catch → 静默放弃
    }
  }
  return key;
}

// ── 参照实现（逐字复制自 gateway.ts:832-838 deleteSession 取 key 分支）──
async function refResolveForDelete(map: Map<string, Promise<string>>, sessionKey: string): Promise<string | null> {
  let key = sessionKey;
  if (key.startsWith("pending-create:")) {
    const p = map.get(key);
    if (!p) return null; // gateway:834 `if (!p) return;`
    const real = await p.catch(() => "");
    if (!real) return null; // gateway:836 `if (!real) return;`
    key = real;
  }
  return key;
}

// ── 参照实现（逐字复制自 gateway.ts:591-594 refreshSessions 占位行保留）──
function refMergePendingRows<R extends { key: string }>(sessions: readonly R[], kept: R[]): R[] {
  const pendingRows = sessions.filter(
    (x) => x.key.startsWith("pending-create:") && !kept.some((m) => m.key === x.key),
  );
  return pendingRows.length ? [...pendingRows, ...kept] : kept;
}

// ── 参照实现（逐字复制自 gateway.ts:802-809 migratePendingSession 字段映射）──
function refMigratedFields(row: Record<string, unknown>) {
  return {
    title: (row.displayName as string) ?? (row.derivedTitle as string) ?? "新会话",
    model: row.model as string | undefined,
    sessionId: row.sessionId ? String(row.sessionId) : undefined,
  };
}

describe("isPendingCreateKey / makePendingCreateKey（gateway.ts:771/534/675/818/832 判定）", () => {
  it("前缀命中", () => {
    expect(isPendingCreateKey("pending-create:abc-123")).toBe(true);
  });

  it("普通会话 key 不命中", () => {
    expect(isPendingCreateKey("main")).toBe(false);
    expect(isPendingCreateKey("agent-main:s-1")).toBe(false);
  });

  it("恰好等于前缀本身 → true（startsWith 语义）", () => {
    expect(isPendingCreateKey("pending-create:")).toBe(true);
  });

  it("空串 / 无冒号 / 大小写不同 / 中间含前缀 → false", () => {
    expect(isPendingCreateKey("")).toBe(false);
    expect(isPendingCreateKey("pending-create")).toBe(false);
    expect(isPendingCreateKey("Pending-create:x")).toBe(false);
    expect(isPendingCreateKey("x-pending-create:y")).toBe(false);
  });

  it("makePendingCreateKey 与 gateway:771 `pending-create:${uuid}` 形状一致", () => {
    expect(makePendingCreateKey("uuid-value")).toBe("pending-create:uuid-value");
    expect(isPendingCreateKey(makePendingCreateKey("uuid-value"))).toBe(true);
  });
});

describe("resolvePendingCreateKeyForSend（gateway.ts:675-683 差分）", () => {
  it("非 pending key 原样返回，不查 map", async () => {
    const map = new Map<string, Promise<string>>();
    await expect(resolvePendingCreateKeyForSend(map, "s-real")).resolves.toBe("s-real");
    expect(map.size).toBe(0);
  });

  it("map 无该占位 key → null（gateway:677 静默放弃：创建已失败被清理）", async () => {
    await expect(resolvePendingCreateKeyForSend(new Map(), "pending-create:g1")).resolves.toBeNull();
  });

  it("promise resolve → 返回服务端真实 key", async () => {
    const map = new Map([["pending-create:g2", Promise.resolve("s-real-2")]] as const);
    await expect(resolvePendingCreateKeyForSend(map, "pending-create:g2")).resolves.toBe("s-real-2");
  });

  it("promise reject → null（gateway:681 catch，发送静默放弃）", async () => {
    const map = new Map([["pending-create:g3", Promise.reject(new Error("create fail"))]] as const);
    await expect(resolvePendingCreateKeyForSend(map, "pending-create:g3")).resolves.toBeNull();
  });

  it("promise resolve(\"\") → 透传空串（send 侧现行语义，与 delete 侧的差异点）", async () => {
    const map = new Map([["pending-create:g4", Promise.resolve("")]] as const);
    await expect(resolvePendingCreateKeyForSend(map, "pending-create:g4")).resolves.toBe("");
  });

  it("未决 promise → 等待创建完成（sendChat 期间拿到真实 key 再发送）", async () => {
    let release!: (v: string) => void;
    const deferred = new Promise<string>((r) => { release = r; });
    const map = new Map([["pending-create:g5", deferred]] as const);
    const p = resolvePendingCreateKeyForSend(map, "pending-create:g5");
    release("s-late");
    await expect(p).resolves.toBe("s-late");
  });

  it("差分：send 侧 6 组场景与参照实现一致", async () => {
    const map = new Map<string, Promise<string>>([
      ["pending-create:d1", Promise.resolve("r1")],
      ["pending-create:d2", Promise.reject(new Error("x"))],
      ["pending-create:d3", Promise.resolve("")],
      ["pending-create:d4", Promise.resolve("r4")],
    ]);
    const cases = ["s-real", "pending-create:d1", "pending-create:d2", "pending-create:d3", "pending-create:missing", "pending-create:d4"];
    for (const k of cases) {
      expect(await resolvePendingCreateKeyForSend(map, k)).toBe(await refResolveForSend(map, k));
    }
  });
});

describe("resolvePendingCreateKeyForDelete（gateway.ts:832-838 差分）", () => {
  it("非 pending key 原样返回，不查 map", async () => {
    await expect(resolvePendingCreateKeyForDelete(new Map(), "s-real")).resolves.toBe("s-real");
  });

  it("map 无该占位 key → null（gateway:834：创建已失败被清理，无需再删）", async () => {
    await expect(resolvePendingCreateKeyForDelete(new Map(), "pending-create:h1")).resolves.toBeNull();
  });

  it("promise resolve → 返回真实 key（删除目标迁移到真实会话）", async () => {
    const map = new Map([["pending-create:h2", Promise.resolve("s-real-2")]] as const);
    await expect(resolvePendingCreateKeyForDelete(map, "pending-create:h2")).resolves.toBe("s-real-2");
  });

  it("promise reject → null（gateway:836 catch(() => \"\") → !real → 放弃）", async () => {
    const map = new Map([["pending-create:h3", Promise.reject(new Error("gone"))]] as const);
    await expect(resolvePendingCreateKeyForDelete(map, "pending-create:h3")).resolves.toBeNull();
  });

  it("promise resolve(\"\") → null（与 send 侧透传空串的差异点，`if (!real)` 钉死）", async () => {
    const map = new Map([["pending-create:h4", Promise.resolve("")]] as const);
    await expect(resolvePendingCreateKeyForDelete(map, "pending-create:h4")).resolves.toBeNull();
  });

  it("未决 promise → 等待创建完成再返回真实 key", async () => {
    let release!: (v: string) => void;
    const deferred = new Promise<string>((r) => { release = r; });
    const map = new Map([["pending-create:h5", deferred]] as const);
    const p = resolvePendingCreateKeyForDelete(map, "pending-create:h5");
    release("s-late");
    await expect(p).resolves.toBe("s-late");
  });

  it("差分：delete 侧 6 组场景与参照实现一致", async () => {
    const map = new Map<string, Promise<string>>([
      ["pending-create:e1", Promise.resolve("r1")],
      ["pending-create:e2", Promise.reject(new Error("x"))],
      ["pending-create:e3", Promise.resolve("")],
      ["pending-create:e4", Promise.resolve("r4")],
    ]);
    const cases = ["s-real", "pending-create:e1", "pending-create:e2", "pending-create:e3", "pending-create:missing", "pending-create:e4"];
    for (const k of cases) {
      expect(await resolvePendingCreateKeyForDelete(map, k)).toBe(await refResolveForDelete(map, k));
    }
  });
});

describe("mergeSessionListWithPending（gateway.ts:591-594 差分）", () => {
  const row = (key: string) => ({ key, title: key });

  it("占位会话不在服务端列表 → 保留且排在最前（防刷新冲掉）", () => {
    const current = [row("pending-create:p1"), row("s-a")];
    const server = [row("s-a"), row("s-b")];
    const out = mergeSessionListWithPending(current, server);
    expect(out.map((r) => r.key)).toEqual(["pending-create:p1", "s-a", "s-b"]);
    expect(out).toEqual(refMergePendingRows(current, server));
  });

  it("占位会话已被服务端返回 → 不保留（不重复）", () => {
    const current = [row("pending-create:p1"), row("s-a")];
    const server = [row("s-a"), row("pending-create:p1")];
    const out = mergeSessionListWithPending(current, server);
    expect(out.map((r) => r.key)).toEqual(["s-a", "pending-create:p1"]);
    expect(out).toEqual(refMergePendingRows(current, server));
  });

  it("无占位会话 → 返回 kept 本体（pendingRows.length===0 分支，原引用透传）", () => {
    const current = [row("s-a"), row("s-b")];
    const kept = [row("s-a")];
    const out = mergeSessionListWithPending(current, kept);
    expect(out).toBe(kept); // 现行实现 setSessions(kept) 传的就是 kept 本身
  });

  it("多个占位会话保持 store 原顺序，全部置于服务端行之前", () => {
    const current = [row("s-a"), row("pending-create:p2"), row("pending-create:p1")];
    const server = [row("s-a"), row("s-b")];
    const out = mergeSessionListWithPending(current, server);
    expect(out.map((r) => r.key)).toEqual(["pending-create:p2", "pending-create:p1", "s-a", "s-b"]);
  });

  it("差分：随机 40 组（current/server 行随机组合）与参照实现一致", () => {
    let seed = 5150;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let g = 0; g < 40; g++) {
      const nCur = Math.floor(rand() * 6);
      const nSrv = Math.floor(rand() * 6);
      const current = Array.from({ length: nCur }, (_, i) =>
        row(rand() < 0.45 ? `pending-create:r${Math.floor(rand() * 3)}` : `s-c${i}`),
      );
      const server = Array.from({ length: nSrv }, (_, i) =>
        row(rand() < 0.3 ? `pending-create:r${Math.floor(rand() * 3)}` : `s-s${i}`),
      );
      expect(mergeSessionListWithPending(current, server)).toEqual(refMergePendingRows(current, server));
    }
  });
});

describe("computeMigratedSessionFields（gateway.ts:802-809 差分）", () => {
  it("displayName 优先于 derivedTitle", () => {
    const out = computeMigratedSessionFields({ displayName: "显式名", derivedTitle: "派生名" });
    expect(out.title).toBe("显式名");
  });

  it("无 displayName 时回退 derivedTitle", () => {
    const out = computeMigratedSessionFields({ derivedTitle: "派生名" });
    expect(out.title).toBe("派生名");
  });

  it("两者都无 → 默认「新会话」", () => {
    expect(computeMigratedSessionFields({}).title).toBe("新会话");
  });

  it("displayName 为 null 也走回退链（?? 语义）", () => {
    const out = computeMigratedSessionFields({ displayName: null, derivedTitle: "派生名" });
    expect(out.title).toBe("派生名");
  });

  it("model 直传；无 model 为 undefined", () => {
    expect(computeMigratedSessionFields({ model: "gpt-x" }).model).toBe("gpt-x");
    expect(computeMigratedSessionFields({}).model).toBeUndefined();
  });

  it("sessionId 数字 → 归一化为字符串；缺失/空串 → undefined（gateway:808 falsy 判定）", () => {
    expect(computeMigratedSessionFields({ sessionId: 42 }).sessionId).toBe("42");
    expect(computeMigratedSessionFields({ sessionId: "sid-1" }).sessionId).toBe("sid-1");
    expect(computeMigratedSessionFields({}).sessionId).toBeUndefined();
    expect(computeMigratedSessionFields({ sessionId: "" }).sessionId).toBeUndefined();
  });

  it("差分：随机 40 组 row 对象与参照实现一致", () => {
    let seed = 9090;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let g = 0; g < 40; g++) {
      const row: Record<string, unknown> = {};
      if (rand() < 0.5) row.displayName = `dn-${Math.floor(rand() * 3)}`;
      if (rand() < 0.5) row.derivedTitle = `dt-${Math.floor(rand() * 3)}`;
      if (rand() < 0.5) row.model = `m-${Math.floor(rand() * 3)}`;
      if (rand() < 0.6) row.sessionId = rand() < 0.3 ? Math.floor(rand() * 100) : `sid-${Math.floor(rand() * 3)}`;
      expect(computeMigratedSessionFields(row)).toEqual(refMigratedFields(row));
    }
  });
});
