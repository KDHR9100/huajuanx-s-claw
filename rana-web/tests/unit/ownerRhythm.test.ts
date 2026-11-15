// owner-rhythm.ts 纯函数测试 + owner-status.mjs 日切 history 追加测试（2026-11-15 作息卡）。
// 时钟纪律同 owner-status.test.mjs：now 一律本地构造（new Date(2026,10,8,...)），ISO 串由本地钟生成，
// 不写死 +08:00 / Z 后缀偏移——CI(UTC) 上跑结果一致。
import { describe, it, expect } from "vitest";
import { buildOwnerRhythm, nightWindowBefore } from "../../server/lib/owner-rhythm";
import { updateUsage, emptyUsage } from "../../owner-status.mjs";

const D = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m); // 2026-11-XX 本地钟
const iso = (d: Date) => d.toISOString();

describe("buildOwnerRhythm · 今日 Top5", () => {
  it("按分钟降序截断到 5 条，0 分钟与无名条目剔除", () => {
    const r = buildOwnerRhythm({
      usage: {
        day: "2026-11-15",
        focusMinutes: { msedge: 192, QQ: 108, "Code.exe": 82, 三角洲行动: 46, explorer: 21, steam: 0, "": 5, cloudmusic: 2 },
      },
      state: null,
      config: null,
      now: D(15, 20, 0),
    });
    expect(r!.focusTop5).toEqual([
      { name: "msedge", minutes: 192 },
      { name: "QQ", minutes: 108 },
      { name: "Code.exe", minutes: 82 },
      { name: "三角洲行动", minutes: 46 },
      { name: "explorer", minutes: 21 },
    ]);
    expect(r!.day).toBe("2026-11-15");
  });

  it("focusMinutes 缺失时退回 focusSeconds 换算（round 秒/60）", () => {
    const r = buildOwnerRhythm({ usage: { day: "2026-11-15", focusSeconds: { msedge: 304, ZCode: 784 } }, state: null, config: null, now: D(15, 20) });
    expect(r!.focusTop5).toEqual([
      { name: "ZCode", minutes: 13 },
      { name: "msedge", minutes: 5 },
    ]);
  });
});

describe("buildOwnerRhythm · 昨晚块（跨零点窗口）", () => {
  const CONFIG = { nightStart: "23:00", nightEnd: "03:00" };

  it("streak 昨天 23:40 起、now 今天 01:20：交集 100 分钟，窗口标签 23:40-01:20；窗口内催睡 1 次", () => {
    const r = buildOwnerRhythm({
      usage: { day: "2026-11-15" },
      state: {
        streaks: { 三角洲行动: iso(D(14, 23, 40)) },
        ledger: { nags: [{ at: iso(D(14, 23, 41)), game: "三角洲行动" }] },
      },
      config: CONFIG,
      now: D(15, 1, 20),
    });
    expect(r!.lastNight).toEqual({ game: "三角洲行动", minutes: 100, windowLabel: "23:40-01:20" });
    expect(r!.nagsLastNight).toBe(1);
    expect(r!.nagTimes).toEqual(["23:41"]);
  });

  it("催睡计数只算昨晚窗口内的：白天/三天前的账不混进来", () => {
    const r = buildOwnerRhythm({
      usage: { day: "2026-11-15" },
      state: {
        streaks: {},
        ledger: {
          nags: [
            { at: iso(D(12, 23, 30)), game: "街霸6" }, // 3 天前：窗口外
            { at: iso(D(15, 10, 0)), game: "街霸6" }, // 今天白天：窗口外
            { at: iso(D(14, 23, 55)), game: "三角洲行动" }, // 昨晚窗口内
          ],
        },
      },
      config: CONFIG,
      now: D(15, 12, 0),
    });
    expect(r!.lastNight).toBe(null); // streak 没了（游戏关了）→ 游戏块不显示，不编造
    expect(r!.nagsLastNight).toBe(1);
    expect(r!.nagTimes).toEqual(["23:55"]);
  });

  it("不跨零点的窗口：昨晚 = 昨天 22:00-23:30", () => {
    const r = buildOwnerRhythm({
      usage: { day: "2026-11-15" },
      state: { streaks: { 街霸6: iso(D(14, 22, 10)) }, ledger: { nags: [] } },
      config: { nightStart: "22:00", nightEnd: "23:30" },
      now: D(15, 10, 0),
    });
    expect(r!.lastNight).toEqual({ game: "街霸6", minutes: 80, windowLabel: "22:10-23:30" });
  });

  it("config 缺失用默认 23:00-03:00；起止相同视为永不（无窗口无催睡）", () => {
    const r1 = buildOwnerRhythm({ usage: { day: "2026-11-15" }, state: { streaks: { 街霸6: iso(D(14, 23, 10)) } }, config: null, now: D(15, 1, 0) });
    expect(r1!.lastNight?.minutes).toBe(110);
    const r2 = buildOwnerRhythm({ usage: { day: "2026-11-15" }, state: { streaks: { 街霸6: iso(D(14, 23, 10)) }, ledger: { nags: [{ at: iso(D(14, 23, 20)) }] } }, config: { nightStart: "23:00", nightEnd: "23:00" }, now: D(15, 1, 0) });
    expect(r2!.lastNight).toBe(null);
    expect(r2!.nagsLastNight).toBe(0);
  });
});

