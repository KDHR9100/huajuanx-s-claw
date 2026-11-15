// 用量聚合规则守门测试：事件白名单（防双计）/分桶/模型归属/合并。
// 时区口径：构造与断言全用本地 Date，与 bucketDate 同源（无 UTC 串混用）。
import { describe, expect, it } from "vitest";
import {
  bucketDate,
  readUsage,
  parseRuntimeEvents,
  aggregateParsedEvents,
  mergeDayBuckets,
  mergeSessionBuckets,
  type RuntimeEventRow,
} from "../../server/lib/usage-aggregate";

/** 构造一条 runtime 事件行（1-based 语义与库内一致：created_at 毫秒） */
function row(type: string, created_at: number, extra: Record<string, unknown> = {}, runId = "r1"): RuntimeEventRow {
  return {
    run_id: runId,
    created_at,
    event_json: JSON.stringify({ type, ts: new Date(created_at).toISOString(), sessionKey: "agent:main:main", ...extra }),
  };
}

const T0 = new Date(2026, 10, 8, 13, 5).getTime(); // 本地 2026-11-08 13:05
const U = { data: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoningTokens: 10, total: 150 } } };

describe("bucketDate", () => {
  it("本地时区日期键 + 跨天边界", () => {
    expect(bucketDate(T0)).toBe("2026-11-08");
    expect(bucketDate(new Date(2026, 10, 8, 23, 59, 59, 999).getTime())).toBe("2026-11-08");
    expect(bucketDate(new Date(2026, 10, 8, 24, 0, 0).getTime())).toBe("2026-11-09");
  });
});

describe("readUsage", () => {
  it("认两种键名 + total 缺失回退", () => {
    expect(readUsage({ input: 100, output: 50, total: 150 })).toMatchObject({ total: 150 });
    expect(readUsage({ input: 100, output: 50, totalTokens: 150 })).toMatchObject({ total: 150 });
    expect(readUsage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })?.total).toBe(100);
  });
  it("负数与 NaN 归 0，非对象返回 undefined", () => {
    expect(readUsage({ input: -5, output: Number.NaN }).total).toBe(0);
    expect(readUsage("x")).toBeUndefined();
  });
});

describe("parseRuntimeEvents + aggregateParsedEvents", () => {
  it("只认 model.completed（防双计）", () => {
    const events = parseRuntimeEvents("main", [
      row("prompt.submitted", T0, { modelId: "glm-5.3-flash" }),
      row("model.completed", T0 + 1000, U),
      row("assistant.message", T0 + 1100, U),
    ]);
    const { days, sessions } = aggregateParsedEvents(events);
    const au = days["2026-11-08"].main;
    expect(au.runs).toBe(1);
    expect(au.total).toBe(150);
    expect(au.models["glm-5.3-flash"]).toBe(150);
  });
  it("模型归属：run 内第一条带 modelId 的事件定模型；归属不到记 (unknown)", () => {
    const events = parseRuntimeEvents("main", [
      row("trace.metadata", T0 + 5000, { modelId: "m2" }, "r2"),
      row("prompt.submitted", T0, { modelId: "m1" }, "r1"),
      row("model.completed", T0 + 1000, U, "r1"),
      row("model.completed", T0 + 6000, U, "r2"),
    ]);
    const { days } = aggregateParsedEvents(events);
    const au = days["2026-11-08"].main;
    expect(au.models["m1"]).toBe(150);
    expect(au.models["m2"]).toBe(150);
  });

  it("归属不到的 run 记 (unknown)", () => {
    const events = parseRuntimeEvents("main", [row("model.completed", T0, U, "r9")]);
    const { days } = aggregateParsedEvents(events);
    expect(days["2026-11-08"].main.models["(unknown)"]).toBe(150);
  });

  it("分天分桶 + 会话桶按 sessionKey 累计", () => {
    const events = parseRuntimeEvents("main", [
      row("model.completed", T0, U, "r1"),
      row("model.completed", T0 + 86_400_000, U, "r2"),
    ]);
    const { days, sessions } = aggregateParsedEvents(events);
    expect(days["2026-11-08"].main.total).toBe(150);
    expect(days["2026-11-09"].main.total).toBe(150);
    const s = sessions["agent:main:main"];
    expect(s.total).toBe(300);
    expect(s.runs).toBe(2);
    expect(s.firstTs).toBe(T0);
    expect(s.lastTs).toBe(T0 + 86_400_000);
  });
});

describe("mergeDayBuckets / mergeSessionBuckets", () => {
  it("增量并入：两组不同事件求和正确（幂等性由调用方水位保证，同源喂两次会翻倍）", () => {
    const { days, sessions } = aggregateParsedEvents(parseRuntimeEvents("main", [row("model.completed", T0, U, "r1")]));
    const { days: d2, sessions: s2 } = aggregateParsedEvents(parseRuntimeEvents("main", [row("model.completed", T0 + 1000, U, "r2")]));
    const ledger = { days: {}, sessions: {} };
    mergeDayBuckets(ledger.days as never, days);
    mergeDayBuckets(ledger.days as never, d2);
    mergeSessionBuckets(ledger.sessions as never, sessions);
    mergeSessionBuckets(ledger.sessions as never, s2);
    expect(ledger.days["2026-11-08"].main.total).toBe(300);
    expect(ledger.sessions["agent:main:main"].total).toBe(300);
  });
});
