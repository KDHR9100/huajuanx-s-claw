// person-graph-parse 测试：全部用假名 fixture（测试甲/乙/丙/测试中心），
// 零接触真实人物数据（红线：真实人名与关系不进公开仓）。
// 用例按解析器实际行为钉桩：列序无关、缺列降级、坏行跳过、永不 throw。
import { describe, it, expect } from "vitest";
import {
  parseLastChecked,
  parsePeopleTable,
  parseEventsTable,
  parseLinksTable,
  parsePersonGraph,
} from "../../server/lib/person-graph-parse.ts";

const FIX = `最后核对：2026-11-01
## 人物节点

| 节点 | 圈层 | 一句话 | 与轩瑜 | 来源 |
|---|---|---|---|---|
| 测试甲 | 家人 | 测试一句话甲 | 亲缘 | 11/01 |
| 测试乙 | 朋友 | 测试一句话乙 | 朋友 | 11/02 |

## 事节点

| 事件 | 状态 | 关联人 | 来源 |
|---|---|---|---|
| 测试事件一 | 进行中 | 测试甲 | 11/01 |
`;

describe("parseLastChecked", () => {
  it("半角/全角冒号都能读，没有则 null", () => {
    expect(parseLastChecked("最后核对: 2026-11-01")).toBe("2026-11-01");
    expect(parseLastChecked("最后核对：2026-10-01")).toBe("2026-10-01");
    expect(parseLastChecked("没有这一行")).toBe(null);
    expect(parseLastChecked("最后核对：2026-13-99")).toBe("2026-13-99"); // 只认形状不校历法
  });
});

describe("parsePeopleTable", () => {
  it("正常两行 + 分隔行跳过", () => {
    const sec = "| 节点 | 圈层 | 一句话 | 与轩瑜 | 来源 |\n|---|---|---|---|---|\n| 测试甲 | 家人 | 测试一句话甲 | 亲缘 | 11/01 |\n| 测试乙 | 朋友 | 测试一句话乙 | 朋友 | 11/02 |\n";
    const r = parsePeopleTable(sec);
    expect(r.length).toBe(2);
    expect(r[0]).toEqual({ name: "测试甲", group: "家人", blurb: "测试一句话甲", relation: "亲缘", source: "11/01" });
  });

  it("列序无关：换列顺序照样按表头名取列", () => {
    const sec = `| 圈层 | 一句话 | 节点 | 来源 | 与轩瑜 |
|---|---|---|---|---|
| 家人 | 一句话丙 | 测试丙 | s | rel |`;
    const r = parsePeopleTable(sec);
    expect(r[0].name).toBe("测试丙");
    expect(r[0].group).toBe("家人");
  });
});

describe("parsePeopleTable", () => {
  it("缺圈层列 -> 未分组；空行跳过", () => {
    const sec = "| 节点 | 一句话 |\n|---|---|\n| 测试丁 | 一句话丁 |\n\n|  |  |\n";
    const r = parsePeopleTable(sec);
    expect(r.length).toBe(1);
    expect(r[0].group).toBe("未分组");
  });
});

describe("parseEventsTable", () => {
  it("正常一行 + 分隔行跳过", () => {
    const sec = "| 事件 | 状态 | 关联人 | 来源 |\n|---|---|---|---|\n| 测试事件一 | 进行中 | 测试甲 | 11/01 |\n";
    const r = parseEventsTable(sec);
    expect(r.length).toBe(1);
    expect(r[0]).toEqual({ name: "测试事件一", status: "进行中", people: "测试甲", source: "11/01" });
  });
});

describe("parsePersonGraph 整页入口", () => {
  it("CRLF 与末尾无换行都能解析", () => {
    const md = "最后核对：2026-11-01\r\n## 人物节点\r\n\r\n| 节点 | 圈层 | 一句话 | 与轩瑜 | 来源 |\r\n|---|---|---|---|---|\r\n| 测试戊 | 职场 | 一句话戊 | 同事 | 11/03";
    const r = parsePersonGraph(md);
    expect(r.lastChecked).toBe("2026-11-01");
    expect(r.people.length).toBe(1);
    expect(r.people[0].name).toBe("测试戊");
    expect(r.events).toEqual([]);
  });

  it("垃圾输入不 throw，返回空数据", () => {
    const r = parsePersonGraph("这不是图谱文件\n随便写");
    expect(r.people).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.lastChecked).toBe(null);
  });

  it("error 字段只在文件级问题时出现（本组不触发）", () => {
    const r = parsePersonGraph("");
    expect(r.error).toBeUndefined();
  });
});

describe("parseLinksTable", () => {
  it("正常两行 + 缺端点的行跳过", () => {
    const sec = "| 人物A | 人物B | 一句话 |\n|---|---|---|\n| 测试甲 | 测试乙 | 甲乙同事 |\n| 测试甲 |  | 缺B跳过 |\n";
    const r = parseLinksTable(sec);
    expect(r.length).toBe(1);
    expect(r[0]).toEqual({ a: "测试甲", b: "测试乙", note: "甲乙同事" });
  });

  it("没有连线小节 -> 空数组（老数据无感）", () => {
    expect(parseLinksTable("")).toEqual([]);
  });
});

describe("parsePersonGraph 连线整合", () => {
  it("三张表一起解析 + CRLF", () => {
    const md = "## 人物节点\r\n\r\n| 节点 | 圈层 | 一句话 | 与轩瑜 | 来源 |\r\n|---|---|---|---|---|\r\n| 测试己 | 家人 | 一句话己 | 亲缘 | 11/05 |\r\n\r\n## 事节点\r\n\r\n| 事件 | 状态 | 关联人 | 来源 |\r\n|---|---|---|---|\r\n| 测试事件二 | 进行中 | 测试己 | 11/05 |\r\n\r\n## 连线\r\n\r\n| 人物A | 人物B | 一句话 |\r\n|---|---|---|\r\n| 测试事件二 | 测试己 | 己挂在事件二上 |\r\n";
    const r = parsePersonGraph(md);
    expect(r.people.length).toBe(1);
    expect(r.events.length).toBe(1);
    expect(r.links.length).toBe(1);
    expect(r.links[0]).toEqual({ a: "测试事件二", b: "测试己", note: "己挂在事件二上" });
  });
});
