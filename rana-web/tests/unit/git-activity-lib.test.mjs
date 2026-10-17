// git-activity-lib.mjs 测试：periodRange 日/周/月报边界 + isAutoCommit 正反例。
// 期望值全部用本地时区分量构造的 Date 对比（getTime 相等），不依赖运行时时区。
// 注意：绝不运行原脚本 git-activity.mjs（cron 生产脚本，会真跑 git 统计写报告）。
import { describe, it, expect } from "vitest";
import { periodRange, isAutoCommit } from "../../git-activity-lib.mjs";

const D = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min); // m 为 1-based，写着省心

describe("periodRange today", () => {
  it("日间任意时刻：今日 00:00 ~ 明日 00:00", () => {
    const { start, end } = periodRange("today", D(2026, 10, 17, 15, 30));
    expect(start.getTime()).toBe(D(2026, 10, 17).getTime());
    expect(end.getTime()).toBe(D(2026, 10, 18).getTime());
  });

  it("午夜零点整：起点含当日", () => {
    const { start, end } = periodRange("today", D(2026, 10, 17, 0, 0));
    expect(start.getTime()).toBe(D(2026, 10, 17).getTime());
    expect(end.getTime()).toBe(D(2026, 10, 18).getTime());
  });

  it("月末 1-31：终点跨进 2-1（Date 溢出进位）", () => {
    const { start, end } = periodRange("today", D(2026, 1, 31, 23, 59));
    expect(start.getTime()).toBe(D(2026, 1, 31).getTime());
    expect(end.getTime()).toBe(D(2026, 2, 1).getTime());
  });

  it("跨年 12-31：终点为次年 1-1", () => {
    const { start, end } = periodRange("today", D(2026, 12, 31, 23, 59));
    expect(start.getTime()).toBe(D(2026, 12, 31).getTime());
    expect(end.getTime()).toBe(D(2027, 1, 1).getTime());
  });
});

describe("periodRange week（上周一 00:00 ~ 本周一 00:00）", () => {
  it("周三取样：上一个完整自然周（周一开头口径）", () => {
    // 2026-10-14 是周三；本周一=10-12，上周一=10-05
    const { start, end } = periodRange("week", D(2026, 10, 14, 12));
    expect(start.getTime()).toBe(D(2026, 10, 5).getTime());
    expect(end.getTime()).toBe(D(2026, 10, 12).getTime());
  });

  it("周一当天取样：终点=当日 00:00（不含当天）", () => {
    const { start, end } = periodRange("week", D(2026, 10, 12, 9));
    expect(start.getTime()).toBe(D(2026, 10, 5).getTime());
    expect(end.getTime()).toBe(D(2026, 10, 12).getTime());
  });

  it("周日取样：仍归属以周一为界的上一周", () => {
    // 2026-10-18 是周日；本周一=10-12（周一开头），上周=10-05~10-12
    const { start, end } = periodRange("week", D(2026, 10, 18, 20));
    expect(start.getTime()).toBe(D(2026, 10, 5).getTime());
    expect(end.getTime()).toBe(D(2026, 10, 12).getTime());
  });

  it("跨月：11-02（周一）取样，起点落在 10-26", () => {
    const { start, end } = periodRange("week", D(2026, 11, 2, 8));
    expect(start.getTime()).toBe(D(2026, 10, 26).getTime());
    expect(end.getTime()).toBe(D(2026, 11, 2).getTime());
  });

  it("跨年：2027-01-04（周一）取样，起点落在 2026-12-28", () => {
    const { start, end } = periodRange("week", D(2027, 1, 4, 8));
    expect(start.getTime()).toBe(D(2026, 12, 28).getTime());
    expect(end.getTime()).toBe(D(2027, 1, 4).getTime());
  });
});

describe("periodRange month（上月 1 日 ~ 本月 1 日）", () => {
  it("月中取样：完整上个自然月", () => {
    const { start, end } = periodRange("month", D(2026, 10, 17, 12));
    expect(start.getTime()).toBe(D(2026, 9, 1).getTime());
    expect(end.getTime()).toBe(D(2026, 10, 1).getTime());
  });

  it("月末最后一天取样：区间不变（口径是上个自然月）", () => {
    const { start, end } = periodRange("month", D(2026, 10, 31, 23, 59));
    expect(start.getTime()).toBe(D(2026, 9, 1).getTime());
    expect(end.getTime()).toBe(D(2026, 10, 1).getTime());
  });

  it("1 月取样跨年：起点落在上一年 12-1（负月份溢出进位）", () => {
    const { start, end } = periodRange("month", D(2027, 1, 15, 12));
    expect(start.getTime()).toBe(D(2026, 12, 1).getTime());
    expect(end.getTime()).toBe(D(2027, 1, 1).getTime());
  });
});

describe("isAutoCommit", () => {
  it("sync: 前缀（真实自动提交样本）", () => {
    expect(isAutoCommit("sync: 2026-10-02 13:01:15.66")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(isAutoCommit("SYNC: uppercase")).toBe(true);
    expect(isAutoCommit("Backup 2026-10-02")).toBe(true);
  });

  it("backup + 空白前缀", () => {
    expect(isAutoCommit("backup 2026-10-02 daily")).toBe(true);
  });

  it("实质工作提交不误判", () => {
    expect(isAutoCommit("feat(rana-web): 新增审批页")).toBe(false);
    expect(isAutoCommit("fix: sync 流程里的竞态")).toBe(false); // sync: 不在行首
    expect(isAutoCommit("Add backup logic")).toBe(false);
    expect(isAutoCommit("")).toBe(false);
  });

  it("backup 后紧跟非空白不算自动提交（口径只认 backup+空白）", () => {
    expect(isAutoCommit("backup: 冒号不算")).toBe(false);
    expect(isAutoCommit("backup-private 连字符不算")).toBe(false);
  });
});
