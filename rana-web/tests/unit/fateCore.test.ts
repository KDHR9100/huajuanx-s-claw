// src/lib/fateCore.ts 的黄金值测试。
//
// 黄金值纪律（任务书批次 A 要求）：
// 1. 期望值不拍脑袋：一类是「人工万年历锚点」——3 个中性公开日期，干支/农历用公开万年历
//    独立核对后硬编码；另一类是「原始库交叉对照」——直接调 lunar-javascript 原始 API
//    （Solar/Lunar/LunarUtil），断言 fateCore 的封装与历法库逐字段一致。
// 2. 本项目 64 卦表有「系统性颠倒」前科：readHexagram 用例全部按传世经典独立推导
//    （乾111111/坤000000/屯=坎上震下/乾初爻动变姤），钉住「初爻在前」的 bin 约定。
// 3. 钉住的是「与历法库/经典一致」，不是「与现状一致」。若这些用例挂了，先查 fateCore。
import { describe, it, expect } from "vitest";
import { Solar, LunarUtil } from "lunar-javascript";
import {
  gzPillarInfo,
  dayAlmanac,
  lunarCellLabel,
  monthCells,
  stage12,
  ganShiShen,
  hourToTimeIndex,
  sanFangSiZheng,
  yearGanZhi,
  readHexagram,
  type CastLine,
} from "../../src/lib/fateCore";

// ---------- 人工万年历锚点（中性公开日期，独立核对后硬编码） ----------

describe("dayAlmanac 人工锚点", () => {
  it("2000-01-01：己卯年丙子月戊午日，冬月廿五（千禧年元旦，星期六）", () => {
    const a = dayAlmanac(2000, 1, 1);
    expect(a.yearGZ).toBe("己卯"); // 未过春节（2000-02-05），年柱仍属己卯
    expect(a.monthGZ).toBe("丙子"); // 大雪后、小寒前为子月；己年五虎遁起丙寅
    expect(a.dayGZ).toBe("戊午"); // 人工核对锚点
    expect(a.lunarText).toBe("一九九九年冬月廿五");
    expect(a.shengXiao).toBe("兔");
    expect(a.naYin).toBe("城头土"); // 戊寅己卯城头土
    expect(a.week).toBe("星期六");
    expect(a.festivals).toContain("元旦节");
  });

  it("1984-02-02：甲子年正月初一（春节当日），丙寅日，立春前", () => {
    const a = dayAlmanac(1984, 2, 2);
    // 年柱口径：fateCore 走 lunar-javascript getYearInGanZhi()= 农历年（正月初一）边界，
    // 当日恰为春节 → 甲子；若按立春口径（1984-02-04）则为癸亥，属口径差异不是错误。
    expect(a.yearGZ).toBe("甲子");
    expect(a.monthGZ).toBe("乙丑"); // 立春前属丑月
    expect(a.dayGZ).toBe("丙寅"); // 人工核对锚点（两条独立推算路径一致）
    expect(a.lunarText).toBe("一九八四年正月初一");
    expect(a.shengXiao).toBe("鼠");
    expect(a.naYin).toBe("海中金"); // 甲子乙丑海中金
    expect(a.festivals).toContain("春节");
  });

  it("1949-10-01：己丑年癸酉月甲子日，八月初十（该年闰七月，故十月一日在八月）", () => {
    const a = dayAlmanac(1949, 10, 1);
    expect(a.yearGZ).toBe("己丑");
    expect(a.monthGZ).toBe("癸酉"); // 寒露（10-08/09）前为酉月；己年五虎遁酉月=癸酉
    expect(a.dayGZ).toBe("甲子"); // 公开万年历广为记载的锚点
    expect(a.lunarText).toBe("一九四九年八月初十");
    expect(a.festivals).toContain("国庆节");
  });
});

// ---------- 原始 lunar-javascript API 交叉对照（验证封装不失真） ----------

const CROSS_DATES: Array<[number, number, number]> = [
  [2000, 1, 1],
  [1984, 2, 2],
  [1949, 10, 1],
  [2023, 3, 22], // 闰二月初一
  [2000, 2, 3], // 立春前一日
  [2000, 2, 4], // 立春当日
  [2000, 2, 5], // 春节（立春后一日）
  [2026, 12, 31], // 跨年前夕
  [2027, 1, 1], // 跨年（未过春节，年柱仍丙午）
];

