// memory-bridge-parse.mjs 测试：工厂注入中性值（主人/群主/空过滤表 + 一组合成过滤表），
// 零接触任何私有文件（identity/privacy-patterns 一律不读）。
// 用例对照函数实际行为逐分支钉桩——含三个怪口径（≤15 丢弃 / slice(0,120) / slice(0,3)），
// 它们是生产行为，按现状钉死，测试不负责"修正"。
import { describe, it, expect } from "vitest";
import { makeParseEntries } from "../../memory-bridge-parse.mjs";

const NEUTRAL = { OWNER_NAME: "主人", OWNER_ALIAS: "群主", LOCAL_FILTERS: {} };
const pe = makeParseEntries(NEUTRAL);
// 合成过滤表：验证 rpPrivacy（无 i 旗标）与 opsNoise（有 i 旗标）
const peFiltered = makeParseEntries({
  OWNER_NAME: "主人",
  OWNER_ALIAS: "群主",
  LOCAL_FILTERS: { rpPrivacy: "私密词甲|私密词乙|abc", opsNoise: "heartbeat|巡检" },
});
// 本地时区分量构造，toTimeString 在任何机器上都得 14:05
const FALLBACK_TS = new Date(2026, 9, 17, 14, 5, 0).getTime();

describe("空输入与「空」短输入闸门", () => {
  it("空串 / null → []", () => {
    expect(pe("", "工作", FALLBACK_TS)).toEqual([]);
    expect(pe(null, "工作", FALLBACK_TS)).toEqual([]);
  });

  it("含「空」且长度 <10 → []（模型输出「空」的兜底）", () => {
    expect(pe("空", "工作", FALLBACK_TS)).toEqual([]);
    expect(pe("没有内容，空", "工作", FALLBACK_TS)).toEqual([]);
  });

  it("含「空」但长度 ≥10 → 闸门放行，按行走正常流程", () => {
    const r = pe("天空很蓝主人和Rana去散步了", "RP", FALLBACK_TS);
    expect(r.length).toBe(1);
    expect(r[0].line).toBe("14:05 [RP] 天空很蓝主人和Rana去散步了");
  });
});

describe("行首弹头剥除（-/* 与空白）", () => {
  it("- / * / 缩进弹头剥除后等价于无弹头", () => {
    const want = [{ time: "09:30", line: "09:30 [工作] 主人完成了任务甲" }];
    expect(pe("- 09:30 [工作] 主人完成了任务甲", "工作", FALLBACK_TS)).toEqual(want);
    expect(pe("* 09:30 [工作] 主人完成了任务甲", "工作", FALLBACK_TS)).toEqual(want);
    expect(pe("  - 09:30 [工作] 主人完成了任务甲", "工作", FALLBACK_TS)).toEqual(want);
  });
});

describe("行级跳过规则", () => {
  it("空/无开头的行跳过（多行里只丢该行）", () => {
    const raw = "09:30 [工作] 主人完成了任务丙\n空手道比赛真好看\n无需多言";
    const r = pe(raw, "工作", FALLBACK_TS);
    expect(r.length).toBe(1);
    expect(r[0].line).toContain("主人完成了任务丙");
  });

  it("任务回声行跳过：记忆提炼器 / 禁止复述 / ``` / 坐姿", () => {
    expect(pe("我是记忆提炼器，开始工作", "工作", FALLBACK_TS)).toEqual([]);
    expect(pe("禁止复述以下内容", "工作", FALLBACK_TS)).toEqual([]);
    expect(pe("主人提到了```代码块", "工作", FALLBACK_TS)).toEqual([]);
    expect(pe("坐姿：端正", "工作", FALLBACK_TS)).toEqual([]);
    expect(pe("坐姿: 端正", "工作", FALLBACK_TS)).toEqual([]);
    // 对照：不含回声特征的同类句子正常通过
    expect(pe("主人提到了代码块", "工作", FALLBACK_TS).length).toBe(1);
  });

  it("原文回声跳过：主人: / Rana:（ASCII 冒号）与 [HH:MM] 括号时间", () => {
    expect(pe("主人: 今天好累", "工作", FALLBACK_TS)).toEqual([]);
    expect(pe("Rana: 好的主人", "工作", FALLBACK_TS)).toEqual([]);
    expect(pe("[09:30] 主人说了什么", "工作", FALLBACK_TS)).toEqual([]);
  });

  it("全角冒号不触发原文回声闸门（口径只认 ASCII 冒号）", () => {
    const r = pe("主人：今天好累", "工作", FALLBACK_TS);
    expect(r.length).toBe(1);
    expect(r[0].line).toBe("14:05 [工作] 主人：今天好累");
  });
});

