// 玄学核心计算层：万年历/八字（lunar-javascript）、紫微斗数（iztro）、六爻铜钱摇卦。
// 全部在浏览器本地计算，不联网；个人档案只在问卦时由中间件附加发给云端（用户已知情拍板）。
import { Solar, LunarUtil } from "lunar-javascript";
import { astro } from "iztro";
import hexagrams from "./hexagrams.json";

/** 任意干支的完整柱信息（流年列/大运列复用四柱同款口径） */
const GANS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const ZHIS = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
/** 六十甲子纳音（每柱一行的两柱一组） */
const NA_YIN = [
  "海中金", "炉中火", "大林木", "路旁土", "剑锋金",
  "山头火", "涧下水", "城头土", "白蜡金", "杨柳木",
  "泉中水", "屋上土", "霹雳火", "松柏木", "长流水",
  "沙中金", "山下火", "平地木", "壁上土", "金箔金",
  "覆灯火", "天河水", "大驿土", "钗钏金", "桑柘木",
  "大溪水", "沙中土", "天上火", "石榴木", "大海水",
];

/** 干支在六十甲子中的序号（0=甲子） */
function gzIndex60(gz: string): number {
  const g = GANS.indexOf(gz[0]);
  const z = ZHIS.indexOf(gz[1]);
  if (g < 0 || z < 0) return -1;
  for (let k = 0; k < 6; k++) {
    const n = g + 10 * k;
    if (n % 12 === z) return n;
  }
  return -1;
}

export interface GzPillarInfo {
  shiShenGan: string;
  hideGan: string[];
  hideShiShen: string[];
  xingYun: string;
  ziZuo: string;
  xunKong: string;
  xunShou: string;
  naYin: string;
}

/** 从干支算全套柱信息：藏干（LunarUtil 同口径）、十神、星运/自坐、空亡、旬首、纳音 */
export function gzPillarInfo(gz: string, dayMaster: string): GzPillarInfo {
  const gan = gz[0];
  const zhi = gz[1];
  const hideGan: string[] = (LunarUtil.ZHI_HIDE_GAN as Record<string, string[]>)[zhi] ?? [];
  const n = gzIndex60(gz);
  const xunStart = n >= 0 ? n - (n % 10) : -1;
  const xunKong = xunStart >= 0 ? ZHIS[(xunStart + 10) % 12] + ZHIS[(xunStart + 11) % 12] : "";
  const xunShou = xunStart >= 0 ? `甲${ZHIS[xunStart % 12]}` : "";
  const naYin = n >= 0 ? NA_YIN[Math.floor(n / 2)] : "";
  return {
    shiShenGan: ganShiShen(dayMaster, gan),
    hideGan,
    hideShiShen: hideGan.map((hg) => ganShiShen(dayMaster, hg)),
    xingYun: stage12(dayMaster, zhi),
    ziZuo: stage12(gan, zhi),
    xunKong,
    xunShou,
    naYin,
  };
}

export interface HexInfo {
  n: number;
  bin: string;
  name: string;
  gong: string;
  ci: string;
  /** 易经卦符（U+4DC0 起按文王序号） */
  sym: string;
}

export interface HourLuck {
  zhi: string;
  hm: string;
  ganZhi: string;
  tianShen: string;
  luck: string;
}

export interface DayAlmanac {
  ymd: string;
  week: string;
  lunarText: string; // 如 二〇二六年八月初二
  lunarMonth: string;
  lunarDay: string;
  isLeap: boolean;
  yearGZ: string;
  monthGZ: string;
  dayGZ: string;
  shengXiao: string;
  naYin: string;
  yi: string[];
  ji: string[];
  jieQi: string;
  festivals: string[];
  hours: HourLuck[];
}

