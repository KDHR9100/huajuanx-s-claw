// 用量页视图助手守门：格式化/区间汇总/模型构成/配色循环。
import { describe, expect, it } from "vitest";
import { fmtTokens, rangeTotal, modelMix, agentColor, type UsageDay } from "../../src/lib/usage-view";

const D1: UsageDay = {
  date: "2026-11-07",
  agents: { main: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 10, total: 150, runs: 1, models: { "glm-5.3-flash": 150 } } },
};
const D2: UsageDay = {
  date: "2026-11-08",
  agents: {
    main: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 10, total: 150, runs: 1, models: { "glm-5.3-flash": 150 } },
    "rana-rp": { input: 120, output: 80, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 200, runs: 1, models: { nalang: 200 } },
  },
};

describe("fmtTokens", () => {
  it("k/M 格式与空值", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(1234)).toBe("1.2k");
    expect(fmtTokens(1_234_567)).toBe("1.23M");
    expect(fmtTokens(undefined)).toBe("0");
  });
});

describe("rangeTotal", () => {
  it("按日期集合与 agent 过滤汇总", () => {
    expect(rangeTotal([D1, D2], new Set(["2026-11-08"]), null).total).toBe(350);
    expect(rangeTotal([D1, D2], new Set(["2026-11-08"]), "main").total).toBe(150);
    expect(rangeTotal([D1, D2], null, null).total).toBe(500);
  });
  it("空集合不误算", () => {
    expect(rangeTotal([], new Set(["2026-11-08"]), null).total).toBe(0);
    expect(rangeTotal([D1, D2], new Set(["1999-01-01"]), null).total).toBe(0);
  });
});

describe("modelMix + agentColor", () => {
  it("模型构成合并排序 + 配色循环", () => {
    const mix = modelMix([D1, D2], new Set(["2026-11-07", "2026-11-08"]), null);
    expect(mix[0].model).toBe("glm-5.3-flash");
    expect(mix[0].total).toBe(300);
    expect(mix[1].model).toBe("nalang");
    expect(agentColor(6)).toBe(agentColor(0));
  });
  it("agent 过滤下只算指定 agent 的模型", () => {
    const mix = modelMix([D1, D2], new Set(["2026-11-07", "2026-11-08"]), "rana-rp");
    expect(mix).toHaveLength(1);
    expect(mix[0].model).toBe("nalang");
  });
});