describe("dayAlmanac 与原始历法库逐字段一致", () => {
  const WEEKS = ["日", "一", "二", "三", "四", "五", "六"];
  for (const [y, m, d] of CROSS_DATES) {
    it(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, () => {
      const a = dayAlmanac(y, m, d);
      const solar = Solar.fromYmd(y, m, d);
      const lunar = solar.getLunar();
      expect(a.yearGZ).toBe(String(lunar.getYearInGanZhi()));
      expect(a.monthGZ).toBe(String(lunar.getMonthInGanZhi()));
      expect(a.dayGZ).toBe(String(lunar.getDayInGanZhi()));
      expect(a.isLeap).toBe(lunar.getMonth() < 0);
      expect(a.lunarMonth).toBe(lunar.getMonthInChinese());
      expect(a.lunarDay).toBe(String(lunar.getDayInChinese()));
      expect(a.lunarText).toBe(
        `${lunar.getYearInChinese()}年${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`
      );
      expect(a.shengXiao).toBe(String(lunar.getYearShengXiao()));
      expect(a.naYin).toBe(String(lunar.getYearNaYin()));
      expect(a.jieQi).toBe(String(lunar.getJieQi() ?? ""));
      expect(a.week).toBe(`星期${WEEKS[solar.getWeek()]}`);
      expect(a.yi).toEqual((lunar.getDayYi() as string[]).slice(0, 8));
      expect(a.ji).toEqual((lunar.getDayJi() as string[]).slice(0, 8));
      expect(a.festivals).toEqual([
        ...(lunar.getFestivals() as string[]),
        ...(solar.getFestivals() as string[]),
      ]);
      // 时辰列表与原始库同长同序
      const times = lunar.getTimes() as any[];
      expect(a.hours.length).toBe(times.length);
      expect(a.hours[0].zhi).toBe(String(times[0].getZhi()));
      expect(a.hours[0].hm).toBe(`${times[0].getMinHm()}-${times[0].getMaxHm()}`);
    });
  }
});

// ---------- 节气边界 ----------

describe("节气边界", () => {
  it("2000-02-04 立春当日：jieQi 报节气，月柱已进寅月", () => {
    expect(dayAlmanac(2000, 2, 4).jieQi).toBe("立春");
    expect(dayAlmanac(2000, 2, 4).monthGZ).toBe("戊寅");
  });

  it("月柱在立春处切换：前一日丁丑 → 当日戊寅", () => {
    expect(dayAlmanac(2000, 2, 3).monthGZ).toBe("丁丑");
    expect(dayAlmanac(2000, 2, 3).jieQi).toBe("");
  });

  it("lunarCellLabel 节气日优先显示节气名", () => {
    const c = lunarCellLabel(2000, 2, 4);
    expect(c.label).toBe("立春");
    expect(c.isJieQi).toBe(true);
  });
});

// ---------- 闰月 ----------

describe("闰月", () => {
  it("2023-03-22 闰二月初一：isLeap/lunarMonth/lunarText 全带闰", () => {
    const a = dayAlmanac(2023, 3, 22);
    expect(a.isLeap).toBe(true);
    expect(a.lunarMonth).toBe("闰二");
    expect(a.lunarText).toBe("二〇二三年闰二月初一");
  });

  it("lunarCellLabel 闰月朔日显示「闰X月」", () => {
    expect(lunarCellLabel(2023, 3, 22).label).toBe("闰二月");
  });

  it("非闰月对照：次日仍属二月（isLeap=false）", () => {
    expect(dayAlmanac(2023, 3, 21).isLeap).toBe(false);
    expect(dayAlmanac(2023, 3, 21).lunarMonth).toBe("二");
  });
});

// ---------- lunarCellLabel 其余分支 ----------

describe("lunarCellLabel", () => {
  it("普通日显示农历日", () => {
    // 2000-01-01=冬月廿五 → 次日为廿六
    expect(lunarCellLabel(2000, 1, 2).label).toBe("廿六");
  });

  it("朔日（初一）显示月名", () => {
    // 2000-02-05 = 庚辰年正月初一
    expect(lunarCellLabel(2000, 2, 5).label).toBe("正月");
  });
});

