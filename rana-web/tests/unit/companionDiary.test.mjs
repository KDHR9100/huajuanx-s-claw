// companion-diary.mjs 纯函数测试：只 import 模块（isMain 守卫保证主流程不会跑），
// 不调模型、不写日记文件。日期口径一律北京时间 +8h，与脚本保持同源。
import { describe, it, expect } from "vitest";
import {
  beijingDateKey,
  dayWindowMs,
  diaryFilePath,
  renderFile,
  buildDiaryPrompt,
  parseDiarySections,
  computeBackfillDays,
  buildStubDiary,
} from "../../companion-diary.mjs";

describe("beijingDateKey 北京时间日界", () => {
  it("UTC 15:59 归当天，16:00（北京 0 点）归次日", () => {
    expect(beijingDateKey(new Date("2026-11-08T15:59:00Z"))).toBe("2026-11-08");
    expect(beijingDateKey(new Date("2026-11-08T16:00:00Z"))).toBe("2026-11-09");
  });
});

describe("dayWindowMs 日窗口", () => {
  it("起点还原回同日，终点-1ms 仍在同日，终点本身归次日（排他）", () => {
    const [s, e] = dayWindowMs("2026-11-08");
    expect(e - s).toBe(86400e3);
    expect(beijingDateKey(new Date(s))).toBe("2026-11-08");
    expect(beijingDateKey(new Date(e - 1))).toBe("2026-11-08");
    expect(beijingDateKey(new Date(e))).toBe("2026-11-09");
  });
});

describe("computeBackfillDays 回补窗口", () => {
  it("无水位：从 today-6 到 today 共 7 天（旧→新）", () => {
    expect(computeBackfillDays(undefined, "2026-11-08")).toEqual([
      "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05",
      "2026-11-06", "2026-11-07", "2026-11-08",
    ]);
  });
  it("有水位：从水位后一天到 today", () => {
    expect(computeBackfillDays("2026-11-05", "2026-11-08")).toEqual([
      "2026-11-06", "2026-11-07", "2026-11-08",
    ]);
  });
  it("水位==today → 空；水位>today → 空", () => {
    expect(computeBackfillDays("2026-11-08", "2026-11-08")).toEqual([]);
    expect(computeBackfillDays("2026-11-09", "2026-11-08")).toEqual([]);
  });
});

describe("parseDiarySections 双段切分", () => {
  it("# 标题：日记/纪要正确切开，头部行剥掉", () => {
    const { diary, memo } = parseDiarySections("# 日记\n正文X\n# 纪要\n- a\n- b");
    expect(diary).toBe("正文X");
    expect(memo).toBe("- a\n- b");
  });
  it("【】标题：同样切开", () => {
    const { diary, memo } = parseDiarySections("【日记】\n正文Y\n【纪要】\n- c");
    expect(diary).toBe("正文Y");
    expect(memo).toBe("- c");
  });
  it("## 标题变体也认", () => {
    const { diary, memo } = parseDiarySections("## 日记\n正文Z\n## 纪要\n- d");
    expect(diary).toBe("正文Z");
    expect(memo).toBe("- d");
  });
  it("认不出纪要头：整段当日记（剥日记头），纪要空串", () => {
    const { diary, memo } = parseDiarySections("# 日记\n只有日记没有纪要");
    expect(diary).toBe("只有日记没有纪要");
    expect(memo).toBe("");
  });
  it("空输入 → 双空", () => {
    expect(parseDiarySections("")).toEqual({ diary: "", memo: "" });
    expect(parseDiarySections(null)).toEqual({ diary: "", memo: "" });
  });
});

describe("renderFile 文件模板", () => {
  it("双段：日记+纪要", () => {
    expect(renderFile("2026-11-08", "今天很开心", "- 聊了电影\n- 定了周末"))
      .toBe("# 复盘日记 2026-11-08\n\n## 日记\n\n今天很开心\n\n## 纪要\n\n- 聊了电影\n- 定了周末\n");
  });
  it("memo 空：省略纪要节；diary 空显示（空）", () => {
    const out = renderFile("2026-11-08", "", "");
    expect(out).toBe("# 复盘日记 2026-11-08\n\n## 日记\n\n（空）\n");
    expect(out).not.toContain("## 纪要");
  });
});

describe("stub / prompt / 路径", () => {
  it("buildStubDiary 含日期与留白文案", () => {
    const s = buildStubDiary("2026-11-08");
    expect(s).toContain("2026-11-08");
    expect(s).toContain("留白也是记录");
  });
  it("buildDiaryPrompt：含对话原文、两段标题、硬规则字样", () => {
    const p = buildDiaryPrompt("当天对话原文BODY");
    expect(p).toContain("当天对话原文BODY");
    expect(p).toContain("# 日记");
    expect(p).toContain("# 纪要");
    expect(p).toContain("没有的事不编");
  });
  it("diaryFilePath 落在 diary 目录、以日期命名", () => {
    const p = diaryFilePath("2026-11-08");
    expect(p.endsWith("2026-11-08.md")).toBe(true);
    expect(p).toContain("diary");
  });
});
