// server/lib/guard-light.ts 用例（2026-11-15 状态页亮灯接线）。
// 纯函数直测：零依赖零顶层 I/O（11-15 CI 案教训——测试 import 生产模块不许触发
// 顶层 I/O，本模块天然合规）；时间一律注入 now，不碰真实时钟。
import { describe, it, expect } from "vitest";
import { guardLight } from "../../server/lib/guard-light";

/** 固定「现在」，所有用例共享：2026-11-15T12:00:00Z */
const NOW = Date.parse("2026-11-15T12:00:00.000Z");

/** 造一条台账违规（形状=recordViolation 写出的 { at, contract, file, reasons }） */
const vio = (contract: string, at: string, problem = "字段 x 应为 string") => ({
  at,
  contract,
  file: "f.json",
  reasons: [problem],
});

describe("契约守卫灯 guardLight", () => {
  it("空台账/读不到：绿灯零违规零累计（null/undefined/空对象/recent 空数组）", () => {
    for (const raw of [null, undefined, {}, { recent: [] }, { updatedAt: "2026-11-15T12:00:00.000Z", total: 0, recent: [] }]) {
      expect(guardLight(raw, NOW)).toEqual({ lamp: "green", violations: [], total: 0 });
    }
  });

  it("有违规：红灯 + total 累计 + 条目三件套（contract/at/problem 一行）", () => {
    const g = guardLight(
      {
        updatedAt: "2026-11-15T09:00:00.000Z",
        total: 2,
        recent: [
          vio("news/report", "2026-11-15T08:00:00.000Z"),
          vio("health/patrol", "2026-11-15T09:00:00.000Z", "缺必填字段 checks"),
        ],
      },
      NOW,
    );
    expect(g.lamp).toBe("red");
    expect(g.total).toBe(2);
    expect(g.violations).toEqual([
      { contract: "health/patrol", at: "2026-11-15T09:00:00.000Z", problem: "缺必填字段 checks" },
      { contract: "news/report", at: "2026-11-15T08:00:00.000Z", problem: "字段 x 应为 string" },
    ]);
  });

  it("截断最近 10 条：30 条台账只出时间最新的 10 条（倒序）", () => {
    const recent = Array.from({ length: 30 }, (_, i) =>
      vio(`c/${i}`, new Date(NOW - (30 - i) * 60_000).toISOString()),
    ); // i 越大越新
    const g = guardLight({ total: 30, recent }, NOW);
    expect(g.violations).toHaveLength(10);
    expect(g.violations[0].contract).toBe("c/29");
    expect(g.violations[9].contract).toBe("c/20");
  });

  it("坏形状降级绿灯不炸：recent 非数组 / 条目全是垃圾 / 顶层数组", () => {
    for (const raw of [
      { recent: "x" },
      { recent: [null, 3, "s", []] },
      { recent: [{}] }, // 空对象条目=认不出违规字段，按垃圾处理 → 绿
      [1, 2],
      "garbage",
      42,
    ]) {
      expect(guardLight(raw, NOW)).toEqual({ lamp: "green", violations: [], total: 0 });
    }
  });

  it("时间排序：乱序台账倒序输出；烂时间戳沉底；多条未来时间戳按台账顺序稳定排列（按 now 封顶）", () => {
    const mixed = guardLight(
      {
        total: 5,
        recent: [
          vio("a", "2026-11-15T10:00:00.000Z"),
          vio("junk", "not-a-time"),
          vio("b", "2026-11-15T08:00:00.000Z"),
          vio("c", "2026-11-15T09:00:00.000Z"),
        ],
      },
      NOW,
    );
    expect(mixed.violations.map((v) => v.contract)).toEqual(["a", "c", "b", "junk"]);
    const capped = guardLight(
      {
        total: 3,
        recent: [
          vio("y", "9999-01-01T00:00:00.000Z"),
          vio("x", "9999-06-01T00:00:00.000Z"),
          vio("real", "2026-11-15T10:00:00.000Z"),
        ],
      },
      NOW,
    );
    // 两条烂钟未来记录被封顶到同一时刻 → 保持台账顺序，不按假时间乱窜
    expect(capped.violations.map((v) => v.contract)).toEqual(["y", "x", "real"]);
  });

  it("total 烂数字：回退用 recent 条数兜底，不出 NaN；垃圾条目缺失字段补空串不丢条目", () => {
    const g = guardLight(
      { total: "many", recent: [vio("a", "2026-11-15T08:00:00.000Z"), vio("b", "2026-11-15T09:00:00.000Z")] },
      NOW,
    );
    expect(g.total).toBe(2);
    expect(g.lamp).toBe("red");
    const ragged = guardLight({ total: 1, recent: [{ contract: "", reasons: "裸串", other: 1 }] }, NOW);
    expect(ragged.violations).toEqual([{ contract: "未知契约", at: "", problem: "裸串" }]);
  });
});