// ---------- monthCells 月末跨年 ----------

describe("monthCells（周一开头 42 格）", () => {
  it("2026-12：头部借 11 月、尾部跨入 2027-01", () => {
    const cells = monthCells(2026, 12);
    expect(cells.length).toBe(42);
    // 2026-12-01 是星期二 → 首格为 11-30（周一）
    expect(cells[0]).toEqual({ y: 2026, m: 11, d: 30, inMonth: false });
    expect(cells[1]).toEqual({ y: 2026, m: 12, d: 1, inMonth: true });
    // 11-30 + 41 天 = 2027-01-10
    expect(cells[41]).toEqual({ y: 2027, m: 1, d: 10, inMonth: false });
    expect(cells.filter((c) => c.inMonth).length).toBe(31);
    // 周一开头
    expect(new Date(cells[0].y, cells[0].m - 1, cells[0].d).getDay()).toBe(1);
  });

  it("2027-01：头部借 2026-12、尾部跨入 2 月", () => {
    const cells = monthCells(2027, 1);
    expect(cells.length).toBe(42);
    // 2027-01-01 是星期五 → 首格为 2026-12-28（周一）
    expect(cells[0]).toEqual({ y: 2026, m: 12, d: 28, inMonth: false });
    expect(cells[4]).toEqual({ y: 2027, m: 1, d: 1, inMonth: true });
    expect(cells[41]).toEqual({ y: 2027, m: 2, d: 7, inMonth: false });
    expect(cells.filter((c) => c.inMonth).length).toBe(31);
  });
});

// ---------- gzPillarInfo ----------

describe("gzPillarInfo", () => {
  it("甲子柱（日主甲）：比肩/藏干癸/沐浴/旬空戌亥/旬首甲子/纳音海中金", () => {
    const p = gzPillarInfo("甲子", "甲");
    expect(p.shiShenGan).toBe("比肩");
    expect(p.hideGan).toEqual(["癸"]);
    expect(p.hideShiShen).toEqual(["正印"]);
    expect(p.xingYun).toBe("沐浴"); // 甲长生在亥，子为沐浴
    expect(p.ziZuo).toBe("沐浴");
    expect(p.xunKong).toBe("戌亥"); // 甲子旬空戌亥（经典）
    expect(p.xunShou).toBe("甲子");
    expect(p.naYin).toBe("海中金");
  });

  it("戊午柱：纳音天上火、甲寅旬、旬空子丑", () => {
    const p = gzPillarInfo("戊午", "丙");
    expect(p.naYin).toBe("天上火"); // 戊午己未天上火
    expect(p.xunShou).toBe("甲寅");
    expect(p.xunKong).toBe("子丑"); // 甲寅旬空子丑（经典）
    expect(p.shiShenGan).toBe("食神"); // 丙生戊，同阳
  });

  it("非法干支组合（甲丑）：索引类字段置空、藏干仍按支取", () => {
    const p = gzPillarInfo("甲丑", "甲");
    expect(p.naYin).toBe("");
    expect(p.xunKong).toBe("");
    expect(p.xunShou).toBe("");
    expect(p.hideGan).toEqual((LunarUtil.ZHI_HIDE_GAN as Record<string, string[]>)["丑"]);
  });

  it("十二支藏干与 LunarUtil 原始表逐支一致", () => {
    const pairs = ["甲子", "乙丑", "丙寅", "丁卯", "戊辰", "己巳", "庚午", "辛未", "壬申", "癸酉", "甲戌", "乙亥"];
    const table = LunarUtil.ZHI_HIDE_GAN as Record<string, string[]>;
    for (const gz of pairs) {
      expect(gzPillarInfo(gz, "甲").hideGan, gz).toEqual(table[gz[1]]);
    }
  });
});

// ---------- 十二长生 / 十神（经典口诀钉桩） ----------