const WEEKS = ["日", "一", "二", "三", "四", "五", "六"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/** 阳历某天的万年历全套（农历/干支/宜忌/时辰吉凶），本地计算 */
export function dayAlmanac(y: number, m: number, d: number): DayAlmanac {
  const solar = Solar.fromYmd(y, m, d);
  const lunar = solar.getLunar();
  const times: HourLuck[] = (lunar.getTimes() as any[]).map((t) => ({
    zhi: String(t.getZhi() ?? ""),
    hm: `${t.getMinHm()}-${t.getMaxHm()}`,
    ganZhi: String(t.getGanZhi?.() ?? t.getTimeGanZhi?.() ?? ""),
    tianShen: String(t.getTianShen() ?? ""),
    luck: String(t.getTianShenLuck() ?? ""),
  }));
  return {
    ymd: `${y}-${pad2(m)}-${pad2(d)}`,
    week: `星期${WEEKS[solar.getWeek()]}`,
    lunarText: `${lunar.getYearInChinese()}年${lunar.getMonth() < 0 ? "闰" : ""}${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
    lunarMonth: `${lunar.getMonth() < 0 ? "闰" : ""}${lunar.getMonthInChinese()}`,
    lunarDay: lunar.getDayInChinese(),
    isLeap: lunar.getMonth() < 0,
    yearGZ: lunar.getYearInGanZhi(),
    monthGZ: lunar.getMonthInGanZhi(),
    dayGZ: lunar.getDayInGanZhi(),
    shengXiao: lunar.getYearShengXiao(),
    naYin: lunar.getYearNaYin(),
    yi: (lunar.getDayYi() as string[]).slice(0, 8),
    ji: (lunar.getDayJi() as string[]).slice(0, 8),
    jieQi: String(lunar.getJieQi() ?? ""),
    festivals: [...(lunar.getFestivals() as string[]), ...(solar.getFestivals() as string[])],
    hours: times,
  };
}

/** 月历格子的农历小字：节气日优先显示节气名，否则显示农历日（初一显示月名） */
export function lunarCellLabel(y: number, m: number, d: number): { label: string; isJieQi: boolean; isToday: boolean } {
  const lunar = Solar.fromYmd(y, m, d).getLunar();
  const jq = lunar.getJieQi();
  const today = new Date();
  const isToday = today.getFullYear() === y && today.getMonth() + 1 === m && today.getDate() === d;
  if (jq) return { label: jq, isJieQi: true, isToday };
  if (lunar.getDay() === 1) return { label: (lunar.getMonth() < 0 ? "闰" : "") + lunar.getMonthInChinese() + "月", isJieQi: false, isToday };
  return { label: lunar.getDayInChinese(), isJieQi: false, isToday };
}

/** 月历矩阵：周一开头 42 格（复用学习计划页的口径） */
export function monthCells(y: number, m: number): Array<{ y: number; m: number; d: number; inMonth: boolean }> {
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const cells: Array<{ y: number; m: number; d: number; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(y, m - 1, 1 - lead + i);
    cells.push({ y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate(), inMonth: dt.getMonth() + 1 === m });
  }
  return cells;
}

// ---------- 八字 ----------

const GAN_WX: Record<string, string> = { 甲: "木", 乙: "木", 丙: "火", 丁: "火", 戊: "土", 己: "土", 庚: "金", 辛: "金", 壬: "水", 癸: "水" };
const ZHI_WX: Record<string, string> = { 寅: "木", 卯: "木", 巳: "火", 午: "火", 申: "金", 酉: "金", 亥: "水", 子: "水", 辰: "土", 戌: "土", 丑: "土", 未: "土" };
export { GAN_WX, ZHI_WX };
/** 地支在十二宫的序号（子0 … 亥11） */
export const ZHI_IDX: Record<string, number> = { 子: 0, 丑: 1, 寅: 2, 卯: 3, 辰: 4, 巳: 5, 午: 6, 未: 7, 申: 8, 酉: 9, 戌: 10, 亥: 11 };

// ---------- 十二长生 / 十神（lunar 没有现成 API，自算；已对照专业排盘软件逐项验证） ----------
const STAGES12 = ["长生", "沐浴", "冠带", "临官", "帝旺", "衰", "病", "死", "墓", "绝", "胎", "养"];
/** 各天干的长生位（阳干顺行、阴干逆行）：甲亥 丙戊寅 庚巳 壬申 / 乙午 丁己酉 辛子 癸卯 */
const CS_START: Record<string, number> = { 甲: 11, 丙: 2, 戊: 2, 庚: 5, 壬: 8, 乙: 6, 丁: 9, 己: 9, 辛: 0, 癸: 3 };
const YANG_GAN = new Set(["甲", "丙", "戊", "庚", "壬"]);
const GEN_MAP: Record<string, string> = { 木: "火", 火: "土", 土: "金", 金: "水", 水: "木" }; // A生GEN_MAP[A]
const KE_MAP: Record<string, string> = { 木: "土", 土: "水", 水: "火", 火: "金", 金: "木" }; // A克KE_MAP[A]

/** 十二长生：天干 gan 落在地支 zhi 的旺衰阶段（星运=日主对四支，自坐=柱干对本支） */
export function stage12(gan: string, zhi: string): string {
  const s = CS_START[gan] ?? 0;
  const z = ZHI_IDX[zhi] ?? 0;
  const d = YANG_GAN.has(gan) ? (z - s + 12) % 12 : (s - z + 12) % 12;
  return STAGES12[d];
}

/** 干对干的十神（相对日主）：五行生克 + 同性/异性定正偏 */
export function ganShiShen(dayGan: string, gan: string): string {
  const dw = GAN_WX[dayGan];
  const ow = GAN_WX[gan];
  const same = YANG_GAN.has(dayGan) === YANG_GAN.has(gan);
  if (dw === ow) return same ? "比肩" : "劫财";
  if (GEN_MAP[ow] === dw) return same ? "偏印" : "正印"; // 生我者为印
  if (GEN_MAP[dw] === ow) return same ? "食神" : "伤官"; // 我生者为食伤
  if (KE_MAP[dw] === ow) return same ? "偏财" : "正财"; // 我克者为财
  return same ? "七杀" : "正官"; // 克我者为官杀
}

export interface BaziPillar {
  label: string;
  gz: string;
  naYin: string;
  /** 天干十神（日柱为「日主」） */
  shiShenGan: string;
  /** 地支藏干 */
  hideGan: string[];
  /** 藏干各自十神 */
  hideShiShen: string[];
  /** 星运：日主在此柱地支的十二长生 */
  xingYun: string;
  /** 自坐：此柱天干对自己地支的十二长生 */
  ziZuo: string;
  /** 空亡（旬空） */
  xunKong: string;
  /** 旬首 */
  xunShou: string;
}

export interface DaYunItem {
  startYear: number;
  endYear: number;
  startAge: number;
  endAge: number;
  gz: string;
  shiShen: string;
  /** 当前年份落在这步大运里 */
  current: boolean;
}

export interface BaziResult {
  pillars: BaziPillar[];
  hasTime: boolean;
  wuxing: Array<{ name: string; count: number }>;
  dayMaster: string;
  dayMasterWx: string;
  yunStart: string;
  taiYuan: string;
  mingGong: string;
  shenGong: string;
  daYun: DaYunItem[];
  /** 今年流年 */
  liuNian: { year: number; gz: string; shiShen: string };
}

/** 八字 + 五行分布 + 大运（gender：1 男 0 女，大运用）；hour 为空则三柱 */
export function bazi(y: number, m: number, d: number, hour: number | null, gender: 1 | 0): BaziResult {
  const solar = hour === null ? Solar.fromYmd(y, m, d) : Solar.fromYmdHms(y, m, d, hour, 0, 0);
  const ec = solar.getLunar().getEightChar();
  const g = (fn: string, ...args: unknown[]) => {
    try {
      const v = (ec as any)[fn](...args);
      return v === null || v === undefined ? "" : v;
    } catch {
      return "";
    }
  };
  const dayGz = String(ec.getDay());
  const dayMaster = dayGz[0];
  const pillarDefs: Array<[string, string]> = [
    ["年柱", "Year"],
    ["月柱", "Month"],
    ["日柱", "Day"],
    ["时柱", "Time"],
  ];
  const entries: BaziPillar[] = [];
  const counts: Record<string, number> = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  for (const [label, key] of pillarDefs) {
    const gz = String(g(`get${key}`) ?? "");
    if (!gz) continue;
    const gan = gz[0];
    const zhi = gz[1];
    const hideGan = ((g(`get${key}HideGan`) as unknown as string[]) ?? []).map(String);
    for (const ch of gz) {
      if (GAN_WX[ch]) counts[GAN_WX[ch]]++;
      else if (ZHI_WX[ch]) counts[ZHI_WX[ch]]++;
    }
    entries.push({
      label,
      gz,
      naYin: String(g(`get${key}NaYin`)),
      // 十神统一用自算口径（相对日主），lunar 自带的 getXShiShenGan/Zhi 口径对不上专业排盘
      shiShenGan: key === "Day" ? "日主" : ganShiShen(dayMaster, gan),
      hideGan,
      hideShiShen: hideGan.map((hg) => ganShiShen(dayMaster, hg)),
      xingYun: stage12(dayMaster, zhi),
      ziZuo: stage12(gan, zhi),
      xunKong: String(g(`get${key}XunKong`)),
      xunShou: String(g(`get${key}Xun`)),
    });
  }
  const hasTime = entries.length === 4;

  const now = new Date();
  const thisYear = now.getFullYear();
  const yun = ec.getYun(gender);
  const daYun: DaYunItem[] = (yun.getDaYun() as any[])
    .map((dy) => {
      const gz = String(dy.getGanZhi() ?? "");
      const startYear = Number(dy.getStartYear());
      const endYear = Number(dy.getEndYear());
      return {
        startYear,
        endYear,
        startAge: Number(dy.getStartAge()),
        endAge: Number(dy.getEndAge()),
        gz,
        shiShen: gz && gz[0] ? ganShiShen(dayMaster, gz[0]) : "",
        current: Boolean(gz) && thisYear >= startYear && thisYear <= endYear,
      };
    })
    .filter((x) => x.gz);
  const lnGz = String(Solar.fromDate(now).getLunar().getYearInGanZhi());

  return {
    pillars: entries,
    hasTime,
    wuxing: (["木", "火", "土", "金", "水"] as const).map((name) => ({ name, count: counts[name] })),
    dayMaster,
    dayMasterWx: GAN_WX[dayMaster] ?? "?",
    yunStart: `${yun.getStartYear()}年${yun.getStartMonth()}个月${yun.getStartDay()}天`,
    taiYuan: String(g("getTaiYuan")),
    mingGong: String(g("getMingGong")),
    shenGong: String(g("getShenGong")),
    daYun,
    liuNian: { year: thisYear, gz: lnGz, shiShen: ganShiShen(dayMaster, lnGz[0]) },
  };
}

// ---------- 紫微斗数 ----------

export interface ZwPalace {
  name: string;
  gan: string;
  zhi: string;
  majors: string;
  minors: string;
  /** 主星列表（拆开的，配悬停注释用） */
  majorList: Array<{ name: string; mutagen?: string }>;
  minorList: string[];
  decadal: string;
  isSoul: boolean;
  isBody: boolean;
  row: number;
  col: number;
}

export interface ZiweiResult {
  palaces: ZwPalace[];
  soulZhi: string;
  bodyZhi: string;
  fiveElements: string;
  zodiac: string;
  sign: string;
  lunarDate: string;
  chineseDate: string;
  /** 今天的大限/流年盘（运限四化飞星、流曜、命宫落宫） */
  yun: { decadal: YunScope | null; yearly: YunScope | null };
}

/** 紫微命盘：经典 4×4 布局（巳午未申/辰…酉/卯…戌/寅丑子亥，中间 2×2 放命主信息） */
const ZHI_POS: Record<string, { row: number; col: number }> = {
  巳: { row: 0, col: 0 }, 午: { row: 0, col: 1 }, 未: { row: 0, col: 2 }, 申: { row: 0, col: 3 },
  辰: { row: 1, col: 0 }, 酉: { row: 1, col: 3 },
  卯: { row: 2, col: 0 }, 戌: { row: 2, col: 3 },
  寅: { row: 3, col: 0 }, 丑: { row: 3, col: 1 }, 子: { row: 3, col: 2 }, 亥: { row: 3, col: 3 },
};

/** 小时 → iztro 时辰序号（0 早子时 … 12 晚子时） */
export function hourToTimeIndex(hour: number): number {
  if (hour >= 23) return 12;
  if (hour < 1) return 0;
  return Math.floor((hour + 1) / 2);
}

/** 三方四正：某宫的对宫（+6）与两个三合宫（+4/+8），连线/三角用 */
export function sanFangSiZheng(zhi: string): { dui: string; san1: string; san2: string } {
  const i = ZHI_IDX[zhi] ?? 0;
  const at = (d: number) => Object.keys(ZHI_IDX).find((k) => ZHI_IDX[k] === ((i + d) % 12 + 12) % 12)!;
  return { dui: at(6), san1: at(4), san2: at(8) };
}

/** 某公历年的流年干支（年中取样避开立春边界） */
export function yearGanZhi(y: number): string {
  return String(Solar.fromYmd(y, 6, 30).getLunar().getYearInGanZhi());
}

/** 一段年份区间内每年的流年：干支 + 十神（年中取样避开立春边界）+ 是否今年 */
export function liuNianOfRange(startYear: number, endYear: number, dayMaster: string): Array<{ year: number; gz: string; shiShen: string; now: boolean }> {
  const thisYear = new Date().getFullYear();
  const out: Array<{ year: number; gz: string; shiShen: string; now: boolean }> = [];
  for (let y = startYear; y <= endYear && out.length < 12; y++) {
    const gz = String(Solar.fromYmd(y, 6, 30).getLunar().getYearInGanZhi());
    out.push({ year: y, gz, shiShen: ganShiShen(dayMaster, gz[0]), now: y === thisYear });
  }
  return out;
}

/** 大运/流年盘的运限数据（取某天的 horoscope） */
export interface YunScope {
  kind: "decadal" | "yearly";
  label: string;
  /** 运限命宫落在本命哪个地支宫 */
  zhi: string;
  gz: string;
  /** 四化：禄权科忌四颗星的名字 */
  mutagen: string[];
  /** 运限四化星各自落在本命哪个宫（按地支） */
  mutagenAt: Array<{ star: string; tag: string; zhi: string }>;
  /** 每宫的流耀（运X/流X），按地支 */
  flowStars: Record<string, string[]>;
  /** 小限虚岁（decadal 时附带） */
  nominalAge?: number;
}

function yunScopeOf(h: any, palaces: ZwPalace[], kind: "decadal" | "yearly"): YunScope | null {
  const seg = h?.[kind];
  if (!seg) return null;
  const tags = ["禄", "权", "科", "忌"];
  const mutagen: string[] = (seg.mutagen ?? []).map(String);
  // 四化星落宫：找本命盘里含这颗星的宫
  const mutagenAt = mutagen.map((star, i) => {
    const p = palaces.find((x) => x.majorList.some((s) => s.name === star) || x.minorList.includes(star));
    return { star, tag: tags[i] ?? "?", zhi: p?.zhi ?? "" };
  });
  const flowStars: Record<string, string[]> = {};
  (seg.stars ?? []).forEach((arr: any[], idx: number) => {
    const zhi = palaces[idx]?.zhi;
    if (zhi && arr?.length) flowStars[zhi] = arr.map((s) => String(s.name ?? "")).filter(Boolean);
  });
  return {
    kind,
    label: kind === "decadal" ? "大限" : "流年",
    zhi: palaces[seg.index]?.zhi ?? "",
    gz: `${seg.heavenlyStem ?? ""}${seg.earthlyBranch ?? ""}`,
    mutagen,
    mutagenAt,
    flowStars,
    ...(kind === "decadal" && h?.age ? { nominalAge: Number(h.age.nominalAge) } : {}),
  };
}

export function ziwei(ymd: string, timeIndex: number, gender: "男" | "女"): ZiweiResult {
  const a = astro.astrolabeBySolarDate(ymd.replace(/-/g, "/"), timeIndex, gender) as any;
  const soulZhi = String(a.earthlyBranchOfSoulPalace ?? "");
  const bodyZhi = String(a.earthlyBranchOfBodyPalace ?? "");
  const palaces: ZwPalace[] = (a.palaces as any[]).map((p) => {
    const zhi = String(p.earthlyBranch ?? "");
    const pos = ZHI_POS[zhi] ?? { row: 0, col: 0 };
    const decadal = p.decadal?.range ? `${p.decadal.range[0]}-${p.decadal.range[1]}` : "";
    const majorList = (p.majorStars as any[]).map((s) => ({ name: String(s.name ?? ""), mutagen: s.mutagen ? String(s.mutagen) : undefined }));
    return {
      name: String(p.name ?? ""),
      gan: String(p.heavenlyStem ?? ""),
      zhi,
      majors: majorList.map((s) => `${s.name}${s.mutagen ? `[${s.mutagen}]` : ""}`).join(" ") || "空宫",
      majorList,
      minors: [
        ...(p.minorStars as any[]).map((s) => `${s.name}${s.mutagen ? `[${s.mutagen}]` : ""}`),
        ...(p.adjectiveStars ?? []).slice(0, 2).map((s: any) => s.name),
      ].join(" "),
      minorList: (p.minorStars as any[]).map((s) => String(s.name ?? "")),
      decadal,
      isSoul: zhi === soulZhi,
      isBody: Boolean(p.isBodyPalace),
      row: pos.row,
      col: pos.col,
    };
  });
  return {
    palaces,
    soulZhi,
    bodyZhi,
    fiveElements: String(a.fiveElementsClass ?? ""),
    zodiac: String(a.zodiac ?? ""),
    sign: String(a.sign ?? ""),
    lunarDate: String(a.lunarDate ?? ""),
    chineseDate: String(a.chineseDate ?? ""),
    // 今天的大限/流年盘数据（horoscope 自带四化飞星与流耀）
    yun: (() => {
      try {
        const now = new Date();
        const h = a.horoscope?.(`${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`);
        return {
          decadal: yunScopeOf(h, palaces, "decadal"),
          yearly: yunScopeOf(h, palaces, "yearly"),
        };
      } catch {
        return { decadal: null, yearly: null };
      }
    })(),
  };
}

// ---------- 六爻铜钱卦 ----------

export type YaoType = "少阳" | "少阴" | "老阳" | "老阴";

export interface CastLine {
  /** 三枚铜钱每枚是否背面（true=背） */
  coins: boolean[];
  yao: YaoType;
}

/** 摇一爻：三枚铜钱，背数 3=老阳(动) 0=老阴(动) 1=少阳 2=少阴 */
export function castLine(): CastLine {
  const coins = [0, 1, 2].map(() => {
    const buf = new Uint8Array(1);
    crypto.getRandomValues(buf);
    return buf[0] >= 128;
  });
  const backs = coins.filter(Boolean).length;
  const yao: YaoType = backs === 3 ? "老阳" : backs === 0 ? "老阴" : backs === 1 ? "少阳" : "少阴";
  return { coins, yao };
}

const HEX_MAP: Map<string, HexInfo> = new Map(
  hexagrams.map((h) => [h.bin, { ...h, sym: String.fromCodePoint(0x4dc0 + h.n - 1) }]),
);

/** 从六爻（初爻在前）解出本卦/变卦/动爻 */
export function readHexagram(lines: CastLine[]): { ben: HexInfo; bian: HexInfo | null; moving: number[] } | null {
  if (lines.length !== 6) return null;
  const isYang = (t: YaoType) => t === "少阳" || t === "老阳";
  const isMoving = (t: YaoType) => t === "老阳" || t === "老阴";
  const bin = lines.map((l) => (isYang(l.yao) ? "1" : "0")).join("");
  const ben = HEX_MAP.get(bin);
  if (!ben) return null;
  const moving = lines.map((l, i) => (isMoving(l.yao) ? i + 1 : 0)).filter(Boolean);
  if (moving.length) {
    const bianBin = lines.map((l, i) => (moving.includes(i + 1) ? (isYang(l.yao) ? "0" : "1") : isYang(l.yao) ? "1" : "0")).join("");
    const bian = HEX_MAP.get(bianBin) ?? null;
    return { ben, bian, moving };
  }
  return { ben, bian: null, moving: [] };
}

export const YAO_NAMES = ["初", "二", "三", "四", "五", "上"];