describe("buildOwnerRhythm · 近 7 天与降级", () => {
  it("weekHistory 七槽：今天=focus 合计，history 命中的天有值，没积累的日子=null（今天在最后）", () => {
    const r = buildOwnerRhythm({
      usage: {
        day: "2026-11-15",
        focusSeconds: { msedge: 3600, QQ: 600 },
        history: [
          { day: "2026-11-09", totalFocusMinutes: 40 },
          { day: "2026-11-12", totalFocusMinutes: 95 },
        ],
      },
      state: null,
      config: null,
      now: D(15, 20, 0),
    });
    expect(r!.weekHistory.map((d) => d.day)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
    expect(r!.weekHistory.map((d) => d.totalFocusMinutes)).toEqual([40, null, null, 95, null, null, 70]);
  });

  it("usage 缺失返回 null；state/config 缺失仍出可用形状（全空槽）", () => {
    expect(buildOwnerRhythm({ usage: null, state: null, config: null, now: D(15, 20) })).toBe(null);
    const r = buildOwnerRhythm({ usage: { day: "" }, state: null, config: null, now: D(15, 20) });
    expect(r!.focusTop5).toEqual([]);
    expect(r!.lastNight).toBe(null);
    expect(r!.nagsLastNight).toBe(0);
    expect(r!.weekHistory.every((d) => d.totalFocusMinutes === null)).toBe(true);
    expect(r!.weekHistory).toHaveLength(7);
    expect(r!.updatedAt).toBe(null);
    expect(r!.idleSkipMinutes).toBe(15); // config 缺 -> 默认 15 分豁免线
  });

  it("yesterday 透传（形状对才给）", () => {
    const r = buildOwnerRhythm({ usage: { day: "2026-11-15", yesterday: { day: "2026-11-14", top: [{ name: "msedge", minutes: 30 }] } }, state: null, config: null, now: D(15, 20) });
    expect(r!.yesterday).toEqual({ day: "2026-11-14", top: [{ name: "msedge", minutes: 30 }] });
    const bad = buildOwnerRhythm({ usage: { day: "2026-11-15", yesterday: { day: 1 } as never }, state: null, config: null, now: D(15, 20) });
    expect(bad!.yesterday).toBe(null);
  });
});

describe("nightWindowBefore 窗口边界", () => {
  it("跨零点：昨天 23:00 -> 今天 03:00；非法/相同起止 = null", () => {
    const w = nightWindowBefore(D(15, 1, 0), "23:00", "03:00");
    expect(w!.start.getDate()).toBe(14);
    expect(w!.start.getHours()).toBe(23);
    expect(w!.end.getDate()).toBe(15);
    expect(w!.end.getHours()).toBe(3);
    expect(nightWindowBefore(D(15, 1, 0), "abc", "03:00")).toBe(null);
    expect(nightWindowBefore(D(15, 1, 0), "00:00", "00:00")).toBe(null);
  });
});

describe("owner-status.mjs updateUsage · 日切 history 追加（生产哨兵，只测纯函数不跑主流程）", () => {
  it("日切时把当天合计专注分钟追加进 history，最新在后", () => {
    const u = emptyUsage();
    updateUsage(u, { now: D(8, 20, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    updateUsage(u, { now: D(8, 20, 1), fgProc: "msedge", idleSec: 0, procInfo: [] });
    updateUsage(u, { now: D(9, 0, 0), fgProc: "QQ", idleSec: 0, procInfo: [] });
    expect(u.history).toEqual([{ day: "2026-11-08", totalFocusMinutes: 1 }]);
  });

  it("首日空账（day 为空串）不追加；旧账本没有 history 字段也能就地起账", () => {
    const u = emptyUsage();
    updateUsage(u, { now: D(8, 20, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    expect(u.history).toEqual([]);
    const legacy = { day: "2026-11-08", focusSeconds: { QQ: 1800 }, focusMinutes: { QQ: 30 }, yesterday: null };
    updateUsage(legacy, { now: D(9, 0, 0), fgProc: "QQ", idleSec: 0, procInfo: [] });
    expect(legacy.history).toEqual([{ day: "2026-11-08", totalFocusMinutes: 30 }]);
  });

  it("cap 30：第 31 天封账时最老的被挤掉，长度恒为 30", () => {
    const u = emptyUsage();
    u.day = "2026-11-08";
    u.history = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(9 + i).padStart(2, "0")}`, totalFocusMinutes: i }));
    updateUsage(u, { now: D(9, 0, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    expect(u.history).toHaveLength(30);
    expect(u.history[0]).toEqual({ day: "2026-10-10", totalFocusMinutes: 1 });
    expect(u.history[29]).toEqual({ day: "2026-11-08", totalFocusMinutes: 0 });
  });
});
