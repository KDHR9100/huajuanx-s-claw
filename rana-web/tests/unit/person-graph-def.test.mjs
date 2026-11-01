// buildMermaidDef/escLabel 测试：假名 fixture，钉桩星型拓扑与转义行为。
import { describe, it, expect } from "vitest";
import { escLabel, buildMermaidDef } from "../../src/lib/person-graph.ts";

const DATA = {
  lastChecked: "2026-11-01",
  people: [
    { name: "测试甲", group: "家人", blurb: "一句话甲", relation: "亲缘", source: "11/01" },
    { name: "测试乙", group: "朋友", blurb: "一句话乙", relation: "朋友", source: "11/02" },
  ],
  events: [{ name: "测试事件一", status: "进行中", people: "测试甲", source: "11/01" }],
};

describe("escLabel", () => {
  it("引号/方括号/尖括号全部转成安全形态", () => {
    expect(escLabel('测试"甲"[1]<x>')).toBe("测试#quot;甲#quot;（1）＜x＞");
  });
});

describe("buildMermaidDef", () => {
  it("星型拓扑：中心+圈层 subgraph+事件组+连线", () => {
    const def = buildMermaidDef(DATA, "测试中心");
    expect(def).toContain("测试中心");
    expect(def).toContain(`subgraph SG0["家人"]`);
    expect(def).toContain(`subgraph SG1["朋友"]`);
    expect(def).toContain(`subgraph SGEV["事件"]`);
    expect(def).toContain("n0[");
    expect(def).toContain("XY --- n0");
    expect(def).toContain("XY --- ev0");
  });

  it("空数据也能出合法定义（只有中心）", () => {
    const def = buildMermaidDef({ lastChecked: null, people: [], events: [] });
    expect(def).toContain("XY");
    expect(def).not.toContain("SGEV");
  });
});
