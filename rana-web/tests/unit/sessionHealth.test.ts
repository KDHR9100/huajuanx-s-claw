// server/lib/session-health.ts 用例（2026-11-15 会话健康哨兵新卡）。
// fixture 用 new DatabaseSync(':memory:') 建表灌假行（列形状 = 2026-11-15 main 库实查投影
// + rowid），零顶层 I/O（11-15 CI 案教训），时间一律用固定常量断言，不碰真实时钟。
// 口径（11-15 主人真数据拍板修正）：每 session_key 取最新窗口判定——最新窗口 failed=
// 真坏死（sick）；被新窗口顶掉的老 failed=伤疤（healedFailed），不算病。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  aggregateSessionWindows,
  buildSessionHealth,
  readAgentSessionWindows,
  unknownAgent,
} from "../../server/lib/session-health";
import type { SessionWindowRow } from "../../server/lib/session-health";

/** 建 fixture 库：withTable=false 模拟「表不存在」的库（unknown 降级用例）；rowid 天然自带 */
function makeDb(withTable = true): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  if (withTable) {
    db.exec(
      "CREATE TABLE session_windows (session_key TEXT NOT NULL, status TEXT, created_at INTEGER, updated_at INTEGER, ended_at INTEGER, display_name TEXT)",
    );
  }
  return db;
}