describe("stage12 / ganShiShen", () => {
  it("阳干顺行：甲亥长生、甲子沐浴、甲卯帝旺；丙寅长生", () => {
    expect(stage12("甲", "亥")).toBe("长生");
    expect(stage12("甲", "子")).toBe("沐浴");
    expect(stage12("甲", "卯")).toBe("帝旺");
    expect(stage12("丙", "寅")).toBe("长生");
  });

  it("阴干逆行：乙午长生、癸卯长生、辛子长生", () => {
    expect(stage12("乙", "午")).toBe("长生");
    expect(stage12("癸", "卯")).toBe("长生");
    expect(stage12("辛", "子")).toBe("长生");
  });

  it("日主甲的十神全覆盖", () => {
    const expectMap: Record<string, string> = {
      甲: "比肩", 乙: "劫财", 丙: "食神", 丁: "伤官", 戊: "偏财",
      己: "正财", 庚: "七杀", 辛: "正官", 壬: "偏印", 癸: "正印",
    };
    for (const [gan, ss] of Object.entries(expectMap)) {
      expect(ganShiShen("甲", gan), gan).toBe(ss);
    }
  });
});

// ---------- 小工具 ----------

describe("hourToTimeIndex / sanFangSiZheng / yearGanZhi", () => {
  it("小时 → 时辰序号（0 早子时 … 12 晚子时）", () => {
    expect(hourToTimeIndex(0)).toBe(0);
    expect(hourToTimeIndex(1)).toBe(1);
    expect(hourToTimeIndex(2)).toBe(1);
    expect(hourToTimeIndex(11)).toBe(6);
    expect(hourToTimeIndex(12)).toBe(6);
    expect(hourToTimeIndex(13)).toBe(7);
    expect(hourToTimeIndex(22)).toBe(11);
    expect(hourToTimeIndex(23)).toBe(12);
  });

  it("三方四正：子→对宫午、三合申辰；午→对宫子、三合寅戌", () => {
    expect(sanFangSiZheng("子")).toEqual({ dui: "午", san1: "辰", san2: "申" });
    expect(sanFangSiZheng("午")).toEqual({ dui: "子", san1: "戌", san2: "寅" });
  });

  it("流年干支（年中取样避开立春边界）", () => {
    expect(yearGanZhi(1984)).toBe("甲子");
    expect(yearGanZhi(2000)).toBe("庚辰");
    expect(yearGanZhi(1900)).toBe("庚子");
  });
});

// ---------- 64 卦表（历史上有过系统性颠倒，用传世经典独立钉桩） ----------

const line = (yao: CastLine["yao"]): CastLine => ({ coins: [false, false, false], yao });

describe("readHexagram", () => {
  it("六爻皆老阳：本卦乾为天，变卦坤为地，六爻全动", () => {
    const r = readHexagram(Array.from({ length: 6 }, () => line("老阳")))!;
    expect(r.ben.n).toBe(1);
    expect(r.ben.name).toBe("乾为天");
    expect(r.ben.bin).toBe("111111");
    expect(r.ben.sym).toBe("\u4DC0"); // U+4DC0 = ䷀（Unicode 标准乾卦符）
    expect(r.bian?.n).toBe(2);
    expect(r.bian?.name).toBe("坤为地");
    expect(r.moving).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("六爻皆少阳：本卦乾、无变卦、无动爻", () => {
    const r = readHexagram(Array.from({ length: 6 }, () => line("少阳")))!;
    expect(r.ben.n).toBe(1);
    expect(r.bian).toBeNull();
    expect(r.moving).toEqual([]);
  });

  it("水雷屯（坎上震下，初爻在前 → 100010）", () => {
    // 自下而上：震(1,0,0) + 坎(0,1,0)
    const lines = ["少阳", "少阴", "少阴", "少阴", "少阳", "少阴"].map((y) => line(y as CastLine["yao"]));
    const r = readHexagram(lines)!;
    expect(r.ben.n).toBe(3);
    expect(r.ben.name).toBe("水雷屯");
    expect(r.ben.bin).toBe("100010");
  });

  it("乾初爻动变天风姤（经典：乾初九变姤）", () => {
    const lines = [line("老阳"), ...Array.from({ length: 5 }, () => line("少阳"))];
    const r = readHexagram(lines)!;
    expect(r.ben.n).toBe(1);
    expect(r.bian?.n).toBe(44);
    expect(r.bian?.name).toBe("天风姤");
    expect(r.bian?.bin).toBe("011111");
    expect(r.moving).toEqual([1]);
  });

  it("爻数不足 6 → null", () => {
    expect(readHexagram([line("少阳")])).toBeNull();
  });
});
