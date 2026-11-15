// owner-status.mjs 规则引擎测试：游戏识别 / 深夜窗口 / 催睡判定 / 提示词。
// 绝不运行原脚本主流程（哨兵生产脚本，主流程会真拉人发 QQ）——只 import 纯函数。
import { describe, it, expect } from "vitest";
import { matchGame, withinNightWindow, decideNightNag, buildNagPrompt, updateUsage, emptyUsage } from "../../owner-status.mjs";

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
    // lastNagAt 与 now 用同一种时钟（本地构造再转 ISO）：写死 UTC 串等于东八区特权，CI 的 UTC 机器上差 8 小时直接翻车
    const at2300 = new Date(2026, 10, 7, 23, 0).toISOString();
    const ledger = { nags: [{ at: at2300 }], lastNagAt: at2300 };
    const d = decideNightNag({ ...base, now: new Date(2026, 10, 7, 23, 10), matchedGame: "三角洲行动", streakMinutes: 90, idleSec: 0, ledger, config: { nagGapMinutes: 30 } });
    expect(d).toEqual({ fire: false, reason: "gap-wait" });
  });
  it("间隔刚过：第 2 次，且提示词换狠一点的口吻", () => {
    const at2300 = new Date(2026, 10, 7, 23, 0).toISOString(); // 同款病：与 now 同钟构造，任何时区都成立
    const ledger = { nags: [{ at: at2300 }], lastNagAt: at2300 };
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

describe("updateUsage 专注时长", () => {
  // 时钟纪律同上文：本地构造 now，与 localDateKey 同钟，任何时区跑都成立
  const mkNow = (h, m, s = 0) => new Date(2026, 10, 8, h, m, s);

  it("同一前台进程逐轮累计（60 秒一轮记 60 秒）", () => {
    const u = emptyUsage();
    updateUsage(u, { now: mkNow(20, 0, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    updateUsage(u, { now: mkNow(20, 1, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    expect(u.focusSeconds["msedge"]).toBe(60);
    expect(u.focusMinutes["msedge"]).toBe(1);
  });

  it("切窗口：那一段记给上一个窗口，新窗口从下一轮起算", () => {
    const u = emptyUsage();
    updateUsage(u, { now: mkNow(20, 0, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    updateUsage(u, { now: mkNow(20, 1, 0), fgProc: "QQ", idleSec: 0, procInfo: [] });
    expect(u.focusSeconds["msedge"]).toBe(60);
    expect(u.focusSeconds["QQ"]).toBeUndefined();
  });

  it("键鼠空闲超线的那一轮不记专注，人回来接着记", () => {
    const u = emptyUsage();
    updateUsage(u, { now: mkNow(20, 0, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    updateUsage(u, { now: mkNow(20, 1, 0), fgProc: "msedge", idleSec: 900, procInfo: [] });
    expect(u.focusSeconds["msedge"]).toBeUndefined();
    updateUsage(u, { now: mkNow(20, 2, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    expect(u.focusSeconds["msedge"]).toBe(60);
  });

  it("两轮间隔超 90 秒的部分不补记（漏跑/睡眠后不一次性补大账）", () => {
    const u = emptyUsage();
    updateUsage(u, { now: mkNow(20, 0, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    updateUsage(u, { now: mkNow(20, 10, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    expect(u.focusSeconds["msedge"]).toBe(90);
  });
});

describe("updateUsage 存活时长与日切", () => {
  const mkNow = (h, m, s = 0) => new Date(2026, 10, 8, h, m, s);
  // 带偏移量的 ISO 串（PowerShell 给 StartTime 的形态）：偏移量必须随宿主机走，
  // 不能写死 +08:00——CI(Ubuntu/UTC) 下写死的偏移会与 mkNow 的本地钟相差 8 小时
  const localIso = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    const off = -d.getTimezoneOffset();
    const abs = Math.abs(off);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000${off >= 0 ? "+" : "-"}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
  };

  it("优先进程启动时间；拿不到退回首次见到并标 approx；消失的名字撤账", () => {
    const u = emptyUsage();
    const sIso = localIso(new Date(2026, 10, 8, 18, 0, 0));
    updateUsage(u, { now: mkNow(20, 0, 0), fgProc: "msedge", idleSec: 0, procInfo: [{ n: "msedge", s: sIso }, { n: "foo" }] });
    expect(u.alive["msedge"]).toEqual({ since: sIso, minutes: 120 });
    expect(u.alive["foo"]).toEqual({ since: mkNow(20, 0, 0).toISOString(), minutes: 0, approx: true });
    updateUsage(u, { now: mkNow(20, 1, 0), fgProc: "msedge", idleSec: 0, procInfo: [{ n: "foo" }] });
    expect(u.alive["msedge"]).toBeUndefined();
    expect(u.alive["foo"]).toEqual({ since: mkNow(20, 0, 0).toISOString(), minutes: 1, approx: true });
  });

  it("日切：focus 清零，昨日 Top3 封存进 yesterday", () => {
    const u = emptyUsage();
    updateUsage(u, { now: mkNow(23, 59, 0), fgProc: "msedge", idleSec: 0, procInfo: [] });
    updateUsage(u, { now: mkNow(23, 59, 30), fgProc: "msedge", idleSec: 0, procInfo: [] });
    updateUsage(u, { now: new Date(2026, 10, 9, 0, 0, 0), fgProc: "QQ", idleSec: 0, procInfo: [] });
    expect(u.day).toBe("2026-11-09");
    expect(u.focusSeconds["msedge"]).toBeUndefined();
    expect(u.yesterday).toEqual({ day: "2026-11-08", top: [{ name: "msedge", minutes: 1 }] });
  });
});

