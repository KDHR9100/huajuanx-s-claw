// memory-timeline.ts 纯函数测试（2026-11-15 时间线卡）。
// 时钟纪律同仓库惯例：now 本地构造，ts 由本地 Date 生成，任何时区跑结果一致。
import { describe, it, expect } from "vitest";
import { buildTimeline, groupTimelineByDay, diaryTimelineItem, graphTimelineItem, truncateLine } from "../../server/lib/memory-timeline";
import type { TimelineItem } from "../../server/lib/memory-timeline";

const D = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime(); // 2026-11-XX 本地钟
const mk = (ts: number, source: TimelineItem["source"], title = `t-${ts}`, extra: Partial<TimelineItem> = {}): TimelineItem => ({ ts, source, title, ...extra });

describe("buildTimeline · 三类来源聚合与排序", () => {
  it("三类来源合并成一条流，来源原样保留", () => {
    const out = buildTimeline({
      diary: [mk(D(15, 9, 0), "diary", "复盘日记：十一月十五", { key: "diary:2026-11-15.md", excerpt: "今天主人在修 gateway" })],
      graph: [mk(D(15, 11, 47), "graph", "人物图谱更新：人物 12 · 事件 5 · 连线 3")],
      memory: [mk(D(15, 8, 0), "memory", "rp:memory:2026-09-09.md", { key: "rp:memory:2026-09-09.md" })],
    });
    expect(out.map((x) => x.source)).toEqual(["graph", "diary", "memory"]);
    expect(out[0].title).toContain("人物图谱更新");
    expect(out[1].key).toBe("diary:2026-11-15.md");
    expect(out[2].excerpt).toBeUndefined();
  });

  it("按 ts 降序（乱序输入也排好）", () => {
    const out = buildTimeline({
      memory: [mk(D(10, 12), "memory", "a"), mk(D(12, 8), "memory", "b"), mk(D(11, 23), "memory", "c")],
      diary: [mk(D(12, 9), "diary", "d")],
    });
    expect(out.map((x) => x.title)).toEqual(["d", "b", "c", "a"]); // d=12日9点 > b=12日8点 > c=11日 > a=10日
  });

  it("截断 50：60 条只留最新的 50 条", () => {
    const many = Array.from({ length: 60 }, (_, i) => mk(D(1, 0, i), "memory", `m${i}`)); // 同天逐分钟递增
    const out = buildTimeline({ memory: many });
    expect(out).toHaveLength(50);
    expect(out[0].title).toBe("m59");
    expect(out[49].title).toBe("m10");
  });

  it("缺一类源降级：graph 没有就只聚合另外两类，不炸不补", () => {
    const out = buildTimeline({
      diary: [mk(D(15, 9), "diary", "d1")],
      graph: null,
      memory: [mk(D(14, 8), "memory", "m1")],
    });
    expect(out.map((x) => x.source)).toEqual(["diary", "memory"]);
  });

  it("空态：三类全空 -> 空数组", () => {
    expect(buildTimeline({ diary: null, graph: null, memory: null })).toEqual([]);
    expect(buildTimeline({})).toEqual([]);
  });

  it("非法条目剔除：ts 非法/标题空白/来源未知/条目非对象", () => {
    const out = buildTimeline({
      memory: [
        mk(0, "memory", "ts0"),
        mk(-5, "memory", "负ts"),
        mk(D(15, 9), "memory", "   "),
        mk(D(15, 10), "memory", "好的"),
        { ts: D(15, 11), source: "hacker" as never, title: "未知来源" },
        null as never,
      ],
    });
    expect(out.map((x) => x.title)).toEqual(["好的"]);
  });
});

describe("groupTimelineByDay · 按天分组辅助", () => {
  it("今天/昨天/更早的 label 与组内条数；组按天降序", () => {
    const items = [
      mk(D(15, 14, 2), "diary", "a"),
      mk(D(15, 9, 15), "memory", "b"),
      mk(D(14, 22, 18), "memory", "c"),
      mk(D(14, 8, 40), "graph", "d"),
      mk(D(8, 12, 0), "diary", "e"),
    ];
    const groups = groupTimelineByDay(items, new Date(2026, 10, 15, 20, 0));
    expect(groups.map((g) => g.label)).toEqual(["今天", "昨天", "11-08"]);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(2);
    expect(groups[2].items).toHaveLength(1);
    expect(groups[0].day).toBe("2026-11-15");
    expect(groups[2].day).toBe("2026-11-08");
  });

  it("空列表 -> 空分组；非法 ts 跳过", () => {
    expect(groupTimelineByDay([], new Date(2026, 10, 15, 20, 0))).toEqual([]);
    const groups = groupTimelineByDay([mk(0, "memory", "x")], new Date(2026, 10, 15, 20, 0));
    expect(groups).toEqual([]);
  });
});

describe("diaryTimelineItem / graphTimelineItem · 条目构造", () => {
  it("日记：标题取首个 # 行，摘要取首个正文行并截断", () => {
    const it = diaryTimelineItem("diary:2026-11-15.md", "2026-11-15.md", D(15, 14), "# 十一月十五\n\n今天主人在修 gateway 的 draining 病，我陪他到凌晨三点多才睡下，过程很长很长。\n");
    expect(it!.title).toBe("复盘日记：十一月十五");
    expect(it!.excerpt).toBe("今天主人在修 gateway 的 draining 病，我陪他到凌晨三点多才睡下，过程很长很长。");
    expect(it!.key).toBe("diary:2026-11-15.md");
  });

  it("日记：没有 # 标题退回文件名；mtime 非法返回 null", () => {
    const it = diaryTimelineItem("diary:x.md", "x.md", D(15, 9), "正文第一行\n第二行");
    expect(it!.title).toBe("复盘日记：x.md");
    expect(it!.excerpt).toBe("正文第一行");
    expect(diaryTimelineItem("diary:x.md", "x.md", 0, "# 有标题")).toBe(null);
  });

  it("图谱：标题贴真实字段（三张表行数），摘要带最后核对", () => {
    const it = graphTimelineItem(D(15, 11), { people: [1, 2, 3], events: [1], links: [1, 2], lastChecked: "2026-11-01" });
    expect(it!.source).toBe("graph");
    expect(it!.title).toBe("人物图谱更新：人物 3 · 事件 1 · 连线 2 · 最后核对 2026-11-01");
    expect(it!.key).toBeUndefined(); // graph.md 不在记忆白名单，只读展示
    expect(graphTimelineItem(Number.NaN, { people: [] })).toBe(null);
  });
});

describe("truncateLine · 摘要截断", () => {
  it("压平空白并按上限截断加省略号", () => {
    expect(truncateLine("  a  b  ")).toBe("a b");
    expect(truncateLine("x".repeat(81))).toBe(`${"x".repeat(80)}…`);
    expect(truncateLine("x".repeat(80))).toHaveLength(80);
  });
});