describe("隐私/噪音过滤表（合成正则注入）", () => {
  it("RP 腿 rpPrivacy 命中跳过；同款内容在工作腿不拦", () => {
    expect(peFiltered("09:30 [RP] 主人提到了私密词甲", "RP", FALLBACK_TS)).toEqual([]);
    expect(peFiltered("09:30 [工作] 主人提到了私密词甲", "工作", FALLBACK_TS).length).toBe(1);
  });

  it("rpPrivacy 无 i 旗标：大小写不匹配即放行", () => {
    expect(peFiltered("09:30 [RP] 主人写了ABC代码", "RP", FALLBACK_TS).length).toBe(1);
  });

  it("工作腿 opsNoise 命中跳过，且 i 旗标生效（大写输入命中小写模式）", () => {
    expect(peFiltered("09:30 [工作] HEARTBEAT 自检完成，Rana 确认", "工作", FALLBACK_TS)).toEqual([]);
    expect(peFiltered("09:30 [工作] 巡检结束，主人确认", "工作", FALLBACK_TS)).toEqual([]);
  });

  it("opsNoise 不拦 RP 腿", () => {
    expect(peFiltered("09:30 [RP] HEARTBEAT 自检完成，主人在看", "RP", FALLBACK_TS).length).toBe(1);
  });

  it("空过滤表（缺文件回退形态）不拦任何东西", () => {
    expect(pe("09:30 [RP] 主人提到了私密词甲", "RP", FALLBACK_TS).length).toBe(1);
  });
});

describe("提及闸门与群聊中文闸门", () => {
  it("非群聊纪要必须提到 主人/群主/Rana", () => {
    expect(pe("09:30 [工作] 今天天气不错", "工作", FALLBACK_TS)).toEqual([]);
    expect(pe("09:30 [工作] 群主发言了", "工作", FALLBACK_TS).length).toBe(1);
    expect(pe("09:30 [RP] Rana 陪着主人", "RP", FALLBACK_TS).length).toBe(1);
  });

  it("群聊侧人名不限，但必须含中文", () => {
    expect(pe("09:30 [群聊] 群友聊了新番", "群聊", FALLBACK_TS).length).toBe(1);
    expect(pe("hello world 123", "群聊", FALLBACK_TS)).toEqual([]);
    expect(pe("今天hello", "群聊", FALLBACK_TS).length).toBe(1);
  });
});

describe("刘南/刘娜 → Rana 归位", () => {
  it("7B 残留错误自称入库前替换", () => {
    const r = pe("09:30 [RP] 刘南陪主人散步了很久", "RP", FALLBACK_TS);
    expect(r[0].line).toBe("09:30 [RP] Rana陪主人散步了很久");
    expect(r[0].line).not.toContain("刘南");
    const r2 = pe("09:30 [RP] 刘娜给主人倒了杯水", "RP", FALLBACK_TS);
    expect(r2[0].line).toContain("Rana给主人倒了杯水");
  });
});

describe("时间解析与 [tag] 前缀", () => {
  it("行首 HH:MM + [ 捕获为时间；已含 [tag] 不加前缀", () => {
    const r = pe("09:30 [工作] 主人完成了备份链路修复", "工作", FALLBACK_TS);
    expect(r).toEqual([{ time: "09:30", line: "09:30 [工作] 主人完成了备份链路修复" }]);
  });

  it("无行首时间 → 回退 fallbackTs 的 toTimeString 口径（本地时区）", () => {
    const r = pe("主人和Rana一起看了电影", "工作", FALLBACK_TS);
    expect(r).toEqual([{ time: "14:05", line: "14:05 [工作] 主人和Rana一起看了电影" }]);
  });

  it("有行首时间但没跟 [ → 时间不被捕获，照样回退并剥掉原时间头", () => {
    const r = pe("15:20 主人修好了网关", "工作", FALLBACK_TS);
    expect(r).toEqual([{ time: "14:05", line: "14:05 [工作] 主人修好了网关" }]);
  });
});

describe("三个怪口径（生产行为，按现状钉死）", () => {
  it("格式化后长度 ≤15 整条丢弃；16 通过", () => {
    // '14:05 [工作] 主人好' = 14 字符 → 丢
    expect(pe("主人好", "工作", FALLBACK_TS)).toEqual([]);
    // '14:05 [工作] 主人你好吗' = 16 字符 → 收
    const r = pe("主人你好吗", "工作", FALLBACK_TS);
    expect(r).toEqual([{ time: "14:05", line: "14:05 [工作] 主人你好吗" }]);
  });

  it("单行超长按 slice(0,120) 截断", () => {
    const r = pe("09:30 [RP] 主人" + "很".repeat(130), "RP", FALLBACK_TS);
    expect(r.length).toBe(1);
    expect(r[0].time).toBe("09:30");
    expect(r[0].line.length).toBe(120);
  });

  it("一次最多 3 条（slice(0,3) 封顶，保序）", () => {
    const raw = [1, 2, 3, 4, 5]
      .map((i) => `0${i}:00 [工作] 主人完成了任务第${i}号`)
      .join("\n");
    const r = pe(raw, "工作", FALLBACK_TS);
    expect(r.length).toBe(3);
    expect(r.map((e) => e.time)).toEqual(["01:00", "02:00", "03:00"]);
    expect(r[0].line).toContain("任务第1号");
    expect(r[2].line).toContain("任务第3号");
  });
});