/** 灌行（形状与 readAgentSessionWindows 的 SQL 投影一致；rid 由库分配，插入序递增） */
function insertRows(db: DatabaseSync, rows: Array<Omit<SessionWindowRow, "rid">>): void {
  for (const r of rows) {
    db.prepare(
      "INSERT INTO session_windows (session_key, status, created_at, updated_at, ended_at, display_name) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(r.session_key, r.status, r.created_at, r.updated_at, r.ended_at, r.display_name);
  }
}

const row = (
  session_key: string,
  status: string | null,
  created_at: number | null = null,
  updated_at: number | null = null,
  ended_at: number | null = null,
  display_name: string | null = null,
): Omit<SessionWindowRow, "rid"> => ({ session_key, status, created_at, updated_at, ended_at, display_name });

/** 固定「检查时刻」，所有灯判定用例共享 */
const CHECKED_AT = Date.parse("2026-11-15T12:00:00.000Z");

describe("aggregateSessionWindows（行数组 → 单 agent 统计，最新窗口口径）", () => {
  it("核心口径：同 session_key 先 failed 后 done——伤疤不算病（sick=0）；另一 key 最新 failed——算病（sick=1）", () => {
    const healed = aggregateSessionWindows("main", "Rana (Work)", [
      row("agent:main:main:heartbeat", "failed", 1000, 1001, 1002), // 老窗口 failed
      row("agent:main:main:heartbeat", "done", 2000, 2001, 2002), // 新窗口顶掉 → 已愈合
    ]);
    expect(healed.sick).toBe(0);
    expect(healed.healedFailed).toBe(1);
    expect(healed.lastFailedKey).toBeNull();
    expect(healed.total).toBe(2);

    const sick = aggregateSessionWindows("main", "Rana (Work)", [
      row("agent:main:main:heartbeat", "failed", 1000, 1001, 1002),
      row("agent:main:main:heartbeat", "done", 2000, 2001, 2002),
      row("agent:main:web:chat", "failed", 3000, 3001, 3002, "网页聊天"), // 最新窗口本身 failed
    ]);
    expect(sick.sick).toBe(1);
    expect(sick.healedFailed).toBe(1);
    expect(sick.sickRows).toEqual([{ sessionKey: "agent:main:web:chat", name: "网页聊天", lastFailedAt: 3001 }]);
    expect(sick.lastFailedKey).toBe("agent:main:web:chat");
  });

  it("并列 created_at 用 rowid 兜底：同 key 两代同刻创建，rowid 大（后插入）的窗口说话", () => {
    const db = makeDb();
    try {
      insertRows(db, [
        row("agent:main:web:chat", "done", 1000, 1001, 1002),
        row("agent:main:web:chat", "failed", 1000, 2000, 2001), // 同 created_at，后插入 → 最新
      ]);
      const rows = readAgentSessionWindows(db)!;
      const a = aggregateSessionWindows("main", "Rana (Work)", rows);
      expect(a.sick).toBe(1);
      expect(a.sickRows![0].lastFailedAt).toBe(2000);
    } finally {
      db.close();
    }
    const db2 = makeDb();
    try {
      insertRows(db2, [
        row("agent:main:web:chat", "failed", 1000, 2000, 2001),
        row("agent:main:web:chat", "done", 1000, 3000, 3001), // 同刻但 done 在后 → 最新是 done，不算病
      ]);
      const a2 = aggregateSessionWindows("main", "Rana (Work)", readAgentSessionWindows(db2)!);
      expect(a2.sick).toBe(0);
      expect(a2.healedFailed).toBe(1);
    } finally {
      db2.close();
    }
  });

  it("非 failed 终态全不算病：done/running/timeout/killed/null → sick=0（永不误报）", () => {
    const a = aggregateSessionWindows("main", "Rana (Work)", [
      row("agent:main:main:heartbeat", "done", 1000, 1001),
      row("agent:main:cron:x", "running", 2000),
      row("agent:main:dashboard:y", null, 3000),
      row("agent:main:cron:z", "timeout", 4000, 4001, 4600),
      row("agent:main:cron:k", "killed", 5000, 5001, 5600),
    ]);
    expect(a.total).toBe(5);
    expect(a.sick).toBe(0);
    expect(a.healedFailed).toBeUndefined();
    expect(a.sickRows).toBeUndefined();
  });

  it("多 key 真坏死：sick=不同 key 数、明细按最近 failed 时间降序（updated_at 优先 ended_at 兜底）", () => {
    const a = aggregateSessionWindows("main", "Rana (Work)", [
      row("agent:main:web:older", "failed", 1000, 2000, 2001, "旧伤"), // 新窗口没来，它就是最新 → 病
      row("agent:main:web:fresh", "failed", 1500, 5000, 5001, "新伤"), // 时间最新的排前
      row("agent:main:web:ok", "done", 9000, 9001), // 健康窗口不掺和
    ]);
    expect(a.sick).toBe(2);
    expect(a.sickRows).toEqual([
      { sessionKey: "agent:main:web:fresh", name: "新伤", lastFailedAt: 5000 },
      { sessionKey: "agent:main:web:older", name: "旧伤", lastFailedAt: 2000 },
    ]);
    expect(a.lastFailedKey).toBe("agent:main:web:fresh");
  });

  it("烂时间戳兜底：failed 行 updated_at 烂 → ended_at 顶上；全烂 → lastFailedAt=null 但 sick 计数与 key 保留", () => {
    const fallback = aggregateSessionWindows("main", "Rana (Work)", [
      row("agent:main:main:heartbeat", "failed", 1000, null, 1794747600781),
    ]);
    expect(fallback.sick).toBe(1);
    expect(fallback.lastFailedAt).toBe(1794747600781);
    const allRotten = aggregateSessionWindows("main", "Rana (Work)", [
      row("agent:main:main:heartbeat", "failed", null, null, null),
      row("agent:main:cron:junk", "failed", null, -5, 0),
    ]);
    expect(allRotten.sick).toBe(2); // created_at 全烂 → rowid 兜底，两条各自成 key
    expect(allRotten.lastFailedAt).toBeNull();
    expect(allRotten.lastFailedKey).toBe("agent:main:main:heartbeat"); // 首条兜底：哪个窗口坏了可见
  });

  it("空表：total=0 sick=0 灯绿（openclaw 库真实形态，空≠病）", () => {
    const a = aggregateSessionWindows("openclaw", "openclaw", []);
    expect(a.total).toBe(0);
    expect(a.sick).toBe(0);
    expect(a.lastFailedAt).toBeNull();
  });

  it("明细截断：30 个真坏死 key 只出最近 20 条，sick 仍=30（计数不失真）", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row(`agent:main:web:${i}`, "failed", 1000 + i, 2000 + i, 2001 + i),
    );
    const a = aggregateSessionWindows("main", "Rana (Work)", rows);
    expect(a.sick).toBe(30);
    expect(a.sickRows).toHaveLength(20);
    expect(a.sickRows![0].sessionKey).toBe("agent:main:web:29");
    expect(a.sickRows![19].sessionKey).toBe("agent:main:web:10");
  });
});

