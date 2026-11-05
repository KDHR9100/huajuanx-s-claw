// src/lib/fmt.ts 黄金值测试（2026-11-06 日期工具收拢后的行为锚）。
// 钉的是「与原手抄版一致」的语义：M/D 不补 0、时分补 0、相对时间天数向下取整。
import { describe, it, expect } from "vitest";
import {
  pad2, fmtDayTime, fmtDayTimeOr, fmtIsoTime, fmtHm, fmtHmOr,
  fmtSmartTime, fmtAgo, dateStr, todayStr, addDays, fmtDateYMD,
} from "../../src/lib/fmt";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("pad2 / fmtDayTime / fmtDayTimeOr", () => {
  it("补零与 M/D HH:MM 主格式", () => {
    expect(pad2(3)).toBe("03");
    expect(fmtDayTime(at(2026, 11, 6, 9, 5))).toBe("11/6 09:05");
    expect(fmtDayTimeOr(undefined)).toBe("—");
    expect(fmtDayTimeOr(0)).toBe("—");
    expect(fmtDayTimeOr(at(2026, 1, 2, 8, 5))).toBe("1/2 08:05");
  });
});

describe("fmtIsoTime / fmtHm / fmtHmOr / fmtSmartTime", () => {
  it("ISO 串、HH:MM、守卫与今天分支", () => {
    expect(fmtIsoTime(undefined)).toBe("");
    expect(fmtIsoTime("not-a-date")).toBe("");
    expect(fmtIsoTime(new Date(2026, 10, 6, 9, 5).toISOString())).toContain("11/6 09:05");
    expect(fmtHm(at(2026, 11, 6, 9, 5))).toBe("09:05");
    expect(fmtHmOr(0)).toBe("");
    expect(fmtHmOr(undefined, "—")).toBe("—");
    const now = Date.now();
    expect(fmtSmartTime(now)).toBe(fmtHm(now));
    expect(fmtSmartTime(undefined)).toBe("");
  });
});

describe("fmtAgo", () => {
  it("分钟/小时/天三段，天数向下取整", () => {
    const now = Date.now();
    expect(fmtAgo(now - 5 * 60000)).toBe("5 分钟前");
    expect(fmtAgo(now - 90 * 60000)).toBe("2 小时前");
    expect(fmtAgo(now - 2 * 86400000)).toBe("2 天前");
    expect(fmtAgo(0)).toBe("");
    expect(fmtAgo(undefined, "没用过")).toBe("没用过");
  });
});

describe("dateStr / todayStr / addDays / fmtDateYMD", () => {
  it("补零日期、跨月平移与不补零变体", () => {
    expect(dateStr(new Date(2026, 10, 6))).toBe("2026-11-06");
    expect(addDays("2026-11-30", 7)).toBe("2026-12-07");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fmtDateYMD(at(2026, 11, 6))).toBe("2026-11-6");
  });
});
