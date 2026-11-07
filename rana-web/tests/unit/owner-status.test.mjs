// owner-status.mjs 规则引擎测试：游戏识别 / 深夜窗口 / 催睡判定 / 提示词。
// 绝不运行原脚本主流程（哨兵生产脚本，主流程会真拉人发 QQ）——只 import 纯函数。
import { describe, it, expect } from "vitest";
import { matchGame, withinNightWindow, decideNightNag, buildNagPrompt } from "../../owner-status.mjs";

const GAMES = [
  { name: "三角洲行动", keywords: ["三角洲", "Delta Force", "DeltaForce"] },
  { name: "影之刃零", keywords: ["影之刃", "PhantomBlade"] },
  { name: "街霸6", keywords: ["街霸", "Street Fighter", "StreetFighter"] },
];

describe("matchGame", () => {
  it("标题命中（真实样本带尾随空格）", () => {
    expect(matchGame(GAMES, { fgTitle: "三角洲行动  ", fgProc: "", procs: [] })).toBe("三角洲行动");
  });
  it("前台进程命中（真实样本）", () => {
    expect(matchGame(GAMES, { fgTitle: "", fgProc: "DeltaForceClient-Win64-Shipping", procs: [] })).toBe("三角洲行动");
  });
  it("全进程清单命中（挂后台也认得出）", () => {
    expect(matchGame(GAMES, { fgTitle: "浏览器", fgProc: "msedge", procs: ["explorer", "StreetFighter6"] })).toBe("街霸6");
  });
  it("大小写不敏感", () => {
    expect(matchGame(GAMES, { fgTitle: "", fgProc: "", procs: ["DELTAFORCE.EXE"] })).toBe("三角洲行动");
  });
  it("未配置的游戏不误报", () => {
    expect(matchGame(GAMES, { fgTitle: "无限暖暖", fgProc: "", procs: ["somegame"] })).toBe(null);
  });
});

describe("withinNightWindow", () => {
  it("窗口内：凌晨 1 点（跨零点 23:00-03:00）", () => {
    expect(withinNightWindow(new Date(2026, 10, 8, 1, 0), "23:00", "03:00")).toBe(true);
  });
  it("边界：23:00 含、03:00 不含", () => {
    expect(withinNightWindow(new Date(2026, 10, 8, 23, 0), "23:00", "03:00")).toBe(true);
    expect(withinNightWindow(new Date(2026, 10, 8, 3, 0), "23:00", "03:00")).toBe(false);
  });
  it("窗口外：晚上 10 点", () => {
    expect(withinNightWindow(new Date(2026, 10, 8, 22, 0), "23:00", "03:00")).toBe(false);
  });
  it("起止相同或非法值 = 永不", () => {
    expect(withinNightWindow(new Date(2026, 10, 8, 1, 0), "00:00", "00:00")).toBe(false);
    expect(withinNightWindow(new Date(2026, 10, 8, 1, 0), "abc", "03:00")).toBe(false);
  });
});

describe("decideNightNag", () => {
  const LEDGER_EMPTY = { nags: [], lastNagAt: null };
  const base = { now: new Date(2026, 10, 8, 23, 40), ledger: LEDGER_EMPTY };
  it("全条件满足：开口，第 1 次", () => {
    const d = decideNightNag({ ...base, matchedGame: "三角洲行动", streakMinutes: 20, idleSec: 0, config: { nightStart: "23:00", nightEnd: "03:00", minRunMinutes: 20, maxNags: 2, nagGapMinutes: 30 } });
    expect(d).toEqual({ fire: true, reason: "night-nag", count: 1 });
  });
  it("没游戏不开口", () => {
    const d = decideNightNag({ ...base, matchedGame: null, streakMinutes: 60, idleSec: 0, config: {} });
    expect(d).toEqual({ fire: false, reason: "no-game" });
  });
  it("不在深夜窗口不开口", () => {
    const d = decideNightNag({ ...base, now: new Date(2026, 10, 8, 22, 59), matchedGame: "街霸6", streakMinutes: 90, idleSec: 0, config: { nightStart: "23:00", nightEnd: "03:00" } });
    expect(d).toEqual({ fire: false, reason: "not-night" });
  });
  it("连跑不够 20 分钟不开口", () => {
    const d = decideNightNag({ ...base, matchedGame: "街霸6", streakMinutes: 19, idleSec: 0, config: { minRunMinutes: 20 } });
    expect(d).toEqual({ fire: false, reason: "streak-short" });
  });
  it("键鼠空闲超豁免线不开口（人不在不空喊）", () => {
    const d = decideNightNag({ ...base, matchedGame: "街霸6", streakMinutes: 90, idleSec: 2401, config: { idleExemptMinutes: 40 } });
    expect(d).toEqual({ fire: false, reason: "idle-exempt" });
  });
  it("催满上限不再催", () => {
    const ledger = { nags: [{ at: "2026-11-07T15:00:00Z" }, { at: "2026-11-07T15:31:00Z" }], lastNagAt: "2026-11-07T15:31:00Z" };
    const d = decideNightNag({ ...base, matchedGame: "三角洲行动", streakMinutes: 90, idleSec: 0, ledger, config: { maxNags: 2, nagGapMinutes: 30 } });
    expect(d).toEqual({ fire: false, reason: "max-nags" });
  });
  it("间隔未到不重复催", () => {
    const ledger = { nags: [{ at: "2026-11-07T15:00:00Z" }], lastNagAt: "2026-11-07T15:00:00Z" };
    const d = decideNightNag({ ...base, now: new Date(2026, 10, 7, 23, 10), matchedGame: "三角洲行动", streakMinutes: 90, idleSec: 0, ledger, config: { nagGapMinutes: 30 } });
    expect(d).toEqual({ fire: false, reason: "gap-wait" });
  });
  it("间隔刚过：第 2 次，且提示词换狠一点的口吻", () => {
    const ledger = { nags: [{ at: "2026-11-07T15:00:00Z" }], lastNagAt: "2026-11-07T15:00:00Z" };
    const d = decideNightNag({ ...base, now: new Date(2026, 10, 7, 23, 31), matchedGame: "三角洲行动", streakMinutes: 90, idleSec: 0, ledger, config: { nagGapMinutes: 30, maxNags: 2 } });
    expect(d).toEqual({ fire: true, reason: "night-nag", count: 2 });
    expect(buildNagPrompt({ count: 2, game: "三角洲行动", minutes: 90, title: "x", idleSec: 0, qqTarget: "t", channel: "qqbot" })).toContain("更不客气");
  });
});

describe("buildNagPrompt", () => {
  it("带全部事实与纪律（目标/通道/一次 message/禁 exec）", () => {
    const p = buildNagPrompt({ count: 1, game: "街霸6", minutes: 25, title: "Street Fighter 6", idleSec: 3, qqTarget: "T1", channel: "qqbot" });
    expect(p).toContain("【深夜催睡·第1次】");
    expect(p).toContain("街霸6");
    expect(p).toContain("target='T1'");
    expect(p).toContain("channel='qqbot'");
    expect(p).toContain("禁止 exec");
  });
  it("验收模式换抬头", () => {
    const p = buildNagPrompt({ count: 1, game: "街霸6", minutes: 25, title: "x", idleSec: 0, qqTarget: "T1", channel: "qqbot", isTest: true });
    expect(p).toContain("【催睡链路验收】");
  });
});