describe("buildSessionHealth（agent 数组 → 灯 + 排序）", () => {
  it("灯判定：全绿→green；任一 sick>0→red；全 unknown/空清单→gray（不冤枉不漏报）", () => {
    const green = buildSessionHealth(
      [
        aggregateSessionWindows("main", "Rana (Work)", [row("k", "done")]),
        aggregateSessionWindows("rana-rp", "Rana (RP)", [row("k", "timeout", 1, 2)]),
      ],
      CHECKED_AT,
    );
    expect(green.lamp).toBe("green");
    const red = buildSessionHealth(
      [
        aggregateSessionWindows("main", "Rana (Work)", [row("k", "failed", 1000, 1001)]),
        aggregateSessionWindows("rana-rp", "Rana (RP)", []),
      ],
      CHECKED_AT,
    );
    expect(red.lamp).toBe("red");
    for (const gray of [buildSessionHealth([], CHECKED_AT), buildSessionHealth([unknownAgent("x", "x")], CHECKED_AT)]) {
      expect(gray.lamp).toBe("gray");
      expect(gray.agents.every((a) => a.unknown)).toBe(true);
    }
  });

  it("多 agent 排序：有病的在前按最近坏死时间降序，绿的居中保原序，unknown 殿后", () => {
    const newer = aggregateSessionWindows("main", "Rana (Work)", [row("agent:main:main:heartbeat", "failed", 1000, 2000)]);
    const older = aggregateSessionWindows("rana-qq-public", "Rana (QQ Public)", [
      row("agent:rana-qq-public:cron:x", "failed", 1000, 1001),
    ]);
    const healthy = aggregateSessionWindows("openclaw", "openclaw", [row("k", "done")]);
    const rottenClock = aggregateSessionWindows("rana-rp", "Rana (RP)", [row("agent:rana-rp:cron:y", "failed", null, null, null)]);
    const dead = unknownAgent("ghost", "Ghost");
    const h = buildSessionHealth([healthy, dead, rottenClock, newer, older], CHECKED_AT);
    expect(h.agents.map((a) => a.id)).toEqual(["main", "rana-qq-public", "rana-rp", "openclaw", "ghost"]);
    expect(h.lamp).toBe("red"); // 烂钟的真坏死仍算红（时间说不上来但病是真的）
  });
});

describe("readAgentSessionWindows（单库只读查询，:memory: 走真 SQL）", () => {
  it("表存在：返回投影行（含 rid/created_at）且喂给聚合函数全链路通；表缺失：null（不炸）", () => {
    const db = makeDb();
    try {
      insertRows(db, [
        row("agent:main:main:heartbeat", "failed", 100, 1794747600781, 1794747600999, "网页聊天主窗"),
        row("agent:main:main:ok", "done", 200, 1, 2),
      ]);
      const rows = readAgentSessionWindows(db);
      expect(rows).not.toBeNull();
      expect(rows).toHaveLength(2);
      expect(rows![0].rid).toBe(1);
      const a = aggregateSessionWindows("main", "Rana (Work)", rows!);
      expect(a.sick).toBe(1);
      expect(a.sickRows![0].name).toBe("网页聊天主窗");
      expect(a.lastFailedAt).toBe(1794747600781);
    } finally {
      db.close();
    }
    const noTable = makeDb(false);
    try {
      expect(readAgentSessionWindows(noTable)).toBeNull();
    } finally {
      noTable.close();
    }
  });

  it("unknown 降级进灯：其余库健康时 green（灰小灯只挂 unknown 行），不为一个坏库冤枉全员", () => {
    const dead = unknownAgent("ghost", "Ghost");
    const ok = aggregateSessionWindows("main", "Rana (Work)", [row("k", "done")]);
    const h = buildSessionHealth([ok, dead], CHECKED_AT);
    expect(h.lamp).toBe("green");
    expect(h.agents[h.agents.length - 1].id).toBe("ghost");
  });
});
